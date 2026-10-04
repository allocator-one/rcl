import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { convergeAttemptStatePath, loadConvergeAttemptState } from './attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState } from './run-state.js';
import { launchSchema } from './launch-record.js';
import { prepareOrdinaryPendingGuardedInput, validateOrdinaryPendingPackage,
  type OrdinaryPendingPackage, type PreparedOrdinaryPendingGuardedInput } from './ordinary-pending-package.js';
import { MAX_ASYNC_CALLS_PER_ROUND, snapshotAsyncHistory, snapshotAsyncResults } from '../dispatch/async-lane.js';
import { sha256Hex } from '../report/run-header.js';
import { MAX_REPORT_BYTES, readStable } from '../telemetry/recovery/files.js';
import { serializeRecoveryDocument, writeExclusiveBytes } from '../evidence/original-run/journal.js';
import { syncNativeDirectory, writeNativeStateExclusive } from './native-lock.js';
import { assertReviewCyclePair } from './fresh-review.js';
import { DEFAULT_GUARDED_INPUT_CAPACITY, MAX_GUARDED_INPUT_CAPACITY,
  retainedGuardedInputCapacity, validateGuardedInputCapacity,
  type GuardedInputCapacity, type StoredGuardedInput } from './guarded-input-retention.js';

// Reserve the same 5 MiB for retained-async descriptors in every recovery
// envelope. Default inputs retain the historical 25 MiB package ceiling.
const RECOVERY_ENVELOPE_BYTES = MAX_REPORT_BYTES - DEFAULT_GUARDED_INPUT_CAPACITY.retainedBytes;
export const MAX_ORDINARY_PENDING_PACKAGE_BYTES =
  MAX_GUARDED_INPUT_CAPACITY.retainedBytes + RECOVERY_ENVELOPE_BYTES;

/** Read under the hard ceiling, then enforce this archive's selected envelope bound. */
export function ordinaryPendingPackageByteLimit(input: StoredGuardedInput): number {
  return retainedGuardedInputCapacity(input).retainedBytes + RECOVERY_ENVELOPE_BYTES;
}

interface OrdinaryLaunchInputs {
  gitCommonDir: string;
  target: string;
  headSha: string;
  baseSha: string | null;
  guardedInput: Record<string, unknown>;
  guardedInputCapacity?: GuardedInputCapacity;
  attempt: number;
  round: number;
  cycleId?: string;
  asyncDescriptors?: Array<{ model: string; role: string; provider: string }>;
}

function retainedInputsPath(options: Pick<OrdinaryLaunchInputs, 'gitCommonDir' | 'target' | 'attempt' | 'cycleId'> & { packetSha256: string }): string {
  const namespace = sha256Hex(JSON.stringify([options.target, options.cycleId ?? null]));
  return join(options.gitCommonDir, 'rcl-ordinary-inputs', `${namespace}-attempt-${options.attempt}-${options.packetSha256}.json`);
}

function retainedInputs(options: OrdinaryLaunchInputs, representation: 'raw' | 'retained' = 'retained',
  prepared = prepareOrdinaryPendingGuardedInput(options.guardedInput, options.guardedInputCapacity)) {
  // Validate recursive bounds before guardedInputSha256 reaches stableStringify.
  // Version 1 keeps its historical raw wire representation; only version 2
  // stores the validated compact archive.
  return { version: representation === 'raw' ? 1 : 2,
    target: options.target, headSha: options.headSha, baseSha: options.baseSha,
    attempt: options.attempt, round: options.round, ...(options.cycleId ? { cycleId: options.cycleId } : {}),
    inputSha256: prepared.inputSha256(),
    guardedInput: representation === 'raw' ? prepared.wireInput : prepared.retained };
}

export interface RetainedOrdinaryInputs {
  path: string;
  sha256: string;
  baseSha: string | null;
}

