import { readStable } from '../telemetry/recovery/files.js';
import { writeExclusiveBytes } from '../evidence/original-run/journal.js';
import { checkDarwinLockACL } from '../evidence/original-run/lock-path.js';
import { lockSystemCommand } from '../evidence/original-run/lock-scope.js';
import { ReviewCycleRejected } from './cycle-remote.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { convergeAttemptStatePath, loadConvergeAttemptState, previewConvergeAttemptState, validateAttemptCap,
  DEFAULT_CONVERGE_ATTEMPT_CAP, type ConvergeAttemptState } from './attempt-budget.js';
import { convergeRunStatePath, initialConvergeRunState, loadConvergeRunState,
  validateRoundCap, DEFAULT_CONVERGE_ROUND_CAP } from './run-state.js';
import { ownedNativeTargetCommonDir, type NativeTargetOwnership } from './target-ownership.js';
import { syncNativeDirectory, writeNativeStateExclusive } from './native-lock.js';
import { cycleHistorySchema, nativeReviewCycleSchema, reviewCycleReceiptSchema,
  type NativeReviewCycle, type ReviewCycleRemote } from './review-cycle.js';

const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const snapshotSchema = z.object({ bytes: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable();
const archiveSchema = z.object({
  version: z.literal(1), target: z.string(), operationId: z.string().uuid(),
  files: z.object({ run: snapshotSchema, attempts: snapshotSchema, ledger: snapshotSchema }).strict(),
  history: cycleHistorySchema,
}).strict();
const operationSchema = z.object({
  version: z.literal(1), target: z.string(), operationId: z.string().uuid(),
  repo: z.string(), prNumber: z.number().int().positive(), url: z.string().url(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/), previousCycleId: z.string().uuid().nullable(),
  attemptCap: z.number().int().positive().safe(), roundCap: z.number().int().positive().safe(),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['prepared', 'recorded', 'active', 'rejected', 'terminal']),
  rejection: z.string().optional(),
  receipt: reviewCycleReceiptSchema.optional(),
}).strict();
type Operation = z.infer<typeof operationSchema>;
type Archive = z.infer<typeof archiveSchema>;

export interface FreshReviewOptions {
  gitCommonDir: string;
  target: string;
  headSha: string;
  remote: ReviewCycleRemote;
  ownership: NativeTargetOwnership;
  maxAttempts?: number;
  maxRounds?: number;
}
export interface FreshReviewOperation {
  cycle: NativeReviewCycle;
  operationId: string;
}

export function reviewCycleDirectory(common: string, target: string): string {
  return join(common, 'rcl-review-cycles', basename(convergeRunStatePath(common, target), '.json'));
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try { return (await readStable(path, 64 * 1024 * 1024)).raw; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function privateDirectory(path: string, strict = true): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await inspectDirectory(path, strict);
  await syncNativeDirectory(dirname(path));
}
async function inspectDirectory(path: string, strict = true): Promise<void> {
  const stat = await lstat(path);
  if (await realpath(path) !== path || !stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' &&
    (stat.uid !== process.geteuid?.() || (strict ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0)))) throw new Error('unsafe_review_cycle_directory');
  if (process.platform === 'darwin') checkDarwinLockACL(await lockSystemCommand('/bin/ls', ['-lde', path]));
}
async function replaceJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeNativeStateExclusive(temporary, value);
    await rename(temporary, path);
    await syncNativeDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}
