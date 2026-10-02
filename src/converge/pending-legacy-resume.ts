import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { inspectPendingLegacyRetry, type LegacyRetrySelection } from './legacy-launch-health.js';
import { completionSchema, launchSchema, type GuardedLaunchCompletion, type GuardedLaunchState } from './launch-record.js';
import { convergeRunStatePath, loadConvergeRunState, preflightConvergeRunStateWrite,
  writeState, type ConvergeRunState } from './run-state.js';
import { claimConvergeAttempt, convergeAttemptStatePath, previewConvergeAttemptState,
  type ConvergeAttemptClaim, type ConvergeAttemptState } from './attempt-budget.js';
import { withRecoveryTarget, type NativeTargetOwnership } from './target-ownership.js';
import { bindOriginalCouncil } from '../dispatch/original-execution.js';
import { createOriginalLaunch, type OriginalLaunch } from '../dispatch/original-launch.js';
import type { CapturedPreparedCouncil } from '../dispatch/capture-council.js';
import type { CheckpointJournal } from '../dispatch/checkpoint.js';
import type { AsyncResultReference } from '../dispatch/async-lane.js';
import { uuidv7 } from '../report/uuid.js';
import { captureSupplementalAsync } from '../report/supplemental-async.js';
import { stableStringify } from '../report/run-header.js';
import { readStable } from '../telemetry/recovery/files.js';
import { serializeRecoveryDocument } from '../evidence/original-run/journal.js';
import { prepareLockRoot } from '../evidence/original-run/lock-path.js';
import { retainStaleFile } from './stale-report-storage.js';
import { createPendingRecoverySource, createOrdinaryMigrationSource, pendingRecoverySourceSchema,
  type PendingRecoverySource } from './pending-recovery-source.js';
import { validateOrdinaryPendingPackage, type OrdinaryPendingPackage } from './ordinary-pending-package.js';

export interface PendingLegacyResumeExecution {
  context: { target: string; attempt: number; round: number };
  claim: ConvergeAttemptClaim;
  ownership: NativeTargetOwnership;
  journal: CheckpointJournal;
  launch: OriginalLaunch;
  skipAsyncLaunch: true;
}

export interface PendingLegacyResumeOptions {
  gitCommonDir: string;
  target: string;
  headSha: string;
  baseSha?: string;
  pendingInputSha256: string;
  recoveryInputSha256: string;
  retryReason: string;
  legacyRetry?: LegacyRetrySelection;
  captured: CapturedPreparedCouncil;
  retainedAsyncSha256: readonly string[];
  maxAttempts: number;
  maxPhysicalCalls: number;
  maxAttemptsPerCell: number;
  maxDurationMs: number;
  validate: () => Promise<void>;
  run: (execution: PendingLegacyResumeExecution) => Promise<GuardedLaunchCompletion>;
  nowMs?: () => number;
  ownerAlive?: (pid: number) => boolean;
  loadRetainedAsync: () => Promise<AsyncResultReference[]>;
  /** Required for recovering an ordinary dead-owner launch without a legacy report. */
  migrationPackage?: OrdinaryPendingPackage;
  preview?: boolean;
  previewMode?: 'combined' | 'finalize-only';
}

export interface PendingLegacyResumeResult {
  claim: ConvergeAttemptClaim;
  completion: GuardedLaunchCompletion;
  reusedCompletion: boolean;
}

export interface OrdinaryPendingPreview {
  source: PendingRecoverySource;
  nativeStateSha256: string;
  attemptStateSha256: string;
  attemptsUsed: number;
  cap: number;
  nextAttempt: number;
}

export interface OrdinaryPendingFinalizeOptions {
  gitCommonDir: string;
  target: string;
  headSha: string;
  baseSha: string;
  pendingInputSha256: string;
  nativeStateSha256: string;
  attemptStateSha256: string;
  retainedAsyncSha256: readonly string[];
  maxAttempts: number;
  migrationPackage: OrdinaryPendingPackage;
  ownerAlive?: (pid: number) => boolean;
  loadRetainedAsync: () => Promise<AsyncResultReference[]>;
  /** Fault-injection boundary for proving archive-complete/native-write recovery. */
  writeFinalizedState?: typeof writeState;
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ordinaryPendingFinalizationReceiptBodySchema = z.object({
  version: z.literal(1),
  operation: z.literal('ordinary-pending-finalize-only'),
  target: z.string().min(1),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  inputSha256: digestSchema,
  sourceDigest: digestSchema,
  migrationPackageSha256: digestSchema,
  finalizedAttempt: z.number().int().positive().safe(),
  round: z.number().int().positive().safe(),
  originalPid: z.number().int().positive().safe(),
  attemptsUsed: z.number().int().positive().safe(),
  cap: z.number().int().positive().safe(),
  nextFreeAttempt: z.number().int().positive().safe(),
  blockingOutcome: z.literal('unknown'),
  retainedAsyncSha256: z.array(digestSchema).min(1),
  sourceNativeStateSha256: digestSchema,
  sourceAttemptStateSha256: digestSchema,
  finalizedNativeStateSha256: digestSchema,
}).strict();
const ordinaryPendingFinalizationReceiptSchema = ordinaryPendingFinalizationReceiptBodySchema.extend({
  receiptDigest: digestSchema,
}).strict().superRefine((receipt, context) => {
  const { receiptDigest, ...body } = receipt;
  if (receiptDigest !== createHash('sha256').update(stableStringify(body)).digest('hex')) {
    context.addIssue({ code: 'custom', message: 'Pending finalization receipt digest is invalid' });
  }
  if (receipt.nextFreeAttempt !== receipt.finalizedAttempt + 1 ||
      receipt.attemptsUsed !== receipt.finalizedAttempt || receipt.attemptsUsed > receipt.cap ||
      new Set(receipt.retainedAsyncSha256).size !== receipt.retainedAsyncSha256.length) {
    context.addIssue({ code: 'custom', message: 'Pending finalization accounting is inconsistent' });
  }
});

export type OrdinaryPendingFinalizationReceipt = z.infer<typeof ordinaryPendingFinalizationReceiptSchema>;
export interface OrdinaryPendingFinalizeResult {
  receipt: OrdinaryPendingFinalizationReceipt;
  reusedReceipt: boolean;
  snapshotBindingUpgraded: boolean;
}

function fail(code: string): never { throw new Error(`pending_legacy_resume_${code}`); }
function defaultOwnerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    fail('owner_unverifiable');
  }
}

