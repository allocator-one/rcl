import { retrySourceSchema, type RetrySource } from './retry-source.js';
import { boundFixRecoverySourceSchema, type BoundFixRecoverySource } from './bound-fix-recovery-source.js';
import { pendingRecoverySourceSchema, type PendingRecoverySource } from './pending-recovery-source.js';
import { isDeepStrictEqual } from 'node:util';
import { launchSchema, type GuardedLaunchState } from './launch-record.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ownedNativeTargetCommonDir, withNativeTarget, withOwnedNativeOperation, type NativeTargetOwnership } from './target-ownership.js';
import { validCycleVersion, type NativeReviewCycle } from './review-cycle.js';
import { RegistryCleanupError } from '../coordination/registry-lock.js';
import { captureCurrentProcessIdentity, inspectProcessIdentity, processIdentitySchema,
  type ProcessIdentity } from './process-identity.js';

export const DEFAULT_CONVERGE_ATTEMPT_CAP = 20;

const STATE_VERSION = 2;
const STATE_DIR = 'rcl-converge-attempts';
// The native target reservation now also bridges historical recovery clients
// for the whole critical section. A burst of normal starters may therefore
// wait behind valid work longer than the accounting lock's 5s retry bound.
const DEFAULT_TARGET_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;

const execFileAsync = promisify(execFile);

export interface ConvergeAttemptRecord {
  attempt: number;
  claimedAt: string;
  pid: number;
  processIdentity?: ProcessIdentity;
  source: 'claim';
  retrySource?: RetrySource;
  boundFixRecoverySource?: BoundFixRecoverySource;
  pendingRecoverySource?: PendingRecoverySource;
}

export interface ConvergeAttemptState {
  version: 2 | 3;
  cycle?: NativeReviewCycle;
  target: string;
  cap: number;
  migratedAttempts: number;
  attemptsUsed: number;
  attempts: ConvergeAttemptRecord[];
  updatedAt: string;
  lastLaunch?: GuardedLaunchState;
}

export interface ConvergeAttemptClaim {
  target: string;
  attempt: number;
  attemptsUsed: number;
  cap: number;
  stateFile: string;
  warning?: string;
  cycle?: NativeReviewCycle;
  processIdentity?: ProcessIdentity;
}

export class ConvergeAttemptBudgetExceededError extends Error {
  readonly code = 'RCL_CONVERGE_ATTEMPT_CAP';

  constructor(
    readonly target: string,
    readonly attemptsUsed: number,
    readonly cap: number
  ) {
    super(
      `Convergence attempt budget exhausted for ${target}: ${attemptsUsed}/${cap} attempts used. ` +
        'No provider calls were started. Ask the user whether to continue; only after explicit ' +
        'approval, retry with a higher --max-attempts value.'
    );
    this.name = 'ConvergeAttemptBudgetExceededError';
  }
}

/** A post-claim delivery failed after the attempt was durably consumed. */
export class ConvergeAttemptPostClaimError extends Error {
  constructor(readonly claim: ConvergeAttemptClaim, cause: unknown) {
    super(
      `Attempt ${claim.attempt}/${claim.cap} is durably recorded, but post-claim delivery failed: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Do not retry this claim.`,
      { cause }
    );
    this.name = 'ConvergeAttemptPostClaimError';
  }
}

export class ConvergeAttemptStateError extends Error {
  readonly code = 'RCL_CONVERGE_ATTEMPT_STATE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConvergeAttemptStateError';
  }
}

export function convergeAttemptErrorExitCode(err: unknown): 2 | 3 {
  return err instanceof ConvergeAttemptBudgetExceededError ? 2 : 3;
}

interface ClaimOptions {
  gitCommonDir: string;
  target: string;
  maxAttempts?: number;
  now?: () => Date;
  recordPid?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  /** Target ownership has a different contention profile from attempt accounting. */
  targetLockTimeoutMs?: number;
  targetLockRetryMs?: number;
  beforeClaim?: (ownership: NativeTargetOwnership) => Promise<void | {
    retrySource?: RetrySource;
    boundFixRecoverySource?: BoundFixRecoverySource;
    pendingRecoverySource?: PendingRecoverySource;
  }>;
  retrySource?: RetrySource;
  boundFixRecoverySource?: BoundFixRecoverySource;
  pendingRecoverySource?: PendingRecoverySource;
  afterClaim?: (claim: ConvergeAttemptClaim, ownership: NativeTargetOwnership) => Promise<void>;
  ownership?: NativeTargetOwnership;
  freshReviewOperation?: string;
}

interface AttemptLockOwner {
  pid: number;
  claimedAt: string;
  token: string;
}

interface AttemptLockSnapshot {
  owner: AttemptLockOwner;
  dev: bigint;
  ino: bigint;
}

function validateTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new ConvergeAttemptStateError('Convergence target must not be empty.');
  }
  return trimmed;
}

export function validateAttemptCap(maxAttempts: number): number {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new ConvergeAttemptStateError(
      'maxAttempts (--max-attempts) must be a positive safe integer.'
    );
  }
  return maxAttempts;
}

