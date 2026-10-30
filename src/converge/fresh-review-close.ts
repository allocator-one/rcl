import { randomUUID } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { checkpointPath } from '../dispatch/checkpoint.js';
import { prepareLockRoot } from '../evidence/original-run/lock-path.js';
import { serializeRecoveryDocument, syncDirectory, writeExclusiveBytes } from '../evidence/original-run/journal.js';
import { readStable } from '../telemetry/recovery/files.js';
import { convergeAttemptStatePath, loadConvergeAttemptState } from './attempt-budget.js';
import { closeDiedFreshReview, readFreshReviewOperation, reviewCycleDirectory } from './fresh-review.js';
import { ordinaryCheckpointNamespace } from './launch-guard.js';
import { inspectProcessIdentity, processIdentitySchema, type ProcessIdentityStatus } from './process-identity.js';
import { convergeRunStatePath, loadConvergeRunState } from './run-state.js';
import { withRecoveryTarget } from './target-ownership.js';

/**
 * An audited close of a fresh-review operation whose launch died before the
 * council wrote anything (RCL-216).
 *
 * Such an operation stays `active` for good: `converge-gap` needs an original
 * report and run that never existed, an ordinary round refuses while the
 * operation is pending, and `--start-over` resumes it. The close proves, from
 * the target's own native state, that nothing was produced: the operation is
 * active, its cycle admitted no round, its last launch is still pending with
 * no run, report or recovery, the exact process that claimed it is dead, and
 * the launch's council journal holds no reviewer result. The preview pins all
 * of that in a manifest; the apply re-proves it on the same bytes, retains
 * them, and marks the operation terminal with a reference to the audit. No
 * round, finding, verdict or attempt is created or released: the spent
 * attempt stays spent, and the cycle's accounting becomes history for the
 * next explicitly requested fresh review.
 */

const MAX_MANIFEST = 256 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({ path: z.string().min(1), sha256: digest, bytes: z.number().int().nonnegative().safe() }).strict();

