import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { launchSchema, type GuardedLaunchState } from './launch-record.js';
import type { ConvergeRunState } from './run-state.js';
import { convergeAttemptStatePath, validateConvergeAttemptState } from './attempt-budget.js';
import { convergeRunStatePath } from './run-state.js';
import { stableStringify } from '../report/run-header.js';
import { readStable } from '../telemetry/recovery/files.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  version: z.literal(2),
  operation: z.literal('cycle-pending-finalize-only'),
  target: z.string().min(1),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  inputSha256: digest,
  sourceDigest: digest,
  migrationPackageSha256: digest,
  finalizedAttempt: z.number().int().positive().safe(),
  round: z.number().int().positive().safe(),
  originalPid: z.number().int().positive().safe(),
  attemptsUsed: z.number().int().positive().safe(),
  cap: z.number().int().positive().safe(),
  nextFreeAttempt: z.number().int().positive().safe(),
  blockingOutcome: z.literal('unknown'),
  cycleId: z.string().uuid(),
  operationId: z.string().uuid(),
  repo: z.string().min(1),
  prNumber: z.number().int().positive().safe(),
  attemptCap: z.number().int().positive().safe(),
  roundCap: z.number().int().positive().safe(),
  asyncAttribution: z.literal('cycle-history-unattributed'),
  retainedAsyncSha256: z.array(digest).min(1),
  sourceNativeStateSha256: digest,
  finalizedNativeStateSha256: digest,
  sourceAttemptStateSha256: digest,
  receiptDigest: digest,
}).strict();

/** Authenticate the one terminal transition that disposes an unknown cycle dispatch. */
export async function verifyCyclePendingFinalization(common: string, state: ConvergeRunState,
  launch: GuardedLaunchState): Promise<boolean> {
  const recovery = launch.pendingRecovery;
  const packageDigest = recovery?.migrationPackageSha256;
  if (!state.cycle || launch.status !== 'failed' || !recovery || !packageDigest) return false;
  try {
    const stored = await readStable(join(common, 'rcl-converge-pending-finalizations', packageDigest, 'receipt.json'));
    const receipt = receiptSchema.parse(JSON.parse(stored.text));
    const { receiptDigest, ...body } = receipt;
    if (receiptDigest !== createHash('sha256').update(stableStringify(body)).digest('hex') ||
        receipt.target !== state.target || receipt.headSha !== launch.headSha ||
        receipt.inputSha256 !== launch.inputSha256 || receipt.sourceDigest !== recovery.sourceDigest ||
        receipt.migrationPackageSha256 !== packageDigest || receipt.finalizedAttempt !== launch.attempt ||
        receipt.round !== launch.round || receipt.originalPid !== launch.pid ||
        receipt.attemptsUsed !== launch.attempt || receipt.nextFreeAttempt !== launch.attempt + 1 ||
        receipt.cap !== receipt.attemptCap || receipt.cycleId !== state.cycle.id ||
        receipt.operationId !== state.cycle.operationId || receipt.repo.toLowerCase() !== state.cycle.repo ||
        receipt.prNumber !== state.cycle.prNumber || receipt.roundCap !== state.roundCap ||
        receipt.sourceNativeStateSha256 !== recovery.nativeStateSha256 ||
        receipt.sourceAttemptStateSha256 !== recovery.attemptStateSha256 ||
        receipt.retainedAsyncSha256.join(',') !== [...recovery.retainedAsyncSha256].sort().join(',') ||
        new Set(receipt.retainedAsyncSha256).size !== receipt.retainedAsyncSha256.length) return false;
    const retainedRoot = join(common, 'rcl-converge-pending-finalizations', packageDigest);
    const [native, attempts, manifest, retainedAttempts, retainedNative] = await Promise.all([
      readStable(convergeRunStatePath(common, state.target)),
      readStable(convergeAttemptStatePath(common, state.target)),
      readStable(join(common, 'rcl-converge-pending-recovery', recovery.sourceDigest, 'manifest.json')),
      readStable(join(retainedRoot, 'source-attempt-state.json')),
      readStable(join(retainedRoot, 'finalized-native-state.json')),
    ]);
    if (native.sha256 !== receipt.finalizedNativeStateSha256 ||
        attempts.sha256 !== receipt.sourceAttemptStateSha256 ||
        retainedAttempts.sha256 !== receipt.sourceAttemptStateSha256 ||
        retainedNative.sha256 !== receipt.finalizedNativeStateSha256) return false;
    const sourceAttempts = validateConvergeAttemptState(
      JSON.parse(retainedAttempts.text), state.target, 'retained cycle pending attempt state');
    const finalizedState = JSON.parse(retainedNative.text) as ConvergeRunState;
    const finalizedLaunch = launchSchema.safeParse(finalizedState.lastLaunch);
    if (sourceAttempts.cap !== receipt.cap || sourceAttempts.attemptsUsed !== receipt.attemptsUsed ||
        !isDeepStrictEqual(sourceAttempts.cycle, state.cycle) ||
        sourceAttempts.attempts.at(-1)?.attempt !== receipt.finalizedAttempt ||
        sourceAttempts.attempts.at(-1)?.pid !== receipt.originalPid ||
        finalizedState.target !== state.target || finalizedState.roundCap !== receipt.roundCap ||
        !isDeepStrictEqual(finalizedState.cycle, state.cycle) || !finalizedLaunch.success ||
        !isDeepStrictEqual(finalizedLaunch.data, launch)) return false;
    const expectedManifest = { version: 1, sourceDigest: recovery.sourceDigest,
      blockingOutcome: 'unknown', artifacts: receipt.retainedAsyncSha256.map(sha256 => ({ sha256 })).sort((a, b) =>
        a.sha256.localeCompare(b.sha256)) };
    if (!isDeepStrictEqual(JSON.parse(manifest.text), expectedManifest)) return false;
    await Promise.all(receipt.retainedAsyncSha256.map(async sha256 => {
      if ((await readStable(join(common, 'rcl-converge-pending-recovery', recovery.sourceDigest, sha256))).sha256 !== sha256) {
        throw new Error('pending_finalization_artifact_mismatch');
      }
    }));
    return true;
  } catch {
    return false;
  }
}