function stateBaseName(target: string): string {
  const slug = target.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const digest = createHash('sha256').update(target).digest('hex').slice(0, 16);
  return `${slug || 'target'}-${digest}`;
}

export function convergeAttemptStatePath(gitCommonDir: string, target: string): string {
  return join(resolve(gitCommonDir), STATE_DIR, `${stateBaseName(validateTarget(target))}.json`);
}

function isNodeError(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

export function validateConvergeAttemptState(value: unknown, expectedTarget: string, stateFile: string): ConvergeAttemptState {
  if (typeof value !== 'object' || value === null) {
    throw new ConvergeAttemptStateError(`Invalid convergence attempt state: ${stateFile}`);
  }

  const state = value as Partial<ConvergeAttemptState>;
  const attempts = state.attempts;
  if (
    !validCycleVersion(state, STATE_VERSION) ||
    state.target !== expectedTarget ||
    !Number.isSafeInteger(state.cap) ||
    (state.cap ?? 0) < 1 ||
    !Number.isSafeInteger(state.migratedAttempts) ||
    (state.migratedAttempts ?? -1) < 0 ||
    !Number.isSafeInteger(state.attemptsUsed) ||
    (state.attemptsUsed ?? -1) < 0 ||
    !Array.isArray(attempts) ||
    attempts.length + (state.migratedAttempts ?? 0) !== state.attemptsUsed ||
    typeof state.updatedAt !== 'string' ||
    attempts.some(
      (record, index) =>
        typeof record !== 'object' ||
        record === null ||
        record.attempt !== (state.migratedAttempts ?? 0) + index + 1 ||
        typeof record.claimedAt !== 'string' ||
        !Number.isInteger(record.pid) ||
        (record.processIdentity !== undefined &&
          (!processIdentitySchema.safeParse(record.processIdentity).success || record.processIdentity.pid !== record.pid)) ||
        record.source !== 'claim' ||
        (record.retrySource !== undefined && (!retrySourceSchema.safeParse(record.retrySource).success ||
          record.retrySource.attempt !== record.attempt - 1)) ||
        (record.boundFixRecoverySource !== undefined &&
          (!boundFixRecoverySourceSchema.safeParse(record.boundFixRecoverySource).success ||
            record.boundFixRecoverySource.attempt !== record.attempt - 1 ||
            record.boundFixRecoverySource.target !== expectedTarget || record.retrySource !== undefined ||
            record.pendingRecoverySource !== undefined)) ||
        (record.pendingRecoverySource !== undefined &&
          (!pendingRecoverySourceSchema.safeParse(record.pendingRecoverySource).success ||
            record.pendingRecoverySource.pendingAttempt !== record.attempt - 1 ||
            record.pendingRecoverySource.target !== expectedTarget ||
            record.retrySource !== undefined || record.boundFixRecoverySource !== undefined))
    )
  ) {
    throw new ConvergeAttemptStateError(
      `Invalid convergence attempt state in ${stateFile}; refusing to reset the safety budget.`
    );
  }

  if (state.lastLaunch !== undefined) {
    const launch = launchSchema.safeParse(state.lastLaunch);
    if (!launch.success || !attempts.some(record =>
      record.attempt === launch.data.attempt && record.pid === launch.data.pid)) {
      throw new ConvergeAttemptStateError(`Invalid guarded launch in convergence attempt state: ${stateFile}`);
    }
    const launchAttempt = attempts.find(record => record.attempt === launch.data.attempt);
    if ((launchAttempt?.processIdentity !== undefined || launch.data.processIdentity !== undefined) &&
      !isDeepStrictEqual(launchAttempt?.processIdentity, launch.data.processIdentity)) {
      throw new ConvergeAttemptStateError(`Guarded launch process identity does not match its attempt owner: ${stateFile}`);
    }
  }

  return state as ConvergeAttemptState;
}

async function stateFromExistingLedger(
  gitCommonDir: string,
  target: string,
  timestamp: string
): Promise<ConvergeAttemptState | undefined> {
  // The skill already restricts TARGET to this alphabet. For a direct CLI
  // caller with another shape, skip migration rather than deriving a path
  // from untrusted input; the hashed machine-state path remains safe.
  if (!/^[A-Za-z0-9._-]+$/.test(target)) return undefined;

  const ledgerFile = join(resolve(gitCommonDir), `rcl-converge-${target}-ledger.md`);
  let ledger: string;
  try {
    ledger = await readFile(ledgerFile, 'utf8');
  } catch (err) {
    if (isNodeError(err, 'ENOENT')) return undefined;
    throw new ConvergeAttemptStateError(`Could not read existing convergence ledger: ${ledgerFile}`, {
      cause: err,
    });
  }

  let attemptsUsed = 0;
  for (const match of ledger.matchAll(/^## Round\s+(\d+)\b/gm)) {
    const round = Number(match[1]);
    if (!Number.isSafeInteger(round) || round < 1) {
      throw new ConvergeAttemptStateError(
        `Invalid round number in existing convergence ledger: ${ledgerFile}`
      );
    }
    attemptsUsed = Math.max(attemptsUsed, round);
  }
  if (attemptsUsed === 0) return undefined;

  return {
    version: STATE_VERSION,
    target,
    cap: DEFAULT_CONVERGE_ATTEMPT_CAP,
    migratedAttempts: attemptsUsed,
    attemptsUsed,
    attempts: [],
    updatedAt: timestamp,
  };
}

async function readState(stateFile: string, target: string): Promise<ConvergeAttemptState | undefined> {
  let raw: string;
  try {
    raw = await readFile(stateFile, 'utf8');
  } catch (err) {
    if (isNodeError(err, 'ENOENT')) return undefined;
    throw new ConvergeAttemptStateError(`Could not read convergence attempt state: ${stateFile}`, {
      cause: err,
    });
  }

  try {
    return validateConvergeAttemptState(JSON.parse(raw), target, stateFile);
  } catch (err) {
    if (err instanceof ConvergeAttemptStateError) throw err;
    throw new ConvergeAttemptStateError(
      `Invalid JSON in ${stateFile}; refusing to reset the safety budget.`,
      { cause: err }
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isNodeError(err, 'ESRCH')) return false;
    if (isNodeError(err, 'EPERM')) return true;
    throw err;
  }
}

function parseLockOwner(raw: string): AttemptLockOwner | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<AttemptLockOwner> | null;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Number.isInteger(parsed.pid) &&
      (parsed.pid ?? 0) > 0 &&
      typeof parsed.claimedAt === 'string' &&
      typeof parsed.token === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        parsed.token
      )
    ) {
      return parsed as AttemptLockOwner;
    }
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  return undefined;
}