async function snapshot(path: string): Promise<z.infer<typeof snapshotSchema>> {
  const bytes = await readOptional(path);
  return bytes ? { bytes: bytes.toString('base64'), sha256: hash(bytes) } : null;
}
async function currentOperation(directory: string, target: string): Promise<Operation | undefined> {
  try { await inspectDirectory(dirname(directory)); await inspectDirectory(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const pointer = await readOptional(join(directory, 'current.json'));
  if (!pointer) return undefined;
  const { operationId } = z.object({ operationId: z.string().uuid() }).strict().parse(JSON.parse(pointer.toString()));
  const operation = operationSchema.parse(JSON.parse((await readStable(join(directory, `${operationId}.json`), 64 * 1024)).text));
  if (operation.operationId !== operationId || operation.target !== target) throw new Error('fresh_review_operation_mismatch');
  return operation;
}

/** Capture the request generation before waiting for another launcher. */
export async function freshReviewRequestVersion(common: string, target: string): Promise<string | undefined> {
  const operation = await currentOperation(reviewCycleDirectory(common, target), target);
  return operation ? `${operation.operationId}:${operation.phase}` : undefined;
}

/** A durably completed first dispatch needs no new provider/output preflight. */
export async function freshReviewCompletionPending(common: string, target: string): Promise<boolean> {
  const operation = await currentOperation(reviewCycleDirectory(common, target), target);
  return operation?.phase === 'active' && (await loadConvergeRunState(common, target))?.lastLaunch?.status === 'completed';
}

/** A pending transition cannot be bypassed by an ordinary guarded continuation. */
export async function assertNoPendingFreshReview(common: string, target: string): Promise<void> {
  const operation = await currentOperation(reviewCycleDirectory(common, target), target);
  if (operation && operation.phase !== 'terminal') throw new Error('fresh_review_pending: resume the same review with --start-over');
}

/** Only the owning fresh guard may claim while its first dispatch is unfinished. */
export async function assertFreshReviewClaim(common: string, target: string, operationId?: string): Promise<void> {
  const operation = await currentOperation(reviewCycleDirectory(common, target), target);
  if (operationId !== undefined) {
    if (!operation || operation.operationId !== operationId || operation.phase !== 'active') throw new Error('fresh_review_operation_changed');
  } else if (operation && operation.phase !== 'terminal') {
    throw new Error('fresh_review_pending: resume the same review with --start-over');
  }
}

async function readArchive(directory: string, operation: Operation): Promise<Archive> {
  const bytes = (await readStable(join(directory, `${operation.operationId}.archive.json`), 64 * 1024 * 1024)).raw;
  if (hash(bytes) !== operation.archiveSha256) throw new Error('fresh_review_archive_changed');
  const archive = archiveSchema.parse(JSON.parse(bytes.toString()));
  if (archive.target !== operation.target || archive.operationId !== operation.operationId) throw new Error('fresh_review_archive_mismatch');
  for (const file of Object.values(archive.files)) {
    if (file && hash(Buffer.from(file.bytes, 'base64')) !== file.sha256) throw new Error('fresh_review_archive_changed');
  }
  return archive;
}

/** Verify history before any further spending, without rewriting its original bytes. */
export async function verifyReviewCycle(common: string, target: string, cycle: NativeReviewCycle): Promise<void> {
  nativeReviewCycleSchema.parse(cycle);
  const directory = reviewCycleDirectory(common, target);
  if (cycle.archivePath !== join(directory, `${cycle.operationId}.archive.json`)) throw new Error('fresh_review_archive_path_mismatch');
  await inspectDirectory(dirname(directory));
  await inspectDirectory(directory);
  const bytes = (await readStable(cycle.archivePath, 64 * 1024 * 1024)).raw;
  if (hash(bytes) !== cycle.archiveSha256) throw new Error('fresh_review_archive_changed');
  const archive = archiveSchema.parse(JSON.parse(bytes.toString()));
  if (archive.target !== target || archive.operationId !== cycle.operationId || !isDeepStrictEqual(archive.history, cycle.history)) {
    throw new Error('fresh_review_history_mismatch');
  }
}

/** Preflight and create/resume exactly one operation while the caller owns the native target. */
export async function prepareFreshReview(options: FreshReviewOptions): Promise<FreshReviewOperation> {
  const common = await ownedNativeTargetCommonDir(options.ownership, options.gitCommonDir, options.target);
  const directory = reviewCycleDirectory(common, options.target);
  const attemptCap = validateAttemptCap(options.maxAttempts ?? DEFAULT_CONVERGE_ATTEMPT_CAP);
  const roundCap = validateRoundCap(options.maxRounds ?? DEFAULT_CONVERGE_ROUND_CAP);
  let operation = await currentOperation(directory, options.target);
  if (!operation || operation.phase === 'terminal') {
    // Capability/access failure must leave the native budget and evidence untouched.
    const current = await options.remote.current();
    if (current) reviewCycleReceiptSchema.parse(current);
    const run = await loadConvergeRunState(common, options.target);
    const attempts = await previewConvergeAttemptState(common, options.target);
    if (!isDeepStrictEqual(run?.cycle, attempts?.cycle)) throw new Error('fresh_review_state_pair_mismatch');
    if (run?.cycle) await verifyReviewCycle(common, options.target, run.cycle);
    const history = cycleHistorySchema.parse({
      attempts: (run?.cycle?.history.attempts ?? 0) + (attempts?.attemptsUsed ?? 0),
      rounds: (run?.cycle?.history.rounds ?? 0) + (run?.rounds.length ?? 0),
      ...(run?.cycle?.history.incomplete || (attempts?.migratedAttempts ?? 0) > 0 || (run && run.rounds.length > 0 && !attempts) ? { incomplete: true } : {}),
    });
    const operationId = randomUUID();
    const ledger = /^[A-Za-z0-9._-]+$/.test(options.target)
      ? await snapshot(join(common, `rcl-converge-${options.target}-ledger.md`)) : null;
    const archive: Archive = { version: 1, target: options.target, operationId, history,
      files: { run: await snapshot(convergeRunStatePath(common, options.target)),
        attempts: await snapshot(convergeAttemptStatePath(common, options.target)), ledger } };
    await privateDirectory(dirname(directory));
    await privateDirectory(directory);
    const archivePath = join(directory, `${operationId}.archive.json`);
    await writeNativeStateExclusive(archivePath, archive);
    operation = { version: 1, target: options.target, operationId, repo: options.remote.repo.toLowerCase(),
      prNumber: options.remote.prNumber, url: options.remote.url, headSha: options.headSha,
      previousCycleId: current?.id ?? null, attemptCap, roundCap,
      archiveSha256: hash(await readFile(archivePath)), phase: 'prepared' };
    operationSchema.parse(operation);
    await replaceJson(join(directory, `${operationId}.json`), operation);
    await replaceJson(join(directory, 'current.json'), { operationId });
  }
  if (operation.repo !== options.remote.repo.toLowerCase() || operation.prNumber !== options.remote.prNumber ||
    operation.url !== options.remote.url ||
    (options.maxAttempts !== undefined && options.maxAttempts !== operation.attemptCap) ||
    (options.maxRounds !== undefined && options.maxRounds !== operation.roundCap)) throw new Error('fresh_review_operation_inputs_changed');
  const archive = await readArchive(directory, operation);
  if (operation.phase === 'rejected') {
    await restoreRejected(common, directory, operation, archive);
    throw new ReviewCycleRejected(operation.rejection ?? 'Fresh review was not created; repeat the explicit request when ready');
  }
  if (operation.phase === 'prepared') {
    // Attempt state goes first: older standalone claimers read only this file.
    await installBarrier(convergeAttemptStatePath(common, options.target), archive.files.attempts, operation, 3);
    await installBarrier(convergeRunStatePath(common, options.target), archive.files.run, operation, 2);
    let receipt;
    try {
      receipt = reviewCycleReceiptSchema.parse(await options.remote.start({ operation_id: operation.operationId,
        previous_cycle_id: operation.previousCycleId, head_sha: operation.headSha }));
    } catch (error) {
      if (error instanceof ReviewCycleRejected) {
        operation = { ...operation, phase: 'rejected', rejection: error.message };
        await replaceJson(join(directory, `${operation.operationId}.json`), operation);
        await restoreRejected(common, directory, operation, archive);
      }
      throw error;
    }
    if (receipt.operation_id !== operation.operationId || receipt.previous_cycle_id !== operation.previousCycleId ||
      receipt.head_sha !== operation.headSha) throw new Error('fresh_review_receipt_mismatch');
    operation = { ...operation, phase: 'recorded', receipt };
    await replaceJson(join(directory, `${operation.operationId}.json`), operation);
  }
  if (!operation.receipt) throw new Error('fresh_review_receipt_missing');
  const active = await options.remote.current();
  if (!active || !isDeepStrictEqual(reviewCycleReceiptSchema.parse(active), operation.receipt)) throw new Error('fresh_review_superseded');
  const cycle: NativeReviewCycle = { id: operation.receipt.id, operationId: operation.operationId,
    previousCycleId: operation.previousCycleId, repo: operation.repo, prNumber: operation.prNumber, url: operation.url,
    archivePath: join(directory, `${operation.operationId}.archive.json`), archiveSha256: operation.archiveSha256,
    history: archive.history };
  if (operation.phase === 'recorded') {
    const attempts: ConvergeAttemptState = { version: 3, cycle, target: options.target, cap: operation.attemptCap,
      migratedAttempts: 0, attemptsUsed: 0, attempts: [], updatedAt: new Date().toISOString() };
    await activate(convergeAttemptStatePath(common, options.target), attempts, operation);
    await activate(convergeRunStatePath(common, options.target), {
      ...initialConvergeRunState(options.target), version: 2, cycle, roundCap: operation.roundCap,
    }, operation);
    operation = { ...operation, phase: 'active' };
    await replaceJson(join(directory, `${operation.operationId}.json`), operation);
  }
  await assertReviewCyclePair(common, options.target, cycle);
  return { cycle, operationId: operation.operationId };
}

async function installBarrier(path: string, original: z.infer<typeof snapshotSchema>, operation: Operation, version: number): Promise<void> {
  await privateDirectory(dirname(path), false);
  const bytes = await readOptional(path);
  const barrier = { version, target: operation.target, startOverPending: operation.operationId };
  if (bytes && isDeepStrictEqual(JSON.parse(bytes.toString()), barrier)) return;
  if (original ? !bytes || hash(bytes) !== original.sha256 : bytes !== undefined) throw new Error('fresh_review_native_state_changed');
  await replaceJson(path, barrier);
}

async function activate(path: string, state: { cycle: NativeReviewCycle; [key: string]: unknown } | ConvergeAttemptState, operation: Operation): Promise<void> {
  const current = JSON.parse(await readFile(path, 'utf8')) as { target?: string; startOverPending?: string; cycle?: NativeReviewCycle };
  if (current.startOverPending === operation.operationId && current.target === operation.target) await replaceJson(path, state);
  else {
    // A crash can occur between the two activations. Accept the already-written
    // empty partner, but never erase claims made after activation.
    const { updatedAt: _currentTime, ...stored } = current as Record<string, unknown>;
    const { updatedAt: _newTime, ...expected } = state;
    if (!isDeepStrictEqual(stored, expected)) throw new Error('fresh_review_activation_changed');
  }
}

/** Mark a returned dispatch outcome terminal; a later explicit request may create another cycle. */
export async function finishFreshReview(common: string, target: string, operationId: string, ownership: NativeTargetOwnership): Promise<void> {
  common = await ownedNativeTargetCommonDir(ownership, common, target);
  const directory = reviewCycleDirectory(common, target);
  const operation = await currentOperation(directory, target);
  if (!operation || operation.operationId !== operationId || operation.phase !== 'active') throw new Error('fresh_review_operation_changed');
  await replaceJson(join(directory, `${operationId}.json`), { ...operation, phase: 'terminal' });
}

/** Neither a missing partner nor a legacy ledger may replenish a cycle's budget. */
export async function assertReviewCyclePair(common: string, target: string, expected: NativeReviewCycle | undefined): Promise<void> {
  const run = await loadConvergeRunState(common, target);
  const attempts = await loadConvergeAttemptState(common, target);
  if (!isDeepStrictEqual(run?.cycle, expected) || !isDeepStrictEqual(attempts?.cycle, expected)) {
    throw new Error('fresh_review_state_pair_mismatch');
  }
  if (expected) await verifyReviewCycle(common, target, expected);
}

/** Default retained outputs make the explicit command usable without bookkeeping flags. */
export async function freshReviewOutputPaths(common: string): Promise<{ jsonFile: string; markdown: string }> {
  const directory = join(common, 'rcl-fresh-reports');
  await privateDirectory(directory);
  const id = randomUUID();
  return { jsonFile: join(directory, `${id}.json`), markdown: join(directory, `${id}.md`) };
}

/** Roll back only a proven noncommit, retaining the archive and rejected operation. */
async function restoreRejected(common: string, directory: string, operation: Operation, archive: Archive): Promise<void> {
  for (const [path, original] of [
    [convergeRunStatePath(common, operation.target), archive.files.run],
    [convergeAttemptStatePath(common, operation.target), archive.files.attempts],
  ] as const) {
    const bytes = await readOptional(path);
    if (original ? bytes && hash(bytes) === original.sha256 : !bytes) continue;
    const current = bytes ? JSON.parse(bytes.toString()) : undefined;
    if (current?.startOverPending !== operation.operationId || current?.target !== operation.target) throw new Error('fresh_review_restore_changed');
    if (original) {
      const temp = `${path}.${randomUUID()}.tmp`;
      try { await writeExclusiveBytes(temp, Buffer.from(original.bytes, 'base64')); await rename(temp, path); }
      finally { await rm(temp, { force: true }); }
    } else await rm(path);
    await syncNativeDirectory(dirname(path));
  }
  await replaceJson(join(directory, `${operation.operationId}.json`), { ...operation, phase: 'terminal' });
}