/** Called under native target ownership before spending the claim or dispatching. */
export async function retainOrdinaryLaunchInputs(options: OrdinaryLaunchInputs): Promise<RetainedOrdinaryInputs> {
  const capacity = validateGuardedInputCapacity(
    options.guardedInputCapacity === undefined
      ? DEFAULT_GUARDED_INPUT_CAPACITY : options.guardedInputCapacity);
  const common = await realpath(options.gitCommonDir);
  let packet: ReturnType<typeof retainedInputs>;
  let bytes: string;
  try {
    packet = retainedInputs(options);
    bytes = serializeRecoveryDocument(packet, capacity.retainedBytes);
    const descriptors = options.asyncDescriptors ?? [];
    // Recovery repeats the async reviewer identifiers alongside the guarded
    // roster. Bound that actual envelope before claim, including its future
    // fixed-length hashes and the largest permitted PID representation.
    const projectedRecovery: OrdinaryPendingPackage = {
      guardedInputRepresentation: { version: 1, encoding: 'json-string-table-v1' },
      target: options.target, headSha: options.headSha, baseSha: options.baseSha ?? 'f'.repeat(40),
      attempt: options.attempt, round: options.round, pid: Number.MAX_SAFE_INTEGER,
      retainedAsyncSha256: descriptors.map(() => 'f'.repeat(64)),
      retainedAsync: descriptors.map(descriptor => ({ model: descriptor.model, role: descriptor.role,
        provider: descriptor.provider, lane: 'async', sha256: 'f'.repeat(64) })),
      guardedInput: packet.guardedInput,
    };
    serializeRecoveryDocument(projectedRecovery, ordinaryPendingPackageByteLimit(packet.guardedInput));
  } catch (error) {
    if (error instanceof Error && (error.message === 'recovery_document_too_large' ||
        error.message === 'guarded_input_archive_expands_too_large')) {
      throw new Error('retained_review_work_too_large: retained prompts exceed the recovery limit; split the diff or reduce prompt context or the reviewer roster before retrying');
    }
    throw error;
  }

  const packetSha256 = sha256Hex(bytes);
  // A preclaim crash leaves the ordinal unspent. Include the full packet so
  // a changed base (which the guarded-input digest omits) gets its own file.
  const path = retainedInputsPath({ ...options, gitCommonDir: common, packetSha256 });
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const info = await lstat(directory);
  const uid = process.geteuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory ||
      (process.platform !== 'win32' && (uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0))) {
    throw new Error('ordinary_retained_input_directory_unsafe');
  }
  // Only complete, fsynced bytes become a final capture. Interrupted staging
  // files remain private evidence and do not reserve the immutable final name.
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeNativeStateExclusive(temporary, packet);
  try { await link(temporary, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readStable(path, capacity.retainedBytes, { allowMissingSafeFlagsOnWindows: true })).text !== bytes) {
      throw new Error('ordinary_retained_input_mismatch');
    }
    await readStable(path, capacity.retainedBytes, { sync: true, allowMissingSafeFlagsOnWindows: true });
  }
  await syncNativeDirectory(directory);
  await unlink(temporary);
  await syncNativeDirectory(directory);
  await syncNativeDirectory(common);
  return { path, sha256: packetSha256, baseSha: options.baseSha };
}

interface OrdinaryPendingExportOptions {
  gitCommonDir: string;
  target: string;
  headSha: string;
  baseSha: string;
  expectedBaseSha: string;
  expectedRound?: number;
  guardedInput: Record<string, unknown>;
  guardedInputCapacity?: GuardedInputCapacity;
  asyncStoreDir: string;
  asyncTargetKey: string;
  asyncDescriptors: Array<{ model: string; role: string; provider: string }>;
  path: string;
  preview: boolean;
}