async function readLockSnapshot(lockFile: string): Promise<AttemptLockSnapshot | undefined> {
  let handle;
  try {
    handle = await open(lockFile, 'r');
  } catch (err) {
    if (
      isNodeError(err, 'ENOENT') ||
      isNodeError(err, 'EISDIR') ||
      isNodeError(err, 'EPERM')
    ) {
      return undefined;
    }
    throw err;
  }

  let raw: string;
  let stats;
  let primaryError: unknown;
  try {
    raw = await handle.readFile('utf8');
    stats = await handle.stat({ bigint: true });
  } catch (err) {
    primaryError = err;
    if (isNodeError(err, 'EISDIR') || isNodeError(err, 'ENOTDIR')) return undefined;
    throw err;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError === undefined) throw closeError;
    }
  }

  const owner = parseLockOwner(raw);
  return owner ? { owner, dev: stats.dev, ino: stats.ino } : undefined;
}

async function lockPathExists(lockFile: string): Promise<boolean> {
  try {
    await lstat(lockFile);
    return true;
  } catch (err) {
    if (isNodeError(err, 'ENOENT')) return false;
    throw err;
  }
}

async function isPublicationContention(err: unknown, destination: string): Promise<boolean> {
  if (isNodeError(err, 'EEXIST') || isNodeError(err, 'ENOTEMPTY')) return true;
  // Windows can report an existing destination as EPERM or EACCES. Treat
  // those as contention only when the destination now exists;
  // a genuine permission failure on an absent path remains infrastructure
  // failure and must fail closed.
  return (
    (isNodeError(err, 'EPERM') || isNodeError(err, 'EACCES')) &&
    (await lockPathExists(destination))
  );
}