function descriptor(source: PendingRecoverySource) {
  return {
    version: 1 as const, sourceDigest: source.digest, pendingAttempt: source.pendingAttempt,
    round: source.round, originalPid: source.originalPid, originalStartedAt: source.startedAt,
    blockingOutcome: 'unknown' as const,
    reason: 'coordinator_exited_without_durable_blocking_receipts' as const,
    nativeStateSha256: source.nativeStateSha256, attemptStateSha256: source.attemptStateSha256,
    retainedAsyncSha256: [...source.retainedAsyncSha256],
    ...('migrationPackageSha256' in source ? { migrationPackageSha256: source.migrationPackageSha256 } : {}),
  };
}

function sourceFromFinalized(target: string, launch: GuardedLaunchState,
  attempts: ConvergeAttemptState, migrationPackage?: OrdinaryPendingPackage): PendingRecoverySource {
  const recovery = launch.pendingRecovery;
  const claim = attempts.attempts.find(item => item.attempt === launch.attempt);
  if (!recovery || !claim || launch.attempt !== recovery.pendingAttempt ||
      launch.round !== recovery.round || launch.pid !== recovery.originalPid ||
      launch.startedAt !== recovery.originalStartedAt) fail('finalization_mismatch');
  if (recovery.migrationPackageSha256) {
    if (!migrationPackage) fail('migration_package_required');
    const migrationPackageSha256 = createHash('sha256').update(stableStringify(migrationPackage)).digest('hex');
    if (migrationPackageSha256 !== recovery.migrationPackageSha256) fail('finalization_mismatch');
    const source = createOrdinaryMigrationSource({ version: 1, target, headSha: launch.headSha,
      inputSha256: launch.inputSha256, pendingAttempt: launch.attempt, round: launch.round,
      originalPid: launch.pid, startedAt: launch.startedAt, blockingOutcome: recovery.blockingOutcome,
      reason: recovery.reason, nativeStateSha256: recovery.nativeStateSha256,
      attemptStateSha256: recovery.attemptStateSha256, retainedAsyncSha256: recovery.retainedAsyncSha256,
      migrationPackageSha256 });
    if (source.digest !== recovery.sourceDigest) fail('finalization_mismatch');
    return source;
  }
  if (!claim.retrySource) fail('finalization_mismatch');
  return pendingRecoverySourceSchema.parse({
    version: 1, target, headSha: launch.headSha, inputSha256: launch.inputSha256,
    pendingAttempt: launch.attempt, round: launch.round, originalPid: launch.pid,
    startedAt: launch.startedAt, blockingOutcome: recovery.blockingOutcome,
    reason: recovery.reason, nativeStateSha256: recovery.nativeStateSha256,
    attemptStateSha256: recovery.attemptStateSha256,
    retainedAsyncSha256: recovery.retainedAsyncSha256, retrySource: claim.retrySource,
    digest: recovery.sourceDigest,
  });
}

function validateOptions(input: PendingLegacyResumeOptions): void {
  const hashes = input?.retainedAsyncSha256;
  if (!input || typeof input.gitCommonDir !== 'string' || typeof input.target !== 'string' || !input.target.trim() ||
    !/^[a-f0-9]{40}$/.test(input.headSha ?? '') ||
    (input.migrationPackage && !/^[a-f0-9]{40}$/.test(input.baseSha ?? '')) ||
    !/^[a-f0-9]{64}$/.test(input.pendingInputSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.recoveryInputSha256 ?? '') ||
    typeof input.retryReason !== 'string' || !input.retryReason.trim() || input.retryReason.length > 500 ||
    !Array.isArray(hashes) || hashes.length === 0 || hashes.some(value => !/^[a-f0-9]{64}$/.test(value)) ||
    new Set(hashes).size !== hashes.length || typeof input.validate !== 'function' ||
    typeof input.run !== 'function' || typeof input.loadRetainedAsync !== 'function' ||
    (!input.migrationPackage && !input.legacyRetry) ||
    !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 ||
    !Number.isSafeInteger(input.maxPhysicalCalls) || input.maxPhysicalCalls < 1 ||
    !Number.isSafeInteger(input.maxAttemptsPerCell) || input.maxAttemptsPerCell < 1 ||
    !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1 || input.maxDurationMs > 2_147_483_647 ||
    (input.previewMode !== undefined && !['combined', 'finalize-only'].includes(input.previewMode))) {
    fail('invalid_input');
  }
}

function validateFinalizeOptions(input: OrdinaryPendingFinalizeOptions): void {
  const hashes = input?.retainedAsyncSha256;
  if (!input || typeof input.gitCommonDir !== 'string' || typeof input.target !== 'string' || !input.target.trim() ||
    !/^[a-f0-9]{40}$/.test(input.headSha ?? '') || !/^[a-f0-9]{40}$/.test(input.baseSha ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.pendingInputSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.nativeStateSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.attemptStateSha256 ?? '') ||
    !Array.isArray(hashes) || hashes.length === 0 || hashes.some(value => !/^[a-f0-9]{64}$/.test(value)) ||
    new Set(hashes).size !== hashes.length || typeof input.loadRetainedAsync !== 'function' ||
    (input.writeFinalizedState !== undefined && typeof input.writeFinalizedState !== 'function') ||
    !input.migrationPackage || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
    fail('invalid_input');
  }
}

