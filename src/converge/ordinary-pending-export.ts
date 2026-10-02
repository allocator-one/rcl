import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { convergeAttemptStatePath, loadConvergeAttemptState } from './attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState } from './run-state.js';
import { launchSchema } from './launch-record.js';
import { validateOrdinaryPendingPackage, type OrdinaryPendingPackage } from './ordinary-pending-package.js';
import { snapshotAsyncResults } from '../dispatch/async-lane.js';
import { guardedInputSha256, sha256Hex } from '../report/run-header.js';
import { MAX_REPORT_BYTES, readStable } from '../telemetry/recovery/files.js';
import { serializeRecoveryDocument, syncDirectory, writeExclusive } from '../evidence/original-run/journal.js';

// Leave room for the recovery package's retained-async descriptors beneath
// the shared recovery reader ceiling (25 MiB). Apply this before any claim.
const MAX_RETAINED_INPUT_BYTES = 20 * 1024 * 1024;

interface OrdinaryLaunchInputs {
  gitCommonDir: string;
  target: string;
  headSha: string;
  baseSha: string | null;
  guardedInput: Record<string, unknown>;
  attempt: number;
  round: number;
  cycleId?: string;
  asyncDescriptors?: Array<{ model: string; role: string; provider: string }>;
}

function retainedInputsPath(options: Pick<OrdinaryLaunchInputs, 'gitCommonDir' | 'target' | 'attempt' | 'cycleId'> & { packetSha256: string }): string {
  const namespace = sha256Hex(JSON.stringify([options.target, options.cycleId ?? null]));
  return join(options.gitCommonDir, 'rcl-ordinary-inputs', `${namespace}-attempt-${options.attempt}-${options.packetSha256}.json`);
}

function retainedInputs(options: OrdinaryLaunchInputs) {
  return { version: 1, target: options.target, headSha: options.headSha, baseSha: options.baseSha,
    attempt: options.attempt, round: options.round, ...(options.cycleId ? { cycleId: options.cycleId } : {}),
    inputSha256: guardedInputSha256(options.guardedInput), guardedInput: options.guardedInput };
}

export interface RetainedOrdinaryInputs {
  path: string;
  sha256: string;
  baseSha: string | null;
}

/** Called under native target ownership before spending the claim or dispatching. */
export async function retainOrdinaryLaunchInputs(options: OrdinaryLaunchInputs): Promise<RetainedOrdinaryInputs> {
  const common = await realpath(options.gitCommonDir);
  const packet = retainedInputs(options);
  const bytes = serializeRecoveryDocument(packet, MAX_RETAINED_INPUT_BYTES);
  const descriptors = options.asyncDescriptors ?? [];
  // Recovery repeats the async reviewer identifiers alongside the guarded
  // roster. Bound that actual envelope before claim, including its future
  // fixed-length hashes and the largest permitted PID representation.
  const projectedRecovery: OrdinaryPendingPackage = {
    target: options.target, headSha: options.headSha, baseSha: options.baseSha ?? 'f'.repeat(40),
    attempt: options.attempt, round: options.round, pid: Number.MAX_SAFE_INTEGER,
    retainedAsyncSha256: descriptors.map(() => 'f'.repeat(64)),
    retainedAsync: descriptors.map(descriptor => ({ model: descriptor.model, role: descriptor.role,
      provider: descriptor.provider, lane: 'async', sha256: 'f'.repeat(64) })),
    guardedInput: options.guardedInput,
  };
  serializeRecoveryDocument(projectedRecovery, MAX_REPORT_BYTES);

  const packetSha256 = sha256Hex(bytes);
  // A preclaim crash leaves the ordinal unspent. Include the full packet so
  // a changed base (which the guarded-input digest omits) gets its own file.
  const path = retainedInputsPath({ ...options, gitCommonDir: common, packetSha256 });
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('ordinary_retained_input_directory_unsafe');
  // Only complete, fsynced bytes become a final capture. Interrupted staging
  // files remain private evidence and do not reserve the immutable final name.
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeExclusive(temporary, packet, MAX_RETAINED_INPUT_BYTES);
  try { await link(temporary, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readStable(path, MAX_RETAINED_INPUT_BYTES)).text !== bytes) throw new Error('ordinary_retained_input_mismatch');
    await readStable(path, MAX_RETAINED_INPUT_BYTES, { sync: true });
  }
  await syncDirectory(directory);
  await unlink(temporary);
  await syncDirectory(directory);
  await syncDirectory(common);
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

/**
 * Authenticate reconstructed ordinary inputs without locks, claims or native writes.
 * Historical launch digests did not include base: the receipt explicitly limits
 * that assertion to the caller's expected and currently resolved review target.
 * Async bytes are supplemental history, never durable blocking-call receipts.
 */