export const freshReviewCloseManifestSchema = z.object({
  kind: z.literal('rcl-fresh-review-close'),
  version: z.literal(1),
  auditId: z.string().uuid(),
  createdAt: z.string().datetime(),
  gitCommonDir: z.string().min(1),
  target: z.string().min(1).max(200),
  freshOperationId: z.string().uuid(),
  cycleId: z.string().uuid(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  operation: sourceSchema,
  run: sourceSchema,
  attempts: sourceSchema,
  launch: z.object({
    attempt: z.number().int().positive().safe(),
    round: z.number().int().positive().safe(),
    startedAt: z.string().datetime(),
    pid: z.number().int().positive().safe(),
    processIdentity: processIdentitySchema,
  }).strict(),
  evidence: z.object({
    process: z.literal('dead'),
    admittedRounds: z.literal(0),
    checkpoint: z.object({ path: z.string().min(1), present: z.boolean(), results: z.literal(0),
      events: z.number().int().nonnegative().safe() }).strict(),
  }).strict(),
  disposition: z.object({ kind: z.literal('died_before_report'), accounting: z.literal('unchanged'),
    scope: z.literal('local operation close; no admission or approval') }).strict(),
}).strict();
export type FreshReviewCloseManifest = z.infer<typeof freshReviewCloseManifestSchema>;

export interface FreshReviewCloseSelection { target: string; operationId: string }
export interface FreshReviewCloseIO { inspectProcess?: (identity: z.infer<typeof processIdentitySchema>) => Promise<ProcessIdentityStatus> }

const fail = (code: string): never => { throw new Error(code); };
const source = (path: string, snap: { sha256: string; raw: Buffer }) => ({ path, sha256: snap.sha256, bytes: snap.raw.length });

async function entries(path: string): Promise<string[] | undefined> {
  try { return (await readdir(path)).filter(name => !name.startsWith('.')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Everything the close rests on, read from the target's current native files. */
async function observe(commonDir: string, selection: FreshReviewCloseSelection, io: FreshReviewCloseIO) {
  const { target, operationId } = selection;
  const current = await readFreshReviewOperation(commonDir, target);
  if (!current || current.operation.operationId !== operationId) fail('fresh_close_operation_not_current');
  const operation = current!.operation;
  if (operation.phase !== 'active' || !operation.receipt) fail('fresh_close_operation_not_active');
  const runPath = convergeRunStatePath(commonDir, target), attemptsPath = convergeAttemptStatePath(commonDir, target);
  const runBytes = await readStable(runPath), attemptBytes = await readStable(attemptsPath);
  const run = await loadConvergeRunState(commonDir, target), attempts = await loadConvergeAttemptState(commonDir, target);
  if (!run || !attempts) fail('fresh_close_state_missing');
  if (run!.cycle?.operationId !== operationId || attempts!.cycle?.operationId !== operationId ||
    run!.cycle.id !== operation.receipt!.id || !isDeepStrictEqual(run!.cycle, attempts!.cycle)) fail('fresh_close_cycle_mismatch');
  if (run!.rounds.length !== 0) fail('fresh_close_round_admitted');
  const launch = run!.lastLaunch;
  if (!launch || launch.status !== 'pending') fail('fresh_close_launch_not_pending');
  if (launch!.runId || launch!.reportJsonSha256 || launch!.retainedOriginal || launch!.pendingResume ||
    launch!.pendingRecovery || launch!.recovery) fail('fresh_close_launch_has_work');
  if (launch!.headSha !== operation.headSha) fail('fresh_close_launch_head_mismatch');
  if (!launch!.processIdentity) fail('fresh_close_process_unverifiable');
  // The dead launch must hold the cycle's latest claim: a later attempt may
  // have produced work this close would not see.
  const claim = attempts!.attempts.find(record => record.attempt === launch!.attempt);
  if (!claim || attempts!.attemptsUsed !== launch!.attempt) fail('fresh_close_attempt_not_latest');
  const status = await (io.inspectProcess ?? inspectProcessIdentity)(launch!.processIdentity!).catch(() => 'unverifiable' as const);
  if (status === 'alive') fail('fresh_close_process_alive');
  if (status !== 'dead') fail('fresh_close_process_unverifiable');
  // The council journals every reviewer result before anything is reported;
  // an empty (or never created) journal is the proof that nothing was produced.
  // Without the launch's packet binding there is no journal to inspect, and
  // so no proof.
  if (!launch!.ordinaryInputs) fail('fresh_close_journal_unknown');
  const checkpoint = checkpointPath(commonDir, target, ordinaryCheckpointNamespace(launch!.ordinaryInputs!.packetSha256));
  const results = await entries(join(checkpoint, 'results'));
  const events = await entries(join(checkpoint, 'events'));
  if (results && results.length) fail('fresh_close_results_present');
  return { operation, operationPath: current!.path, operationBytes: await readStable(current!.path, 64 * 1024),
    runPath, runBytes, attemptsPath, attemptBytes, launch: launch!,
    checkpoint: { path: checkpoint, present: results !== undefined, results: 0 as const, events: events?.length ?? 0 } };
}

/** Read-only preview of a close; the only identity it introduces is the audit's own. */
export async function previewFreshReviewClose(selection: FreshReviewCloseSelection, gitCommonDir: string,
  io: FreshReviewCloseIO = {}): Promise<FreshReviewCloseManifest> {
  const parsed = z.object({ target: z.string().min(1).max(200).refine(value => value.trim() === value),
    operationId: z.string().uuid() }).strict().safeParse(selection);
  if (!parsed.success) fail('invalid_fresh_close_selection');
  const commonDir = await realpath(resolve(gitCommonDir));
  const seen = await observe(commonDir, parsed.data!, io);
  return freshReviewCloseManifestSchema.parse({
    kind: 'rcl-fresh-review-close', version: 1, auditId: randomUUID(), createdAt: new Date().toISOString(),
    gitCommonDir: commonDir, target: parsed.data!.target, freshOperationId: seen.operation.operationId,
    cycleId: seen.operation.receipt!.id, headSha: seen.operation.headSha,
    operation: source(seen.operationPath, seen.operationBytes), run: source(seen.runPath, seen.runBytes),
    attempts: source(seen.attemptsPath, seen.attemptBytes),
    launch: { attempt: seen.launch.attempt, round: seen.launch.round, startedAt: seen.launch.startedAt,
      pid: seen.launch.pid, processIdentity: seen.launch.processIdentity },
    evidence: { process: 'dead', admittedRounds: 0, checkpoint: seen.checkpoint },
    disposition: { kind: 'died_before_report', accounting: 'unchanged', scope: 'local operation close; no admission or approval' },
  });
}

/** Where a close retains its manifest and the exact native bytes it rested on. */
export function freshReviewCloseAuditPath(commonDir: string, target: string, auditId: string): string {
  if (!z.string().uuid().safeParse(auditId).success) fail('invalid_fresh_close_audit');
  return join(reviewCycleDirectory(commonDir, target), 'closures', auditId);
}

async function retain(path: string, bytes: Buffer): Promise<void> {
  try { await writeExclusiveBytes(path, bytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await readStable(path, MAX_MANIFEST)).raw.equals(bytes)) fail('fresh_close_retained_conflict');
  }
}

export interface ApplyFreshReviewCloseOptions { manifest: string; manifestSha256: string }

/**
 * Apply a reviewed manifest: under recovery ownership of the target, prove the
 * same facts on the same bytes, retain them, then mark the operation terminal.
 * Re-applying a completed close answers `already_closed` and changes nothing.
 */
export async function applyFreshReviewClose(input: ApplyFreshReviewCloseOptions, gitCommonDir: string,
  io: FreshReviewCloseIO = {}): Promise<'closed' | 'already_closed'> {
  const pinned = z.object({ manifest: z.string().min(1), manifestSha256: digest }).strict().safeParse(input);
  if (!pinned.success) fail('invalid_fresh_close_apply_selection');
  const original = await readStable(pinned.data!.manifest, MAX_MANIFEST);
  if (original.sha256 !== pinned.data!.manifestSha256) fail('fresh_close_manifest_digest_mismatch');
  let manifest: FreshReviewCloseManifest;
  try { manifest = freshReviewCloseManifestSchema.parse(JSON.parse(original.text)); }
  catch { return fail('invalid_fresh_close_manifest'); }
  const commonDir = await realpath(resolve(gitCommonDir));
  if (commonDir !== manifest.gitCommonDir) fail('fresh_close_repository_changed');
  const closure = { kind: 'died_before_report' as const, auditId: manifest.auditId, manifestSha256: original.sha256 };
  return withRecoveryTarget(commonDir, manifest.target, async ownership => {
    const current = await readFreshReviewOperation(commonDir, manifest.target);
    if (current?.operation.operationId === manifest.freshOperationId && current.operation.phase === 'terminal' &&
      isDeepStrictEqual(current.operation.closure, closure)) return 'already_closed';
    const seen = await observe(commonDir, { target: manifest.target, operationId: manifest.freshOperationId }, io);
    const now = { operation: source(seen.operationPath, seen.operationBytes), run: source(seen.runPath, seen.runBytes),
      attempts: source(seen.attemptsPath, seen.attemptBytes) };
    if (!isDeepStrictEqual(now, { operation: manifest.operation, run: manifest.run, attempts: manifest.attempts }) ||
      seen.operation.receipt!.id !== manifest.cycleId || !isDeepStrictEqual(seen.checkpoint, manifest.evidence.checkpoint) ||
      !isDeepStrictEqual(seen.launch.processIdentity, manifest.launch.processIdentity)) fail('fresh_close_state_changed');
    const audit = freshReviewCloseAuditPath(commonDir, manifest.target, manifest.auditId);
    await prepareLockRoot(join(audit, '..'));
    await prepareLockRoot(audit);
    await retain(join(audit, 'manifest.json'), original.raw);
    await retain(join(audit, 'operation-before.json'), seen.operationBytes.raw);
    await retain(join(audit, 'run-before.json'), seen.runBytes.raw);
    await retain(join(audit, 'attempts-before.json'), seen.attemptBytes.raw);
    await syncDirectory(audit);
    // Nothing may have moved while the evidence was retained.
    if ((await readStable(seen.runPath)).sha256 !== manifest.run.sha256 ||
      (await readStable(seen.attemptsPath)).sha256 !== manifest.attempts.sha256) fail('fresh_close_state_changed');
    const result = await closeDiedFreshReview(commonDir, manifest.target, manifest.freshOperationId,
      manifest.operation.sha256, closure, ownership);
    await retain(join(audit, 'complete.json'), Buffer.from(serializeRecoveryDocument({ version: 1,
      auditId: manifest.auditId, manifestSha256: original.sha256, freshOperationId: manifest.freshOperationId,
      cycleId: manifest.cycleId, phase: 'terminal' })));
    return result;
  });
}