async function archiveAsync(common: string, source: PendingRecoverySource,
  artifacts: readonly AsyncResultReference[], packet?: OrdinaryPendingPackage): Promise<void> {
  validateAsyncArtifacts(source, artifacts, packet);
  const directory = await prepareLockRoot(join(common, 'rcl-converge-pending-recovery', source.digest));
  for (const artifact of artifacts) {
    const bytes = Buffer.from(artifact.bytesBase64, 'base64');
    await retainStaleFile(join(directory, artifact.sha256), bytes);
  }
  const manifest = Buffer.from(stableStringify({ version: 1, sourceDigest: source.digest,
    blockingOutcome: 'unknown', artifacts: artifacts.map(item => ({ sha256: item.sha256 })).sort((a, b) =>
      a.sha256.localeCompare(b.sha256)) }));
  await retainStaleFile(join(directory, 'manifest.json'), manifest);
}

function finalizationReceiptPath(common: string, migrationPackageSha256: string): string {
  return join(common, 'rcl-converge-pending-finalizations', migrationPackageSha256, 'receipt.json');
}

function finalizationSnapshotPath(common: string, migrationPackageSha256: string,
  name: 'source-attempt-state.json' | 'finalized-native-state.json'): string {
  return join(common, 'rcl-converge-pending-finalizations', migrationPackageSha256, name);
}