function refuse(reason: string): never { throw new Error(`pending_export_${reason}`); }
function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function retainedHistoricalInput(text: string, options: OrdinaryLaunchInputs,
  packetSha256: string): PreparedOrdinaryPendingGuardedInput {
  let value: unknown;
  try { value = JSON.parse(text); } catch { refuse('retained_input_mismatch'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('retained_input_mismatch');
  const packet = value as Record<string, unknown>;
  if (packet.version !== 1 && packet.version !== 2) refuse('retained_input_mismatch');
  const compact = packet.guardedInput && typeof packet.guardedInput === 'object' &&
    !Array.isArray(packet.guardedInput) &&
    (packet.guardedInput as Record<string, unknown>).encoding === 'json-string-table-v1';
  if (compact !== (packet.version === 2)) refuse('retained_input_mismatch');
  let prepared: PreparedOrdinaryPendingGuardedInput;
  try { prepared = prepareOrdinaryPendingGuardedInput(packet.guardedInput as Record<string, unknown>); }
  catch { refuse('retained_input_mismatch'); }
  const expected = retainedInputs({ ...options, guardedInput: prepared.input },
    packet.version === 1 ? 'raw' : 'retained', prepared);
  if (sha256Hex(text) !== packetSha256 || text !== serializeRecoveryDocument(expected, retainedGuardedInputCapacity(prepared.retained).retainedBytes)) {
    refuse('retained_input_mismatch');
  }
  return prepared;
}

/**
 * Authenticate reconstructed ordinary inputs without locks, claims or native writes.
 * Historical launch digests did not include base: the receipt explicitly limits
 * that assertion to the caller's expected and currently resolved review target.
 * Async bytes are supplemental history, never durable blocking-call receipts.
 */
export async function exportOrdinaryPendingPackage(options: OrdinaryPendingExportOptions) {
  if (!/^[a-f0-9]{40}$/.test(options.baseSha) || options.baseSha !== options.expectedBaseSha) refuse('base_mismatch');
  // Current caller input participates in hashes and canonical comparisons
  // below, so bound its recursion before either operation.
  const currentInput = prepareOrdinaryPendingGuardedInput(options.guardedInput, options.guardedInputCapacity);
  const common = await realpath(options.gitCommonDir);
  const outputPath = resolve(options.path);
  const outputParent = await realpath(dirname(outputPath));
  const fromCommon = relative(common, outputParent);
  if (fromCommon === '' || (fromCommon !== '..' && !fromCommon.startsWith(`..${sep}`))) refuse('native_output_path');
  const nativePath = convergeRunStatePath(common, options.target);
  const attemptPath = convergeAttemptStatePath(common, options.target);
  const [nativeBefore, attemptsBefore] = await Promise.all([readStable(nativePath), readStable(attemptPath)]);
  const [state, attempts] = await Promise.all([
    loadConvergeRunState(common, options.target), loadConvergeAttemptState(common, options.target),
  ]);
  if (!state?.lastLaunch || !attempts) refuse('ordinary_launch_required');
  await assertReviewCyclePair(common, options.target, state.cycle);
  const cycleBacked = state.cycle !== undefined;
  const launch = launchSchema.parse(state.lastLaunch);
  const record = attempts.attempts.find(item => item.attempt === launch.attempt);
  if (launch.status !== 'pending' || launch.pendingResume || launch.retainedOriginal || launch.recovery ||
      launch.pendingRecovery || !record || record.pid !== launch.pid || record.retrySource ||
      record.boundFixRecoverySource || record.pendingRecoverySource ||
      launch.attempt !== attempts.attemptsUsed || launch.headSha !== options.headSha ||
      (!cycleBacked && launch.inputSha256 !== currentInput.inputSha256()) ||
      (options.expectedRound !== undefined && launch.round !== options.expectedRound)) refuse('input_mismatch');
  if (ownerAlive(launch.pid)) refuse('owner_alive');
  // Only a native marker proves which full packet preceded this claim.
  // Unmarked historical launches retain their explicit current-base limitation,
  // even if abandoned preclaim packets happen to exist in the capture directory.
  const binding = launch.ordinaryInputs;
  if (binding && binding.baseSha !== options.baseSha) refuse('retained_base_mismatch');
  const retainedPath = binding ? retainedInputsPath({ gitCommonDir: common, target: options.target,
    attempt: launch.attempt, ...(state.cycle ? { cycleId: state.cycle.id } : {}),
    packetSha256: binding.packetSha256 }) : undefined;
  const retainedBefore = retainedPath ? await readStable(retainedPath, MAX_GUARDED_INPUT_CAPACITY.retainedBytes) : undefined;
  if (binding && (!retainedBefore || retainedBefore.sha256 !== binding.packetSha256)) refuse('retained_input_mismatch');
  const historicalInput = binding ? retainedHistoricalInput(retainedBefore!.text, {
    gitCommonDir: common, target: options.target, headSha: launch.headSha, baseSha: options.baseSha,
    attempt: launch.attempt, round: launch.round, ...(state.cycle ? { cycleId: state.cycle.id } : {}),
    guardedInput: options.guardedInput,
  }, binding.packetSha256) : currentInput;
  if (binding && !cycleBacked &&
      !isDeepStrictEqual(historicalInput.retained, currentInput.retained)) {
    refuse('retained_input_mismatch');
  }
  if (launch.inputSha256 !== historicalInput.inputSha256()) refuse('input_mismatch');

  const snapshot = cycleBacked
    ? await snapshotAsyncHistory(options.asyncStoreDir, options.asyncTargetKey,
      Math.max(MAX_ASYNC_CALLS_PER_ROUND, (attempts.attemptsUsed + 1) * MAX_ASYNC_CALLS_PER_ROUND))
    : await snapshotAsyncResults(options.asyncStoreDir, options.asyncTargetKey);
  const identity = (item: { model: string; role: string; provider?: string }) =>
    JSON.stringify([item.model, item.role, item.provider]);
  const historicalRoster = Array.isArray(historicalInput.input.roster)
    ? historicalInput.input.roster.filter(item => item && typeof item === 'object' &&
      (item as Record<string, unknown>).lane === 'async') as Array<{ model: string; role: string; provider?: string }>
    : [];
  const expected = (cycleBacked ? historicalRoster : options.asyncDescriptors).map(identity).sort();
  const actual = snapshot.reviews.map(identity).sort();
  if (cycleBacked
    ? actual.some(item => !expected.includes(item))
    : expected.length !== actual.length || expected.some((item, index) => item !== actual[index])) {
    refuse('async_identity_mismatch');
  }
  const retainedAsync = snapshot.reviews.map((review, index) => ({
    sha256: snapshot.artifacts[index]!.sha256, model: review.model, role: review.role,
    provider: review.provider!, lane: 'async' as const,
  }));
  const retainedAsyncSha256 = retainedAsync.map(item => item.sha256).sort();
  const candidate: OrdinaryPendingPackage = {
    guardedInputRepresentation: { version: 1, encoding: 'json-string-table-v1' },
    ...(cycleBacked ? { version: 2 as const, cycle: state.cycle,
    attemptCap: attempts.cap, roundCap: state.roundCap, attemptsUsed: attempts.attemptsUsed,
    asyncAttribution: 'cycle-history-unattributed' as const } : {}),
    target: options.target, headSha: launch.headSha,
    baseSha: options.baseSha, attempt: launch.attempt, round: launch.round, pid: launch.pid,
    retainedAsyncSha256, retainedAsync, guardedInput: historicalInput.retained };
  // Canonical JSON drops undefined optional properties exactly as the original
  // guarded-input hash did; it never adds an artificial null spec binding.
  const packet = validateOrdinaryPendingPackage(candidate,
    { ...candidate, inputSha256: launch.inputSha256 }, historicalInput);
  const [nativeAfter, attemptsAfter, asyncAfter] = await Promise.all([
    readStable(nativePath), readStable(attemptPath),
    cycleBacked
      ? snapshotAsyncHistory(options.asyncStoreDir, options.asyncTargetKey,
        Math.max(MAX_ASYNC_CALLS_PER_ROUND, (attempts.attemptsUsed + 1) * MAX_ASYNC_CALLS_PER_ROUND), retainedAsyncSha256)
      : snapshotAsyncResults(options.asyncStoreDir, options.asyncTargetKey, [], retainedAsyncSha256),
  ]);
  if (nativeAfter.sha256 !== nativeBefore.sha256 || attemptsAfter.sha256 !== attemptsBefore.sha256 ||
      asyncAfter.artifacts.some((item, index) => item.path !== snapshot.artifacts[index]?.path) || ownerAlive(launch.pid)) refuse('state_changed');
  if (retainedBefore && (await readStable(retainedPath!, MAX_GUARDED_INPUT_CAPACITY.retainedBytes)).sha256 !== retainedBefore.sha256) refuse('state_changed');
  const bytes = serializeRecoveryDocument(packet, ordinaryPendingPackageByteLimit(packet.guardedInput));
  if (!options.preview) await writeExclusiveBytes(outputPath, bytes);
  return { mode: options.preview ? 'pending-package-preview' : 'pending-package-export', path: outputPath,
    packageSha256: sha256Hex(bytes), target: options.target, headSha: launch.headSha, baseSha: options.baseSha,
    baseBinding: retainedBefore ? 'retained-launch-inputs' : 'current-review-target', blockingOutcome: 'unknown',
    asyncBinding: 'retained-bytes-and-reviewer-identity', inputSha256: launch.inputSha256,
    attempt: launch.attempt, round: launch.round, pid: launch.pid, attemptsUsed: attempts.attemptsUsed,
    cap: attempts.cap, nativeStateSha256: nativeBefore.sha256, attemptStateSha256: attemptsBefore.sha256,
    retainedAsyncSha256, ...(state.cycle ? { cycleId: state.cycle.id,
      operationId: state.cycle.operationId, roundCap: state.roundCap } : {}) };
}
