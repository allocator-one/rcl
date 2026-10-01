import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectPendingLegacyRetry, type LegacyRetrySelection } from './legacy-launch-health.js';
import { completionSchema, launchSchema, type GuardedLaunchCompletion, type GuardedLaunchState } from './launch-record.js';
import { convergeRunStatePath, loadConvergeRunState, writeState } from './run-state.js';
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
  baseSha: string;
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
    !/^[a-f0-9]{40}$/.test(input.baseSha ?? '') ||
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
    !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1 || input.maxDurationMs > 2_147_483_647) {
    fail('invalid_input');
  }
}

async function archiveAsync(common: string, source: PendingRecoverySource,
  artifacts: readonly AsyncResultReference[]): Promise<void> {
  validateAsyncArtifacts(source, artifacts);
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

function validateAsyncArtifacts(source: PendingRecoverySource,
  artifacts: readonly AsyncResultReference[]): void {
  const expected = [...source.retainedAsyncSha256].sort();
  const actual = artifacts.map(item => item.sha256).sort();
  if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index])) {
    fail('async_binding_mismatch');
  }
  for (const artifact of artifacts) {
    const bytes = Buffer.from(artifact.bytesBase64, 'base64');
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) fail('async_binding_mismatch');
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
    if ((options.ownerAlive ?? defaultOwnerAlive)(current.pid)) fail('owner_alive');
    const packet = validateOrdinaryPendingPackage(options.migrationPackage!, {
      target: options.target, headSha: current.headSha, inputSha256: current.inputSha256,
      baseSha: options.baseSha, attempt: current.attempt, round: current.round, pid: current.pid,
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
    validateAsyncArtifacts(source, await options.loadRetainedAsync());
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
    await archiveAsync(options.gitCommonDir, source, await options.loadRetainedAsync());
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
        baseSha: options.baseSha, attempt: originalAttempt, round: original.round, pid: originalPid,
        retainedAsyncSha256: options.retainedAsyncSha256,
      });
    if (persistedSource) {
      return resumeFresh(options, ownership, state, attempts, current);
    }
    const record = attempts.attempts.find(item => item.attempt === current.attempt);
    if (!record || (!record.retrySource && !migrationPackage) || current.attempt !== attempts.attemptsUsed ||
      current.headSha !== options.headSha || current.inputSha256 !== options.pendingInputSha256 ||
      !['pending', 'failed'].includes(current.status)) fail('launch_mismatch');
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