export async function exportOrdinaryPendingPackage(options: OrdinaryPendingExportOptions) {
  if (!/^[a-f0-9]{40}$/.test(options.baseSha) || options.baseSha !== options.expectedBaseSha) refuse('base_mismatch');
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
  if (!state?.lastLaunch || !attempts || state.cycle || attempts.cycle) refuse('ordinary_launch_required');
  const launch = launchSchema.parse(state.lastLaunch);
  const record = attempts.attempts.find(item => item.attempt === launch.attempt);
  if (launch.status !== 'pending' || launch.pendingResume || launch.retainedOriginal || launch.recovery ||
      launch.pendingRecovery || !record || record.pid !== launch.pid || record.retrySource ||
      record.boundFixRecoverySource || record.pendingRecoverySource ||
      launch.attempt !== attempts.attemptsUsed || launch.headSha !== options.headSha ||
      (options.expectedRound !== undefined && launch.round !== options.expectedRound) ||
      launch.inputSha256 !== guardedInputSha256(options.guardedInput)) refuse('input_mismatch');
  if (ownerAlive(launch.pid)) refuse('owner_alive');
  // Only a native marker proves which full packet preceded this claim.
  // Unmarked historical launches retain their explicit current-base limitation,
  // even if abandoned preclaim packets happen to exist in the capture directory.
  const binding = launch.ordinaryInputs;
  if (binding && binding.baseSha !== options.baseSha) refuse('retained_base_mismatch');
  const retainedPath = binding ? retainedInputsPath({ gitCommonDir: common, target: options.target,
    attempt: launch.attempt, packetSha256: binding.packetSha256 }) : undefined;
  const retainedBefore = retainedPath ? await readStable(retainedPath, MAX_RETAINED_INPUT_BYTES) : undefined;
  if (binding && (!retainedBefore || retainedBefore.sha256 !== binding.packetSha256 ||
      retainedBefore.text !== serializeRecoveryDocument(retainedInputs({
        gitCommonDir: common, target: options.target, headSha: launch.headSha, baseSha: options.baseSha,
        attempt: launch.attempt, round: launch.round, guardedInput: options.guardedInput,
      }), MAX_RETAINED_INPUT_BYTES))) refuse('retained_input_mismatch');

  const snapshot = await snapshotAsyncResults(options.asyncStoreDir, options.asyncTargetKey);
  const identity = (item: { model: string; role: string; provider?: string }) =>
    JSON.stringify([item.model, item.role, item.provider]);
  const expected = options.asyncDescriptors.map(identity).sort();
  const actual = snapshot.reviews.map(identity).sort();
  if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index])) refuse('async_identity_mismatch');
  const retainedAsync = snapshot.reviews.map((review, index) => ({
    sha256: snapshot.artifacts[index]!.sha256, model: review.model, role: review.role,
    provider: review.provider!, lane: 'async' as const,
  }));
  const retainedAsyncSha256 = retainedAsync.map(item => item.sha256).sort();
  const candidate: OrdinaryPendingPackage = { target: options.target, headSha: launch.headSha,
    baseSha: options.baseSha, attempt: launch.attempt, round: launch.round, pid: launch.pid,
    retainedAsyncSha256, retainedAsync, guardedInput: options.guardedInput };
  // Canonical JSON drops undefined optional properties exactly as the original
  // guarded-input hash did; it never adds an artificial null spec binding.
  const packet = validateOrdinaryPendingPackage(JSON.parse(JSON.stringify(candidate)) as OrdinaryPendingPackage,
    { ...candidate, inputSha256: launch.inputSha256 });
  const [nativeAfter, attemptsAfter, asyncAfter] = await Promise.all([
    readStable(nativePath), readStable(attemptPath),
    snapshotAsyncResults(options.asyncStoreDir, options.asyncTargetKey, [], retainedAsyncSha256),
  ]);
  if (nativeAfter.sha256 !== nativeBefore.sha256 || attemptsAfter.sha256 !== attemptsBefore.sha256 ||
      asyncAfter.artifacts.some((item, index) => item.path !== snapshot.artifacts[index]?.path) || ownerAlive(launch.pid)) refuse('state_changed');
  if (retainedBefore && (await readStable(retainedPath!, MAX_RETAINED_INPUT_BYTES)).sha256 !== retainedBefore.sha256) refuse('state_changed');
  const bytes = serializeRecoveryDocument(packet, MAX_REPORT_BYTES);
  if (!options.preview) await writeExclusive(outputPath, packet, MAX_REPORT_BYTES);
  return { mode: options.preview ? 'pending-package-preview' : 'pending-package-export', path: outputPath,
    packageSha256: sha256Hex(bytes), target: options.target, headSha: launch.headSha, baseSha: options.baseSha,
    baseBinding: retainedBefore ? 'retained-launch-inputs' : 'current-review-target', blockingOutcome: 'unknown',
    asyncBinding: 'retained-bytes-and-reviewer-identity', inputSha256: launch.inputSha256,
    attempt: launch.attempt, round: launch.round, pid: launch.pid, attemptsUsed: attempts.attemptsUsed,
    cap: attempts.cap, nativeStateSha256: nativeBefore.sha256, attemptStateSha256: attemptsBefore.sha256,
    retainedAsyncSha256 };
}