async function readFinalizationReceipt(common: string, migrationPackageSha256: string): Promise<OrdinaryPendingFinalizationReceipt | undefined> {
  try {
    const stored = await readStable(finalizationReceiptPath(common, migrationPackageSha256));
    return ordinaryPendingFinalizationReceiptSchema.parse(JSON.parse(stored.text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function retainFinalizationReceipt(common: string, receipt: OrdinaryPendingFinalizationReceipt): Promise<void> {
  const directory = await prepareLockRoot(join(common, 'rcl-converge-pending-finalizations', receipt.migrationPackageSha256));
  await retainStaleFile(join(directory, 'receipt.json'), Buffer.from(stableStringify(receipt)));
}

async function retainFinalizationSnapshots(common: string, receipt: OrdinaryPendingFinalizationReceipt,
  sourceAttemptState: Buffer, finalizedNativeState: Buffer): Promise<void> {
  if (createHash('sha256').update(sourceAttemptState).digest('hex') !== receipt.sourceAttemptStateSha256 ||
      createHash('sha256').update(finalizedNativeState).digest('hex') !== receipt.finalizedNativeStateSha256) {
    fail('finalization_snapshot_mismatch');
  }
  const directory = await prepareLockRoot(join(common, 'rcl-converge-pending-finalizations',
    receipt.migrationPackageSha256));
  await retainStaleFile(join(directory, 'source-attempt-state.json'), sourceAttemptState);
  await retainStaleFile(join(directory, 'finalized-native-state.json'), finalizedNativeState);
}

async function readFinalizationSnapshot(common: string, receipt: OrdinaryPendingFinalizationReceipt,
  name: 'source-attempt-state.json' | 'finalized-native-state.json', digest: string): Promise<Buffer> {
  const snapshot = await readStable(finalizationSnapshotPath(common, receipt.migrationPackageSha256, name));
  if (snapshot.sha256 !== digest) fail('finalization_snapshot_mismatch');
  return snapshot.raw;
}

function isPrefix<T>(before: readonly T[], after: readonly T[]): boolean {
  return before.length <= after.length && before.every((value, index) => isDeepStrictEqual(value, after[index]));
}

async function finalizationSnapshotsPresent(common: string,
  receipt: OrdinaryPendingFinalizationReceipt): Promise<boolean> {
  try {
    await Promise.all([
      readFinalizationSnapshot(common, receipt, 'source-attempt-state.json', receipt.sourceAttemptStateSha256),
      readFinalizationSnapshot(common, receipt, 'finalized-native-state.json', receipt.finalizedNativeStateSha256),
    ]);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertFinalizedStateMatchesReceipt(common: string,
  receipt: OrdinaryPendingFinalizationReceipt): Promise<{ native: Buffer; attempts: Buffer; exact: boolean }> {
  const [native, attempts] = await Promise.all([
    readStable(convergeRunStatePath(common, receipt.target)),
    readStable(convergeAttemptStatePath(common, receipt.target)),
  ]);
  if (native.sha256 === receipt.finalizedNativeStateSha256 &&
      attempts.sha256 === receipt.sourceAttemptStateSha256) {
    return { native: native.raw, attempts: attempts.raw, exact: true };
  }

  let originalAttemptsBytes: Buffer, finalizedNativeBytes: Buffer;
  try {
    [originalAttemptsBytes, finalizedNativeBytes] = await Promise.all([
      readFinalizationSnapshot(common, receipt, 'source-attempt-state.json', receipt.sourceAttemptStateSha256),
      readFinalizationSnapshot(common, receipt, 'finalized-native-state.json', receipt.finalizedNativeStateSha256),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('finalization_receipt_state_mismatch');
    throw error;
  }
  const [currentNative, currentAttempts] = await Promise.all([
    loadConvergeRunState(common, receipt.target),
    previewConvergeAttemptState(common, receipt.target),
  ]);
  if (!currentNative || !currentAttempts) fail('finalization_receipt_state_mismatch');
  const originalAttempts = JSON.parse(originalAttemptsBytes.toString('utf8')) as ConvergeAttemptState;
  const finalizedNative = JSON.parse(finalizedNativeBytes.toString('utf8')) as ConvergeRunState;
  const finalizedLaunch = launchSchema.safeParse(finalizedNative.lastLaunch);
  const currentLaunch = launchSchema.safeParse(currentNative.lastLaunch);
  const priorStale = finalizedNative.staleReportAudit ?? [], currentStale = currentNative.staleReportAudit ?? [];
  const priorGaps = finalizedNative.roundGapAudit?.entries ?? [], currentGaps = currentNative.roundGapAudit?.entries ?? [];
  if (originalAttempts.target !== receipt.target || currentAttempts.target !== receipt.target ||
      originalAttempts.attemptsUsed !== receipt.attemptsUsed || originalAttempts.cap !== receipt.cap ||
      originalAttempts.migratedAttempts !== currentAttempts.migratedAttempts ||
      currentAttempts.attemptsUsed <= receipt.attemptsUsed ||
      currentAttempts.cap < currentAttempts.attemptsUsed || currentAttempts.cap > receipt.cap ||
      !isDeepStrictEqual(currentAttempts.cycle, originalAttempts.cycle) ||
      !isPrefix(originalAttempts.attempts, currentAttempts.attempts) ||
      currentAttempts.attempts.at(originalAttempts.attempts.length)?.attempt !== receipt.nextFreeAttempt ||
      finalizedNative.target !== receipt.target || currentNative.target !== receipt.target ||
      !finalizedLaunch.success || finalizedLaunch.data.status !== 'failed' ||
      finalizedLaunch.data.attempt !== receipt.finalizedAttempt ||
      finalizedLaunch.data.round !== receipt.round ||
      finalizedLaunch.data.pendingRecovery?.sourceDigest !== receipt.sourceDigest ||
      !isDeepStrictEqual(currentNative.cycle, finalizedNative.cycle) ||
      currentNative.roundCap < finalizedNative.roundCap ||
      !isPrefix(finalizedNative.rounds, currentNative.rounds) ||
      !isPrefix(priorStale, currentStale) || !isPrefix(priorGaps, currentGaps) ||
      Object.entries(finalizedNative.findings)
        .some(([key, value]) => !isDeepStrictEqual(value, currentNative.findings[key])) ||
      !currentLaunch.success || currentLaunch.data.attempt <= receipt.finalizedAttempt ||
      currentLaunch.data.attempt !== currentAttempts.attemptsUsed) {
    fail('finalization_receipt_state_mismatch');
  }
  return { native: native.raw, attempts: attempts.raw, exact: false };
}

function createFinalizationReceipt(input: z.input<typeof ordinaryPendingFinalizationReceiptBodySchema>): OrdinaryPendingFinalizationReceipt {
  const body = ordinaryPendingFinalizationReceiptBodySchema.parse(input);
  return ordinaryPendingFinalizationReceiptSchema.parse({
    ...body,
    receiptDigest: createHash('sha256').update(stableStringify(body)).digest('hex'),
  });
}

function assertReceiptMatchesInput(receipt: OrdinaryPendingFinalizationReceipt,
  input: OrdinaryPendingFinalizeOptions, migrationPackageSha256: string): OrdinaryPendingPackage {
  if (receipt.target !== input.target || receipt.headSha !== input.headSha || receipt.baseSha !== input.baseSha ||
      receipt.inputSha256 !== input.pendingInputSha256 || receipt.migrationPackageSha256 !== migrationPackageSha256 ||
      receipt.sourceNativeStateSha256 !== input.nativeStateSha256 ||
      receipt.sourceAttemptStateSha256 !== input.attemptStateSha256 ||
      receipt.cap !== input.maxAttempts ||
      receipt.retainedAsyncSha256.join(',') !== [...input.retainedAsyncSha256].sort().join(',')) {
    fail('finalization_receipt_mismatch');
  }
  return validateOrdinaryPendingPackage(input.migrationPackage, {
    target: receipt.target, headSha: receipt.headSha, inputSha256: receipt.inputSha256,
    baseSha: receipt.baseSha, attempt: receipt.finalizedAttempt, round: receipt.round,
    pid: receipt.originalPid, retainedAsyncSha256: receipt.retainedAsyncSha256,
  });
}

async function readArchivedAsync(common: string, sourceDigest: string,
  retainedAsyncSha256: readonly string[]): Promise<AsyncResultReference[]> {
  const directory = join(common, 'rcl-converge-pending-recovery', sourceDigest);
  const artifacts = await Promise.all(retainedAsyncSha256.map(async digest => {
    const file = await readStable(join(directory, digest));
    if (file.sha256 !== digest) fail('async_binding_mismatch');
    return { path: join(directory, digest), sha256: digest, bytesBase64: file.raw.toString('base64') };
  }));
  const expectedManifest = stableStringify({ version: 1, sourceDigest,
    blockingOutcome: 'unknown', artifacts: [...retainedAsyncSha256].sort().map(sha256 => ({ sha256 })) });
  if ((await readStable(join(directory, 'manifest.json'))).text !== expectedManifest) {
    fail('async_binding_mismatch');
  }
  return artifacts;
}

async function loadOriginalOrArchivedAsync(options: OrdinaryPendingFinalizeOptions,
  source: PendingRecoverySource): Promise<AsyncResultReference[]> {
  try {
    return await readArchivedAsync(options.gitCommonDir, source.digest, source.retainedAsyncSha256);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return options.loadRetainedAsync();
  }
}

/** Finalize one authenticated ordinary pending launch without claiming or dispatching its successor. */
export async function finalizeOrdinaryPendingLaunch(input: OrdinaryPendingFinalizeOptions): Promise<OrdinaryPendingFinalizeResult> {
  validateFinalizeOptions(input);
  const options = { ...input, target: input.target.trim(),
    retainedAsyncSha256: [...input.retainedAsyncSha256].sort(),
    gitCommonDir: await realpath(resolve(input.gitCommonDir)) };
  const migrationPackageSha256 = createHash('sha256')
    .update(stableStringify(options.migrationPackage)).digest('hex');
  return withRecoveryTarget(options.gitCommonDir, options.target, async ownership => {
    const existingReceipt = await readFinalizationReceipt(options.gitCommonDir, migrationPackageSha256);
    if (existingReceipt) {
      const packet = assertReceiptMatchesInput(existingReceipt, options, migrationPackageSha256);
      const state = await assertFinalizedStateMatchesReceipt(options.gitCommonDir, existingReceipt);
      validateAsyncArtifacts({ retainedAsyncSha256: existingReceipt.retainedAsyncSha256 },
        await readArchivedAsync(options.gitCommonDir, existingReceipt.sourceDigest,
          existingReceipt.retainedAsyncSha256), packet);
      const snapshotsPresent = await finalizationSnapshotsPresent(options.gitCommonDir, existingReceipt);
      if (!snapshotsPresent) {
        if (!state.exact) fail('finalization_receipt_state_mismatch');
        await retainFinalizationSnapshots(options.gitCommonDir, existingReceipt,
          state.attempts, state.native);
      }
      return { receipt: existingReceipt, reusedReceipt: true,
        snapshotBindingUpgraded: !snapshotsPresent };
    }
    const [state, attempts] = await Promise.all([
      loadConvergeRunState(options.gitCommonDir, options.target),
      previewConvergeAttemptState(options.gitCommonDir, options.target),
    ]);
    if (!state || !attempts || !state.lastLaunch) fail('missing_launch');
    if (attempts.cap !== options.maxAttempts) fail('attempt_cap_mismatch');
    const current = launchSchema.parse(state.lastLaunch);
    if (current.attempt !== attempts.attemptsUsed || current.headSha !== options.headSha ||
        current.inputSha256 !== options.pendingInputSha256 || !['pending', 'failed'].includes(current.status)) {
      fail('launch_mismatch');
    }
    const packet = validateOrdinaryPendingPackage(options.migrationPackage, {
      target: options.target, headSha: current.headSha, inputSha256: current.inputSha256,
      baseSha: options.baseSha, attempt: current.attempt, round: current.round, pid: current.pid,
      retainedAsyncSha256: options.retainedAsyncSha256,
    });
    let source: PendingRecoverySource;
    let sourceAttemptStateBytes: Buffer | undefined;
    if (current.status === 'pending') {
      if ((options.ownerAlive ?? defaultOwnerAlive)(current.pid)) fail('owner_alive');
      const [nativeBytes, attemptBytes] = await Promise.all([
        readStable(convergeRunStatePath(options.gitCommonDir, options.target)),
        readStable(convergeAttemptStatePath(options.gitCommonDir, options.target)),
      ]);
      sourceAttemptStateBytes = attemptBytes.raw;
      source = createOrdinaryMigrationSource({ version: 1, target: options.target,
        headSha: current.headSha, inputSha256: current.inputSha256, pendingAttempt: current.attempt,
        round: current.round, originalPid: current.pid, startedAt: current.startedAt,
        blockingOutcome: 'unknown', reason: 'coordinator_exited_without_durable_blocking_receipts',
        nativeStateSha256: nativeBytes.sha256, attemptStateSha256: attemptBytes.sha256,
        retainedAsyncSha256: options.retainedAsyncSha256, migrationPackageSha256 });
    } else {
      source = sourceFromFinalized(options.target, current, attempts, packet);
    }
    if (source.nativeStateSha256 !== options.nativeStateSha256 ||
        source.attemptStateSha256 !== options.attemptStateSha256) fail('source_digest_mismatch');
    // Once the failed/unknown native state exists, archive publication already
    // completed. Resume from those immutable bytes so a lost acknowledgment
    // does not depend on the original async store still being available.
    const artifacts = current.status === 'pending'
      ? await loadOriginalOrArchivedAsync(options, source)
      : await readArchivedAsync(options.gitCommonDir, source.digest, source.retainedAsyncSha256);
    validateAsyncArtifacts(source, artifacts, packet);

    let finalizedNativeStateSha256: string;
    if (current.status === 'pending') {
      state.lastLaunch = { ...current, status: 'failed', pendingRecovery: descriptor(source) };
      state.updatedAt = new Date().toISOString();
      finalizedNativeStateSha256 = createHash('sha256')
        .update(serializeRecoveryDocument(state)).digest('hex');
    } else {
      finalizedNativeStateSha256 = (await readStable(
        convergeRunStatePath(options.gitCommonDir, options.target))).sha256;
    }
    // Construct and validate the exact receipt before the first write. The
    // native serializer is shared with writeState, so its post-state digest is
    // known without publishing a partially validated operation.
    const receipt = createFinalizationReceipt({ version: 1, operation: 'ordinary-pending-finalize-only',
      target: options.target, headSha: current.headSha, baseSha: options.baseSha,
      inputSha256: current.inputSha256, sourceDigest: source.digest, migrationPackageSha256,
      finalizedAttempt: current.attempt, round: current.round, originalPid: current.pid,
      attemptsUsed: attempts.attemptsUsed, cap: attempts.cap, nextFreeAttempt: current.attempt + 1,
      blockingOutcome: 'unknown', retainedAsyncSha256: options.retainedAsyncSha256,
      sourceNativeStateSha256: source.nativeStateSha256,
      sourceAttemptStateSha256: source.attemptStateSha256,
      finalizedNativeStateSha256 });

    if (current.status === 'pending') {
      await preflightConvergeRunStateWrite(options.gitCommonDir, state, ownership);
    }

    // Every fallible authentication and accounting check above precedes the
    // first durable write. Archive publication is idempotent if this process
    // stops before the native failed/unknown state or receipt is published.
    await archiveAsync(options.gitCommonDir, source, artifacts, packet);
    if (current.status === 'pending') {
      await (options.writeFinalizedState ?? writeState)(options.gitCommonDir, state, ownership);
    }
    const finalizedNative = await readStable(convergeRunStatePath(options.gitCommonDir, options.target));
    if (finalizedNative.sha256 !== finalizedNativeStateSha256) fail('finalization_write_mismatch');
    const finalizedAttempts = await readStable(convergeAttemptStatePath(options.gitCommonDir, options.target));
    sourceAttemptStateBytes ??= finalizedAttempts.raw;
    await retainFinalizationSnapshots(options.gitCommonDir, receipt,
      sourceAttemptStateBytes, finalizedNative.raw);
    await retainFinalizationReceipt(options.gitCommonDir, receipt);
    return { receipt, reusedReceipt: false, snapshotBindingUpgraded: false };
  });
}

function validateAsyncArtifacts(source: Pick<PendingRecoverySource, 'retainedAsyncSha256'>,
  artifacts: readonly AsyncResultReference[], packet?: OrdinaryPendingPackage): void {
  const expected = [...source.retainedAsyncSha256].sort();
  const actual = artifacts.map(item => item.sha256).sort();
  if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index])) {
    fail('async_binding_mismatch');
  }
  for (const artifact of artifacts) {
    const bytes = Buffer.from(artifact.bytesBase64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) fail('async_binding_mismatch');
    if (packet) {
      const descriptor = packet.retainedAsync.find(item => item.sha256 === artifact.sha256);
      let row: { model?: unknown; role?: unknown; provider?: unknown };
      try { row = JSON.parse(bytes.toString('utf8')) as typeof row; } catch { fail('async_binding_mismatch'); }
      if (!descriptor || row.model !== descriptor.model || row.role !== descriptor.role ||
          row.provider !== descriptor.provider) fail('async_binding_mismatch');
    }
  }
}

/** Authenticate an ordinary dead-owner recovery under its target lock without mutating native state. */
export async function previewOrdinaryPendingLaunch(input: PendingLegacyResumeOptions): Promise<OrdinaryPendingPreview> {
  validateOptions(input);
  if (!input.migrationPackage) fail('migration_package_required');
  const options = { ...input, target: input.target.trim(), retainedAsyncSha256: [...input.retainedAsyncSha256].sort(),
    gitCommonDir: await realpath(resolve(input.gitCommonDir)) };
  return withRecoveryTarget(options.gitCommonDir, options.target, async ownership => {
    const [state, attempts] = await Promise.all([
      loadConvergeRunState(options.gitCommonDir, options.target),
      previewConvergeAttemptState(options.gitCommonDir, options.target),
    ]);
    if (!state || !attempts || !state.lastLaunch) fail('missing_launch');
    const current = launchSchema.parse(state.lastLaunch);
    const record = attempts.attempts.find(item => item.attempt === current.attempt);
    if (!record || current.status !== 'pending' || current.attempt !== attempts.attemptsUsed ||
      current.headSha !== options.headSha || current.inputSha256 !== options.pendingInputSha256) fail('launch_mismatch');
    if (options.previewMode === 'finalize-only'
      ? attempts.cap !== options.maxAttempts
      : options.maxAttempts > current.attempt + 1) fail('attempt_cap_mismatch');
    if (options.previewMode !== 'finalize-only' && attempts.attemptsUsed >= attempts.cap) {
      fail('attempt_cap_exhausted');
    }
    if ((options.ownerAlive ?? defaultOwnerAlive)(current.pid)) fail('owner_alive');
    const packet = validateOrdinaryPendingPackage(options.migrationPackage!, {
      target: options.target, headSha: current.headSha, inputSha256: current.inputSha256,
      baseSha: options.baseSha!, attempt: current.attempt, round: current.round, pid: current.pid,
      retainedAsyncSha256: options.retainedAsyncSha256,
    });
    const [nativeBytes, attemptBytes] = await Promise.all([
      readStable(convergeRunStatePath(options.gitCommonDir, options.target)),
      readStable(convergeAttemptStatePath(options.gitCommonDir, options.target)),
    ]);
    const source = createOrdinaryMigrationSource({ version: 1, target: options.target,
      headSha: current.headSha, inputSha256: current.inputSha256, pendingAttempt: current.attempt,
      round: current.round, originalPid: current.pid, startedAt: current.startedAt,
      blockingOutcome: 'unknown', reason: 'coordinator_exited_without_durable_blocking_receipts',
      nativeStateSha256: nativeBytes.sha256, attemptStateSha256: attemptBytes.sha256,
      retainedAsyncSha256: options.retainedAsyncSha256,
      migrationPackageSha256: createHash('sha256').update(stableStringify(packet)).digest('hex'),
    });
    validateAsyncArtifacts(source, await options.loadRetainedAsync(), packet);
    return { source, nativeStateSha256: nativeBytes.sha256, attemptStateSha256: attemptBytes.sha256,
      attemptsUsed: attempts.attemptsUsed, cap: attempts.cap, nextAttempt: current.attempt + 1 };
  });
}

async function runBound(options: PendingLegacyResumeOptions, ownership: NativeTargetOwnership,
  state: NonNullable<Awaited<ReturnType<typeof loadConvergeRunState>>>, claim: ConvergeAttemptClaim,
  source: PendingRecoverySource, launch: OriginalLaunch,
  resume: NonNullable<GuardedLaunchState['pendingResume']>): Promise<GuardedLaunchCompletion> {
  const journal = await bindOriginalCouncil({ commonDir: options.gitCommonDir, ownership,
    captured: options.captured.captured, launch });
  const emptyAsync = captureSupplementalAsync([], 0).bytes;
  const bindings = await journal.readBindings();
  if (bindings['supplemental-async'] === undefined) {
    await journal.bind('supplemental-async', emptyAsync, ownership);
  } else if (bindings['supplemental-async'] !== emptyAsync) fail('async_binding_mismatch');
  try {
    const completion = completionSchema.parse(await options.run({ context: { target: options.target,
      attempt: claim.attempt, round: source.round }, claim, ownership, journal,
      launch, skipAsyncLaunch: true }));
    if (completion.runId !== resume.runId) fail('run_mismatch');
    state.lastLaunch = { ...state.lastLaunch!, ...completion, status: 'completed',
      pendingResume: { ...resume, pid: process.pid, phase: 'finished' } };
    state.updatedAt = new Date().toISOString();
    await writeState(options.gitCommonDir, state, ownership);
    return completion;
  } catch (error) {
    state.lastLaunch = { ...state.lastLaunch!, status: 'failed',
      pendingResume: { ...resume, pid: process.pid, phase: 'finished' } };
    state.updatedAt = new Date().toISOString();
    await writeState(options.gitCommonDir, state, ownership);
    throw error;
  }
}

async function claimFresh(options: PendingLegacyResumeOptions, ownership: NativeTargetOwnership,
  state: NonNullable<Awaited<ReturnType<typeof loadConvergeRunState>>>,
  source: PendingRecoverySource): Promise<PendingLegacyResumeResult> {
  if (options.maxAttempts > source.pendingAttempt + 1) fail('attempt_cap_mismatch');
  const now = (options.nowMs ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) fail('invalid_clock');
  const resume = { version: 1 as const, runId: uuidv7(), planDigest: options.captured.plan.digest,
    capturedInputsSha256: options.captured.captured.digest, originalPid: source.originalPid,
    pid: process.pid, phase: 'running' as const, startedAtMs: now,
    expiresAtMs: now + options.maxDurationMs, maxPhysicalCalls: options.maxPhysicalCalls,
    maxAttemptsPerCell: options.maxAttemptsPerCell };
  const launch = createOriginalLaunch({ runId: resume.runId, target: options.target,
    originalNativeClaim: { attempt: source.pendingAttempt + 1, round: source.round },
    capturedInputsSha256: resume.capturedInputsSha256, planDigest: resume.planDigest,
    startedAtMs: resume.startedAtMs, expiresAtMs: resume.expiresAtMs,
    maxPhysicalCalls: resume.maxPhysicalCalls, maxAttemptsPerCell: resume.maxAttemptsPerCell });
  let completion: GuardedLaunchCompletion | undefined;
  let failure: unknown;
  const claim = await claimConvergeAttempt({
    gitCommonDir: options.gitCommonDir, target: options.target, maxAttempts: options.maxAttempts,
    ownership, pendingRecoverySource: source,
    afterClaim: async (claimed, claimOwnership) => {
      state.lastLaunch = { status: 'pending', attempt: claimed.attempt, round: source.round,
        headSha: options.headSha, inputSha256: options.recoveryInputSha256,
        startedAt: new Date(now).toISOString(), pid: process.pid,
        retryReason: options.retryReason.trim(),
        pendingRecovery: descriptor(source), pendingResume: resume };
      state.updatedAt = new Date().toISOString();
      await writeState(options.gitCommonDir, state, claimOwnership);
      try { completion = await runBound(options, claimOwnership, state, claimed, source, launch, resume); }
      catch (error) { failure = error; }
    },
  });
  if (failure) throw failure;
  return { claim, completion: completion!, reusedCompletion: false };
}

async function resumeFresh(options: PendingLegacyResumeOptions, ownership: NativeTargetOwnership,
  state: NonNullable<Awaited<ReturnType<typeof loadConvergeRunState>>>, attempts: ConvergeAttemptState,
  current: GuardedLaunchState): Promise<PendingLegacyResumeResult> {
  const record = attempts.attempts.at(-1);
  const source = record?.pendingRecoverySource;
  if (!source || record!.attempt !== attempts.attemptsUsed) fail('capture_mismatch');
  const claim = { target: options.target, attempt: record.attempt, attemptsUsed: attempts.attemptsUsed,
    cap: attempts.cap, stateFile: convergeAttemptStatePath(options.gitCommonDir, options.target) };
  // The attempt ledger is the first durable A35 boundary. If the process died
  // before publishing lastLaunch, no provider could have run because the
  // checkpoint and runner are created only after that publication.
  if (current.attempt === source.pendingAttempt) {
    if (current.status !== 'failed' || current.pendingRecovery?.sourceDigest !== source.digest ||
        current.headSha !== options.headSha || current.inputSha256 !== options.pendingInputSha256) {
      fail('claim_gap_mismatch');
    }
    await options.validate();
    await archiveAsync(options.gitCommonDir, source, await options.loadRetainedAsync(), options.migrationPackage);
    const now = (options.nowMs ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) fail('invalid_clock');
    const resume = { version: 1 as const, runId: uuidv7(), planDigest: options.captured.plan.digest,
      capturedInputsSha256: options.captured.captured.digest, originalPid: source.originalPid,
      pid: process.pid, phase: 'running' as const, startedAtMs: now,
      expiresAtMs: now + options.maxDurationMs, maxPhysicalCalls: options.maxPhysicalCalls,
      maxAttemptsPerCell: options.maxAttemptsPerCell };
    const launch = createOriginalLaunch({ runId: resume.runId, target: options.target,
      originalNativeClaim: { attempt: claim.attempt, round: source.round },
      capturedInputsSha256: resume.capturedInputsSha256, planDigest: resume.planDigest,
      startedAtMs: resume.startedAtMs, expiresAtMs: resume.expiresAtMs,
      maxPhysicalCalls: resume.maxPhysicalCalls, maxAttemptsPerCell: resume.maxAttemptsPerCell });
    state.lastLaunch = { status: 'pending', attempt: claim.attempt, round: source.round,
      headSha: options.headSha, inputSha256: options.recoveryInputSha256,
      startedAt: new Date(now).toISOString(), pid: process.pid,
      retryReason: options.retryReason.trim(), pendingRecovery: descriptor(source), pendingResume: resume };
    state.updatedAt = new Date().toISOString();
    await writeState(options.gitCommonDir, state, ownership);
    const completion = await runBound(options, ownership, state, claim, source, launch, resume);
    return { claim, completion, reusedCompletion: false };
  }
  const resume = current.pendingResume;
  if (!resume || current.attempt !== attempts.attemptsUsed ||
      current.headSha !== options.headSha || current.inputSha256 !== options.recoveryInputSha256 ||
      resume.planDigest !== options.captured.plan.digest ||
      resume.capturedInputsSha256 !== options.captured.captured.digest ||
      current.pendingRecovery?.sourceDigest !== source.digest) fail('capture_mismatch');
  if (current.status === 'completed') {
    if (!current.runId || current.runId !== resume.runId) fail('completed_mismatch');
    return { claim, completion: completionSchema.parse(current), reusedCompletion: true };
  }
  if (resume.phase === 'running' && (options.ownerAlive ?? defaultOwnerAlive)(resume.pid)) fail('owner_alive');
  await options.validate();
  const artifacts = await options.loadRetainedAsync();
  await archiveAsync(options.gitCommonDir, source, artifacts);
  const launch = createOriginalLaunch({ runId: resume.runId, target: options.target,
    originalNativeClaim: { attempt: current.attempt, round: current.round },
    capturedInputsSha256: resume.capturedInputsSha256, planDigest: resume.planDigest,
    startedAtMs: resume.startedAtMs, expiresAtMs: resume.expiresAtMs,
    maxPhysicalCalls: resume.maxPhysicalCalls, maxAttemptsPerCell: resume.maxAttemptsPerCell });
  state.lastLaunch = { ...current, status: 'pending',
    pendingResume: { ...resume, pid: process.pid, phase: 'running' } };
  state.updatedAt = new Date().toISOString();
  await writeState(options.gitCommonDir, state, ownership);
  const completion = await runBound(options, ownership, state, claim, source, launch,
    { ...resume, pid: process.pid, phase: 'running' });
  return { claim, completion, reusedCompletion: false };
}

/** Finalize unknown A34 evidence, then claim one fresh checkpointed A35. */
export function resumePendingLegacyLaunch(input: PendingLegacyResumeOptions & { preview: true }): Promise<OrdinaryPendingPreview>;
export function resumePendingLegacyLaunch(input: PendingLegacyResumeOptions & { preview?: false }): Promise<PendingLegacyResumeResult>;
export function resumePendingLegacyLaunch(input: PendingLegacyResumeOptions): Promise<PendingLegacyResumeResult | OrdinaryPendingPreview>;
export async function resumePendingLegacyLaunch(input: PendingLegacyResumeOptions): Promise<PendingLegacyResumeResult | OrdinaryPendingPreview> {
  if (input.preview) return previewOrdinaryPendingLaunch(input);
  validateOptions(input);
  const options = { ...input, target: input.target.trim(), retainedAsyncSha256: [...input.retainedAsyncSha256].sort(),
    gitCommonDir: await realpath(resolve(input.gitCommonDir)) };
  return withRecoveryTarget(options.gitCommonDir, options.target, async ownership => {
    const [state, attempts] = await Promise.all([
      loadConvergeRunState(options.gitCommonDir, options.target),
      previewConvergeAttemptState(options.gitCommonDir, options.target),
    ]);
    if (!state || !attempts || !state.lastLaunch) fail('missing_launch');
    const current = launchSchema.parse(state.lastLaunch);
    const persistedSource = attempts.attempts.at(-1)?.pendingRecoverySource;
    const original = persistedSource ?? current;
    const originalAttempt = 'pendingAttempt' in original ? original.pendingAttempt : original.attempt;
    const originalPid = 'originalPid' in original ? original.originalPid : original.pid;
    const migrationPackage = options.migrationPackage && validateOrdinaryPendingPackage(options.migrationPackage, {
        target: options.target, headSha: original.headSha, inputSha256: original.inputSha256,
        baseSha: options.baseSha!, attempt: originalAttempt, round: original.round, pid: originalPid,
        retainedAsyncSha256: options.retainedAsyncSha256,
      });
    // Combined finalize-and-successor recovery is explicit one-attempt
    // authority. Refuse a broader cap before archiving evidence or changing
    // the pending launch to failed/unknown.
    if (options.maxAttempts > originalAttempt + 1) fail('attempt_cap_mismatch');
    if (persistedSource) {
      return resumeFresh(options, ownership, state, attempts, current);
    }
    const record = attempts.attempts.find(item => item.attempt === current.attempt);
    if (!record || (!record.retrySource && !migrationPackage) || (migrationPackage && record.retrySource) ||
      current.attempt !== attempts.attemptsUsed || current.headSha !== options.headSha ||
      current.inputSha256 !== options.pendingInputSha256 || !['pending', 'failed'].includes(current.status)) {
      fail('launch_mismatch');
    }
    let source: PendingRecoverySource;
    if (current.status === 'pending') {
      if ((options.ownerAlive ?? defaultOwnerAlive)(current.pid)) fail('owner_alive');
      const [nativeBytes, attemptBytes] = await Promise.all([
        readStable(convergeRunStatePath(options.gitCommonDir, options.target)),
        readStable(convergeAttemptStatePath(options.gitCommonDir, options.target)),
      ]);
      source = migrationPackage ? createOrdinaryMigrationSource({ version: 1, target: options.target,
        headSha: current.headSha, inputSha256: current.inputSha256, pendingAttempt: current.attempt,
        round: current.round, originalPid: current.pid, startedAt: current.startedAt,
        blockingOutcome: 'unknown', reason: 'coordinator_exited_without_durable_blocking_receipts',
        nativeStateSha256: nativeBytes.sha256, attemptStateSha256: attemptBytes.sha256,
        retainedAsyncSha256: options.retainedAsyncSha256,
        migrationPackageSha256: createHash('sha256').update(stableStringify(migrationPackage)).digest('hex'),
      }) : createPendingRecoverySource({ version: 1, target: options.target,
        headSha: current.headSha, inputSha256: current.inputSha256, pendingAttempt: current.attempt,
        round: current.round, originalPid: current.pid, startedAt: current.startedAt,
        blockingOutcome: 'unknown', reason: 'coordinator_exited_without_durable_blocking_receipts',
        nativeStateSha256: nativeBytes.sha256, attemptStateSha256: attemptBytes.sha256,
        retainedAsyncSha256: options.retainedAsyncSha256, retrySource: (await inspectPendingLegacyRetry(options.legacyRetry!, options.gitCommonDir, state, current, attempts)).binding });
    } else source = sourceFromFinalized(options.target, current, attempts, migrationPackage);
    if (source.retainedAsyncSha256.join(',') !== options.retainedAsyncSha256.join(',')) {
      fail('async_binding_mismatch');
    }
    await options.validate();
    const artifacts = await options.loadRetainedAsync();
    await archiveAsync(options.gitCommonDir, source, artifacts);
    if (current.status === 'pending') {
      state.lastLaunch = { ...current, status: 'failed', pendingRecovery: descriptor(source) };
      state.updatedAt = new Date().toISOString();
      await writeState(options.gitCommonDir, state, ownership);
    }
    return claimFresh(options, ownership, state, source);
  });
}