async function tryAcquireOwnedLock(lockFile: string, owner: AttemptLockOwner): Promise<boolean> {
  // Fully write a private regular file, then atomically hard-link it into the
  // canonical path. link(2) never replaces an existing file *or directory*,
  // so this remains safe while an older mkdir-based client is in flight.
  const claimFile = `${lockFile}.claim.${process.pid}.${randomUUID()}`;
  let primaryError: unknown;
  let published = false;
  try {
    await writeFile(claimFile, `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await link(claimFile, lockFile);
    } catch (err) {
      if (await isPublicationContention(err, lockFile)) return false;
      throw err;
    }
    published = true;
    return true;
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      await rm(claimFile, { force: true });
    } catch (cleanupError) {
      // Once linked, the canonical inode is complete and authoritative; an
      // orphaned private hard link is harmless and must not negate success.
      if (!published && primaryError === undefined) throw cleanupError;
    }
  }
}

async function pathMatchesSnapshot(
  path: string,
  snapshot: AttemptLockSnapshot
): Promise<boolean> {
  try {
    const stats = await lstat(path, { bigint: true });
    return stats.dev === snapshot.dev && stats.ino === snapshot.ino;
  } catch (err) {
    if (isNodeError(err, 'ENOENT')) return false;
    throw err;
  }
}

async function reclaimStaleLock(
  lockFile: string,
  staleSnapshot: AttemptLockSnapshot
): Promise<boolean> {
  const current = await readLockSnapshot(lockFile);
  if (
    !current ||
    current.owner.token !== staleSnapshot.owner.token ||
    current.dev !== staleSnapshot.dev ||
    current.ino !== staleSnapshot.ino ||
    processIsAlive(current.owner.pid)
  ) {
    return false;
  }

  // Exactly one reclaimer can create this generation's hard-link tombstone.
  // Every delayed peer sees EEXIST and is forbidden from unlinking canonical,
  // so it can never remove a newer generation that appeared later.
  const staleFile = `${lockFile}.stale.${current.owner.token}`;
  try {
    await link(lockFile, staleFile);
  } catch (err) {
    if (isNodeError(err, 'ENOENT') || (await isPublicationContention(err, staleFile))) return false;
    throw err;
  }

  const stillCanonical = await pathMatchesSnapshot(lockFile, current);
  const ownsTombstone = await pathMatchesSnapshot(staleFile, current);
  if (!stillCanonical || !ownsTombstone || processIsAlive(current.owner.pid)) {
    await rm(staleFile, { force: true });
    return !stillCanonical;
  }

  try {
    await unlink(lockFile);
  } catch (err) {
    if (!isNodeError(err, 'ENOENT')) throw err;
  }
  // Inode comparison makes even an arbitrarily delayed reclaimer safe after
  // this point, so the tombstone can be removed without reopening the race.
  try {
    await rm(staleFile, { force: true });
  } catch {
    // A leftover hard link is harmless and generation-scoped.
  }
  return true;
}

async function acquireOwnedLock(
  lockFile: string,
  timeoutMs: number,
  retryMs: number,
  owner: AttemptLockOwner
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let waitMs = Math.max(1, retryMs);
  while (true) {
    // These reads choose between acquire, reclaim, and fail-closed waiting;
    // they do not provide mutual exclusion. Exclusive hard-link publication
    // and the generation tombstone are the serialization primitives.
    const current = await readLockSnapshot(lockFile);
    if (current && !processIsAlive(current.owner.pid)) {
      if (await reclaimStaleLock(lockFile, current)) {
        continue;
      }
    } else if (!current && !(await lockPathExists(lockFile))) {
      if (await tryAcquireOwnedLock(lockFile, owner)) return;
    }

    if (Date.now() >= deadline) {
      throw new ConvergeAttemptStateError(
        `Timed out waiting for convergence attempt lock: ${lockFile}. ` +
          'Refusing to start provider calls while accounting is uncertain. ' +
          'If no live converge-attempt process owns it, move or remove that lock path and retry.'
      );
    }
    await delay(Math.min(waitMs, Math.max(1, deadline - Date.now())));
    waitMs = Math.min(waitMs * 2, 250);
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory handles that Node can fsync. The state
  // file itself is still flushed before the atomic rename; POSIX platforms
  // additionally flush the directory entry here.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  let primaryError: unknown;
  try {
    await directory.sync();
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      await directory.close();
    } catch (closeError) {
      if (primaryError === undefined) throw closeError;
    }
  }
}

async function writeStateAtomically(stateFile: string, state: ConvergeAttemptState): Promise<void> {
  const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  let primaryError: unknown;
  let renamed = false;
  try {
    const tempHandle = await open(tempFile, 'wx', 0o600);
    let tempHandleError: unknown;
    try {
      await tempHandle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await tempHandle.sync();
    } catch (err) {
      tempHandleError = err;
      throw err;
    } finally {
      try {
        await tempHandle.close();
      } catch (closeError) {
        if (tempHandleError === undefined) throw closeError;
      }
    }
    await rename(tempFile, stateFile);
    renamed = true;
    // fsyncing the file before rename makes its contents durable; syncing the
    // parent directory makes the atomic name replacement durable too.
    await syncDirectory(dirname(stateFile));
  } catch (err) {
    primaryError =
      renamed && !(err instanceof ConvergeAttemptStateError)
        ? new ConvergeAttemptStateError(
            `Attempt state was replaced but its directory durability sync failed: ${stateFile}. ` +
              'Treat the attempt as spent and do not retry automatically.',
            { cause: err }
          )
        : err;
    throw primaryError;
  } finally {
    try {
      await rm(tempFile, { force: true });
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
    }
  }
}

async function releaseOwnedLock(lockFile: string, owner: AttemptLockOwner): Promise<void> {
  const current = await readLockSnapshot(lockFile);
  if (!current || current.owner.token !== owner.token) {
    throw new ConvergeAttemptStateError(
      `Convergence attempt lock ownership changed unexpectedly: ${lockFile}. ` +
        'Refusing to remove a lock that may belong to another process.'
    );
  }
  const releasedFile = `${lockFile}.released.${owner.token}`;
  await rename(lockFile, releasedFile);
  // The canonical lock is already gone. A cleanup failure leaves only a
  // harmless generation-scoped artifact and must not turn a recorded claim
  // into a reported failure that an agent might retry.
  try {
    await rm(releasedFile, { force: true });
  } catch {
    // Intentionally retained for later manual cleanup.
  }
}

/**
 * Atomically consume one convergence attempt before a council process starts.
 * The claim is intentionally outcome-blind: once returned, a failed launch,
 * timeout, kill, missing report, or inconclusive review has still spent the
 * attempt. This makes the cost ceiling independent of agent bookkeeping.
 */
export async function claimConvergeAttempt(options: ClaimOptions): Promise<ConvergeAttemptClaim> {
  // Callers can retain and mutate their options object while this invocation
  // waits for target ownership. Capture every input before that first await so
  // the state claim cannot escape the lock selected for this operation.
  const claimOptions: ClaimOptions = {
    gitCommonDir: options.gitCommonDir,
    target: validateTarget(options.target),
    maxAttempts: options.maxAttempts,
    now: options.now,
    recordPid: options.recordPid,
    lockTimeoutMs: options.lockTimeoutMs,
    lockRetryMs: options.lockRetryMs,
    targetLockTimeoutMs: options.targetLockTimeoutMs,
    targetLockRetryMs: options.targetLockRetryMs,
    beforeClaim: options.beforeClaim,
    afterClaim: options.afterClaim,
    ownership: options.ownership,
    freshReviewOperation: options.freshReviewOperation,
    pendingRecoverySource: options.pendingRecoverySource,
  };
  if (claimOptions.freshReviewOperation && !claimOptions.ownership) throw new Error('fresh_review_owner_required');
  // Use one canonical directory for both target ownership and state paths.
  // The caller's textual symlink must not be resolved once for a lock and
  // later again for a state write after it has been retargeted.
  claimOptions.gitCommonDir = await realpath(resolve(claimOptions.gitCommonDir));
  const { gitCommonDir, target } = claimOptions;
  if (claimOptions.maxAttempts !== undefined) validateAttemptCap(claimOptions.maxAttempts);
  let committed: ConvergeAttemptClaim | undefined;
  try {
    const work = async (ownership: NativeTargetOwnership) => {
      const source = await claimOptions.beforeClaim?.(ownership);
      if (source?.retrySource !== undefined) claimOptions.retrySource = retrySourceSchema.parse(source.retrySource);
      if (source?.boundFixRecoverySource !== undefined) {
        claimOptions.boundFixRecoverySource = boundFixRecoverySourceSchema.parse(source.boundFixRecoverySource);
      }
      if (source?.pendingRecoverySource !== undefined) {
        claimOptions.pendingRecoverySource = pendingRecoverySourceSchema.parse(source.pendingRecoverySource);
      }
      const { assertFreshReviewClaim } = await import('./fresh-review.js');
      await assertFreshReviewClaim(gitCommonDir, target, claimOptions.freshReviewOperation);
      committed = await claimConvergeAttemptOwned(claimOptions);
      try {
        await claimOptions.afterClaim?.(committed, ownership);
      } catch (error) {
        throw new ConvergeAttemptPostClaimError(committed, error);
      }
      return committed;
    };
    return claimOptions.ownership
      ? await withOwnedNativeOperation(claimOptions.ownership, gitCommonDir, target, work)
      : await withNativeTarget(gitCommonDir, target, work, {
      lockTimeoutMs: claimOptions.targetLockTimeoutMs ?? DEFAULT_TARGET_LOCK_TIMEOUT_MS,
      lockRetryMs: claimOptions.targetLockRetryMs,
    });
  } catch (error) {
    const postClaim = findPostClaimError(error);
    if (postClaim) throw postClaim;
    if (!(error instanceof RegistryCleanupError) || !committed || error.result !== committed) throw error;
    committed.warning = [committed.warning,
      `Attempt ${committed.attempt}/${committed.cap} is durably recorded, but target lock cleanup failed: ${error.message}. ` +
      'Do not retry this claim. Inspect target coordination before further target mutations.'].filter(Boolean).join(' ');
    return committed;
  }
}

function findPostClaimError(error: unknown): ConvergeAttemptPostClaimError | undefined {
  if (error instanceof ConvergeAttemptPostClaimError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findPostClaimError(nested);
      if (found) return found;
    }
  }
  return undefined;
}

async function claimConvergeAttemptOwned(options: ClaimOptions): Promise<ConvergeAttemptClaim> {
  const target = validateTarget(options.target);
  const requestedCap =
    options.maxAttempts === undefined ? undefined : validateAttemptCap(options.maxAttempts);
  const stateFile = convergeAttemptStatePath(options.gitCommonDir, target);
  const stateDir = join(resolve(options.gitCommonDir), STATE_DIR);
  const lockFile = `${stateFile}.lock`;
  const now = options.now ?? (() => new Date());
  const recordPid = options.recordPid ?? process.pid;
  const recordProcessIdentity = recordPid === process.pid &&
    (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32')
    ? await captureCurrentProcessIdentity()
    : undefined;
  const lockOwner: AttemptLockOwner = {
    pid: process.pid,
    claimedAt: now().toISOString(),
    token: randomUUID(),
  };

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  // Persist a newly created directory entry before relying on state files
  // inside it. Repeating the sync is intentional: if a prior sync failed,
  // the next invocation must not silently skip the durability barrier merely
  // because mkdir now observes the directory.
  await syncDirectory(dirname(stateDir));
  await acquireOwnedLock(
    lockFile,
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    lockOwner
  );

  let claim: ConvergeAttemptClaim | undefined;
  let claimError: unknown;
  try {
    const timestamp = now().toISOString();
    const stored = await readState(stateFile, target);
    const { assertReviewCyclePair } = await import('./fresh-review.js');
    await assertReviewCyclePair(options.gitCommonDir, target, stored?.cycle);
    const previous = stored ?? (await stateFromExistingLedger(options.gitCommonDir, target, timestamp));
    const attemptsUsed = previous?.attemptsUsed ?? 0;
    // Omitting --max-attempts preserves an existing target's configured cap.
    // Supplying it is an explicit invocation-time override: it can raise or
    // lower the persisted boundary after the workflow has obtained approval.
    const effectiveCap = requestedCap ?? previous?.cap ?? DEFAULT_CONVERGE_ATTEMPT_CAP;
    if (attemptsUsed >= effectiveCap) {
      // Persist a migrated ledger even when it already exhausts the cap, so
      // later processes do not depend on reparsing mutable prose. Also
      // persist a newly tightened cap even when the claim itself is refused.
      if (previous && (!stored || previous.cap !== effectiveCap)) {
        await writeStateAtomically(stateFile, {
          ...previous,
          cap: effectiveCap,
          updatedAt: timestamp,
        });
      }
      throw new ConvergeAttemptBudgetExceededError(target, attemptsUsed, effectiveCap);
    }

    const attempt = attemptsUsed + 1;
    if (options.retrySource && options.retrySource.attempt !== attemptsUsed) {
      throw new ConvergeAttemptStateError('Retry source does not bind the previous spent claim.');
    }
    if (options.boundFixRecoverySource && (options.boundFixRecoverySource.attempt !== attemptsUsed ||
      options.boundFixRecoverySource.target !== target || options.retrySource !== undefined)) {
      throw new ConvergeAttemptStateError('Bound fix recovery source does not bind this target and the previous spent claim.');
    }
    if (options.pendingRecoverySource && (options.pendingRecoverySource.pendingAttempt !== attemptsUsed ||
      options.pendingRecoverySource.target !== target || options.retrySource !== undefined ||
      options.boundFixRecoverySource !== undefined)) {
      throw new ConvergeAttemptStateError('Pending recovery source does not bind this target and the previous spent claim.');
    }
    const state: ConvergeAttemptState = {
      version: previous?.version ?? STATE_VERSION,
      ...(previous?.cycle ? { cycle: previous.cycle } : {}),
      ...(previous?.lastLaunch ? { lastLaunch: previous.lastLaunch } : {}),
      target,
      cap: effectiveCap,
      migratedAttempts: previous?.migratedAttempts ?? 0,
      attemptsUsed: attempt,
      attempts: [
        ...(previous?.attempts ?? []),
        { attempt, claimedAt: timestamp, pid: recordPid, source: 'claim',
          ...(recordProcessIdentity ? { processIdentity: recordProcessIdentity } : {}),
          ...(options.retrySource ? { retrySource: options.retrySource } : {}),
          ...(options.boundFixRecoverySource ? { boundFixRecoverySource: options.boundFixRecoverySource } : {}),
          ...(options.pendingRecoverySource ? { pendingRecoverySource: options.pendingRecoverySource } : {}) },
      ],
      updatedAt: timestamp,
    };
    await writeStateAtomically(stateFile, state);
    claim = { target, attempt, attemptsUsed: attempt, cap: effectiveCap, stateFile,
      ...(recordProcessIdentity ? { processIdentity: recordProcessIdentity } : {}),
      ...(state.cycle ? { cycle: state.cycle } : {}) };
  } catch (err) {
    claimError = err;
  }

  let releaseError: unknown;
  try {
    await releaseOwnedLock(lockFile, lockOwner);
  } catch (err) {
    releaseError = err;
  }

  if (claimError !== undefined) {
    if (releaseError !== undefined) {
      const claimMessage = claimError instanceof Error ? claimError.message : String(claimError);
      const releaseMessage =
        releaseError instanceof Error ? releaseError.message : String(releaseError);
      // A cap refusal alone is exit 2, but a simultaneous release failure
      // means the accounting lock is unhealthy. Classify the combined outcome
      // as infrastructure failure so raising the cap is never suggested as a
      // remedy for a stranded lock.
      throw new ConvergeAttemptStateError(
        `${claimMessage} Lock release also failed: ${releaseMessage}`,
        { cause: releaseError }
      );
    }
    throw claimError;
  }

  if (!claim) {
    throw new ConvergeAttemptStateError('Attempt accounting ended without a claim or error.');
  }
  if (releaseError !== undefined) {
    const releaseMessage =
      releaseError instanceof Error ? releaseError.message : String(releaseError);
    claim.warning =
      `Attempt ${claim.attempt}/${claim.cap} is durably recorded, but lock release failed: ` +
      `${releaseMessage} Do not retry this claim; the review may proceed.`;
  }
  return claim;
}

export async function loadConvergeAttemptState(
  gitCommonDir: string,
  target: string
): Promise<ConvergeAttemptState | undefined> {
  return readState(convergeAttemptStatePath(gitCommonDir, target), validateTarget(target));
}

/** Update only an owned, already-spent launch; never create or alter accounting. */
export async function recordConvergeAttemptLaunch(
  gitCommonDir: string,
  target: string,
  launch: GuardedLaunchState,
  ownership: NativeTargetOwnership,
  mutation: 'completion' | 'delivery' = 'completion'
): Promise<void> {
  if (mutation !== 'completion' && mutation !== 'delivery') {
    throw new ConvergeAttemptStateError('Unsupported guarded launch mutation.');
  }
  const incoming = launchSchema.parse(launch);
  return withOwnedNativeOperation(ownership, gitCommonDir, target, async operation => {
    const commonDir = await ownedNativeTargetCommonDir(operation, gitCommonDir, target);
    const stateFile = convergeAttemptStatePath(commonDir, target);
    const lockFile = `${stateFile}.lock`;
    const owner = { pid: process.pid, claimedAt: new Date().toISOString(), token: randomUUID() };
    await acquireOwnedLock(lockFile, DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_LOCK_RETRY_MS, owner);
    let failure: unknown;
    try {
      const state = await readState(stateFile, target);
      if (!state || state.attemptsUsed !== incoming.attempt || state.attempts.at(-1)?.pid !== incoming.pid ||
        mutation === 'completion' && incoming.pid !== process.pid) {
        throw new ConvergeAttemptStateError('Guarded launch requires this process\'s latest durable attempt claim.');
      }
      const attemptOwner = state.attempts.at(-1)?.processIdentity;
      if ((attemptOwner !== undefined || incoming.processIdentity !== undefined) &&
        !isDeepStrictEqual(attemptOwner, incoming.processIdentity)) {
        throw new ConvergeAttemptStateError('Guarded launch process identity does not match its attempt owner.');
      }
      if (mutation === 'completion' && attemptOwner !== undefined) {
        let currentOwner: ProcessIdentity;
        try { currentOwner = await captureCurrentProcessIdentity(); }
        catch (error) {
          throw new ConvergeAttemptStateError('Guarded launch current process identity is unverifiable.', { cause: error });
        }
        if (!isDeepStrictEqual(attemptOwner, currentOwner)) {
          throw new ConvergeAttemptStateError('Guarded launch current process identity does not match its attempt owner.');
        }
      }
      const { assertReviewCyclePair } = await import('./fresh-review.js');
      await assertReviewCyclePair(commonDir, target, state.cycle);
      const previous = state.lastLaunch;
      if (mutation === 'delivery' && (!previous || previous.status !== 'completed' ||
        !isDeepStrictEqual({ ...previous, deliveryPending: incoming.deliveryPending }, incoming))) {
        throw new ConvergeAttemptStateError('Delivery recording may change only the exact completed launch delivery flag.');
      }
      if (isDeepStrictEqual(previous, incoming)) {
        const handle = await open(stateFile, 'r+');
        try { await handle.sync(); }
        finally { await handle.close(); }
        await syncDirectory(dirname(stateFile));
        return;
      }
      if (mutation === 'completion') {
        if (incoming.status === 'pending') {
          if (previous && previous.attempt >= incoming.attempt) {
            throw new ConvergeAttemptStateError('A recorded guarded launch cannot be replaced or reset.');
          }
        } else {
          const binding = ['attempt', 'round', 'headSha', 'inputSha256', 'startedAt', 'pid', 'retryReason'] as const;
          if (!previous || previous.status !== 'pending' ||
            binding.some(key => previous[key] !== incoming[key]) ||
            previous.runId !== undefined && previous.runId !== incoming.runId ||
            !isDeepStrictEqual(previous.recovery, incoming.recovery)) {
            throw new ConvergeAttemptStateError('Guarded completion does not match its original pending launch.');
          }
        }
      }
      await writeStateAtomically(stateFile, { ...state, lastLaunch: incoming, updatedAt: new Date().toISOString() });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try { await releaseOwnedLock(lockFile, owner); }
      catch (error) {
        if (failure !== undefined) {
          throw new AggregateError([failure, error], 'Guarded launch recording and lock release failed.');
        }
        throw error;
      }
    }
  });
}

/** Continue one fully validated saved recovery under a new native target lease. */
export async function recordConvergeAttemptRecoveryResume(
  gitCommonDir: string,
  target: string,
  input: { expected: GuardedLaunchState; next: GuardedLaunchState; nativeSha256: string; cycleId?: string },
  ownership: NativeTargetOwnership,
): Promise<void> {
  const expected = launchSchema.parse(input.expected);
  const next = launchSchema.parse(input.next);
  const source = { nativeSha256: input.nativeSha256, cycleId: input.cycleId };
  let currentIdentity;
  try { currentIdentity = await captureCurrentProcessIdentity(); }
  catch (error) { throw new ConvergeAttemptStateError('recovery_resume_owner_unverifiable', { cause: error }); }
  const binding = (launch: GuardedLaunchState) => {
    const { status: _status, reportJsonSha256: _report, successfulReviews: _success, totalReviews: _total,
      deliveryPending: _delivery, hardFailure: _hard, reviewerHealth: _health, exitCode: _exit, reportPath: _path,
      recovery, ...immutable } = launch;
    const { resume: _resume, ...operation } = recovery ?? {};
    return { ...immutable, recovery: operation };
  };
  if (!expected.recovery?.operationId || !expected.runId || !isDeepStrictEqual(binding(expected), binding(next)) ||
    next.recovery?.resume?.pid !== process.pid ||
    !isDeepStrictEqual(next.recovery.resume.processIdentity, currentIdentity)) {
    throw new ConvergeAttemptStateError('recovery_resume_binding_mismatch');
  }
  return withOwnedNativeOperation(ownership, gitCommonDir, target, async owned => {
    const commonDir = await ownedNativeTargetCommonDir(owned, gitCommonDir, target);
    const stateFile = convergeAttemptStatePath(commonDir, target);
    const lockFile = `${stateFile}.lock`;
    const owner = { pid: process.pid, claimedAt: new Date().toISOString(), token: randomUUID() };
    await acquireOwnedLock(lockFile, DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_LOCK_RETRY_MS, owner);
    let failure: unknown;
    try {
      const state = await readState(stateFile, target);
      if (!state || state.attemptsUsed !== expected.attempt || state.attempts.at(-1)?.pid !== expected.pid) {
        throw new ConvergeAttemptStateError('recovery_resume_claim_mismatch');
      }
      const { assertReviewCyclePair } = await import('./fresh-review.js');
      await assertReviewCyclePair(commonDir, target, state.cycle);
      const { loadConvergeRunStateEvidence } = await import('./run-state.js');
      const native = await loadConvergeRunStateEvidence(commonDir, target);
      if (native?.state.version !== 3 || native.sha256 !== source.nativeSha256 ||
        native.state.cycle?.id !== source.cycleId) {
        throw new ConvergeAttemptStateError('recovery_resume_source_mismatch');
      }
      if (isDeepStrictEqual(state.lastLaunch, next)) {
        const handle = await open(stateFile, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await syncDirectory(dirname(stateFile));
        return;
      }
      if (!isDeepStrictEqual(state.lastLaunch, expected)) {
        throw new ConvergeAttemptStateError('recovery_resume_stale_launch');
      }
      const resume = next.recovery!.resume!;
      if (next.status === 'pending' && resume.phase === 'running') {
        if (expected.status === 'completed' || !isDeepStrictEqual(next, { ...expected, status: 'pending',
          recovery: { ...expected.recovery, resume } })) {
          throw new ConvergeAttemptStateError('recovery_resume_invalid_begin');
        }
        const previousOwner = expected.recovery!.resume?.phase === 'running'
          ? expected.recovery!.resume.processIdentity
          : expected.status === 'pending' ? expected.processIdentity : undefined;
        if (expected.recovery!.resume?.phase === 'running' || expected.status === 'pending') {
          if (!previousOwner) throw new ConvergeAttemptStateError('recovery_resume_owner_unverifiable');
          const ownerStatus = await inspectProcessIdentity(previousOwner);
          if (ownerStatus === 'unverifiable') throw new ConvergeAttemptStateError('recovery_resume_owner_unverifiable');
          if (ownerStatus === 'alive') throw new ConvergeAttemptStateError('recovery_resume_owner_alive');
          await writeStateAtomically(stateFile, { ...state, lastLaunch: next, updatedAt: new Date().toISOString() });
          return;
        }
      } else if (expected.status !== 'pending' || expected.recovery!.resume?.phase !== 'running' ||
        expected.recovery!.resume.pid !== process.pid ||
        !isDeepStrictEqual(expected.recovery!.resume!.processIdentity, currentIdentity) || resume.phase !== 'finished' ||
        !['completed', 'failed'].includes(next.status) || next.status === 'failed' && !isDeepStrictEqual(next,
          { ...expected, status: 'failed', recovery: { ...expected.recovery, resume } })) {
        throw new ConvergeAttemptStateError('recovery_resume_invalid_finish');
      }
      await writeStateAtomically(stateFile, { ...state, lastLaunch: next, updatedAt: new Date().toISOString() });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try { await releaseOwnedLock(lockFile, owner); }
      catch (error) {
        if (failure !== undefined) {
          throw new AggregateError([failure, error], 'Recovery resume recording and lock release failed.');
        }
        throw error;
      }
    }
  });
}

export async function previewConvergeAttemptState(
  gitCommonDir: string,
  target: string
): Promise<ConvergeAttemptState | undefined> {
  const validatedTarget = validateTarget(target);
  return await loadConvergeAttemptState(gitCommonDir, validatedTarget) ??
    await stateFromExistingLedger(gitCommonDir, validatedTarget, new Date().toISOString());
}

export async function resolveGitCommonDir(cwd = process.cwd()): Promise<string> {
  let stdout: string;
  try {
    const result = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
    });
    stdout = result.stdout;
  } catch (err) {
    throw new ConvergeAttemptStateError('Could not resolve the repository common Git directory.', {
      cause: err,
    });
  }

  const value = stdout.trim();
  if (!value) {
    throw new ConvergeAttemptStateError('Git returned an empty common-directory path.');
  }
  // Worktrees may spell the same directory through a symlinked system path
  // (macOS commonly returns /var from one checkout and /private/var from
  // another). Canonicalize it so one repository cannot acquire two budgets.
  return realpath(isAbsolute(value) ? value : resolve(cwd, value));
}
