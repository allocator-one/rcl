import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const DEFAULT_CONVERGE_ATTEMPT_CAP = 7;

const STATE_VERSION = 2;
const STATE_DIR = 'rcl-converge-attempts';
const LOCK_OWNER_FILE = 'owner.json';
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;

const execFileAsync = promisify(execFile);

export interface ConvergeAttemptRecord {
  attempt: number;
  claimedAt: string;
  pid: number;
  source: 'claim';
}

export interface ConvergeAttemptState {
  version: typeof STATE_VERSION;
  target: string;
  cap: number;
  migratedAttempts: number;
  attemptsUsed: number;
  attempts: ConvergeAttemptRecord[];
  updatedAt: string;
}

export interface ConvergeAttemptClaim {
  target: string;
  attempt: number;
  attemptsUsed: number;
  cap: number;
  stateFile: string;
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
  pid?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

interface AttemptLockOwner {
  pid: number;
  claimedAt: string;
  token: string;
}

function validateTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new ConvergeAttemptStateError('Convergence target must not be empty.');
  }
  return trimmed;
}

function validateCap(maxAttempts: number): number {
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

function validateState(value: unknown, expectedTarget: string, stateFile: string): ConvergeAttemptState {
  if (typeof value !== 'object' || value === null) {
    throw new ConvergeAttemptStateError(`Invalid convergence attempt state: ${stateFile}`);
  }

  const state = value as Partial<ConvergeAttemptState>;
  const attempts = state.attempts;
  if (
    state.version !== STATE_VERSION ||
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
        record.source !== 'claim'
    )
  ) {
    throw new ConvergeAttemptStateError(
      `Invalid convergence attempt state in ${stateFile}; refusing to reset the safety budget.`
    );
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
    return validateState(JSON.parse(raw), target, stateFile);
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

async function readLockOwner(lockDir: string): Promise<AttemptLockOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(lockDir, LOCK_OWNER_FILE), 'utf8')
    ) as Partial<AttemptLockOwner>;
    if (
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
    if (!isNodeError(err, 'ENOENT') && !isNodeError(err, 'ENOTDIR') && !(err instanceof SyntaxError)) {
      throw err;
    }
  }
  return undefined;
}

async function lockPathExists(lockDir: string): Promise<boolean> {
  try {
    await lstat(lockDir);
    return true;
  } catch (err) {
    if (isNodeError(err, 'ENOENT')) return false;
    throw err;
  }
}

async function isRenameContention(err: unknown, destination: string): Promise<boolean> {
  if (isNodeError(err, 'EEXIST') || isNodeError(err, 'ENOTEMPTY')) return true;
  // Windows commonly reports an existing directory destination as EPERM or
  // EACCES. Treat those as contention only when the destination now exists;
  // a genuine permission failure on an absent path remains infrastructure
  // failure and must fail closed.
  return (
    (isNodeError(err, 'EPERM') || isNodeError(err, 'EACCES')) &&
    (await lockPathExists(destination))
  );
}

async function tryAcquireOwnedLock(lockDir: string, owner: AttemptLockOwner): Promise<boolean> {
  // Populate a private directory first, then publish it with one atomic
  // rename. A canonical lock is therefore never visible without owner data,
  // eliminating the mkdir -> owner.json race entirely.
  const claimDir = `${lockDir}.claim.${process.pid}.${randomUUID()}`;
  await mkdir(claimDir);
  let primaryError: unknown;
  let published = false;
  try {
    await writeFile(join(claimDir, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await rename(claimDir, lockDir);
    } catch (err) {
      if (await isRenameContention(err, lockDir)) return false;
      throw err;
    }
    published = true;
    return true;
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (!published) {
      try {
        await rm(claimDir, { recursive: true, force: true });
      } catch (cleanupError) {
        if (primaryError === undefined) throw cleanupError;
      }
    }
  }
}

async function reclaimStaleLock(lockDir: string, staleOwner: AttemptLockOwner): Promise<boolean> {
  const currentOwner = await readLockOwner(lockDir);
  if (
    !currentOwner ||
    currentOwner.token !== staleOwner.token ||
    processIsAlive(currentOwner.pid)
  ) {
    return false;
  }

  // All reclaimers for one stale generation derive the same destination.
  // The first atomic rename leaves the non-empty directory as a tombstone;
  // delayed reclaimers cannot rename a freshly acquired lock over it.
  const staleDir = `${lockDir}.stale.${staleOwner.token}`;
  try {
    await rename(lockDir, staleDir);
    return true;
  } catch (err) {
    if (isNodeError(err, 'ENOENT') || (await isRenameContention(err, staleDir))) return false;
    throw err;
  }
}

async function acquireOwnedLock(
  lockDir: string,
  timeoutMs: number,
  retryMs: number,
  owner: AttemptLockOwner
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    // These reads choose between acquire, reclaim, and fail-closed waiting;
    // they do not provide mutual exclusion. Atomic directory publication and
    // the non-empty generation tombstone are the serialization primitives.
    const currentOwner = await readLockOwner(lockDir);
    if (currentOwner && !processIsAlive(currentOwner.pid)) {
      if (await reclaimStaleLock(lockDir, currentOwner)) {
        continue;
      }
    } else if (!currentOwner && !(await lockPathExists(lockDir))) {
      if (await tryAcquireOwnedLock(lockDir, owner)) return;
    }

    if (Date.now() >= deadline) {
      throw new ConvergeAttemptStateError(
        `Timed out waiting for convergence attempt lock: ${lockDir}. ` +
          'Refusing to start provider calls while accounting is uncertain. ' +
          'If no live converge-attempt process owns it, move or remove that lock directory and retry.'
      );
    }
    await delay(retryMs);
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
    // fsyncing the file before rename makes its contents durable; syncing the
    // parent directory makes the atomic name replacement durable too.
    await syncDirectory(dirname(stateFile));
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    try {
      await rm(tempFile, { force: true });
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
    }
  }
}

async function releaseOwnedLock(lockDir: string, owner: AttemptLockOwner): Promise<void> {
  const currentOwner = await readLockOwner(lockDir);
  if (!currentOwner || currentOwner.token !== owner.token) {
    throw new ConvergeAttemptStateError(
      `Convergence attempt lock ownership changed unexpectedly: ${lockDir}. ` +
        'Refusing to remove a lock that may belong to another process.'
    );
  }
  const releasedDir = `${lockDir}.released.${owner.token}`;
  await rename(lockDir, releasedDir);
  // The canonical lock is already gone. A cleanup failure leaves only a
  // harmless generation-scoped artifact and must not turn a recorded claim
  // into a reported failure that an agent might retry.
  try {
    await rm(releasedDir, { recursive: true, force: true });
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
  const target = validateTarget(options.target);
  const requestedCap =
    options.maxAttempts === undefined ? undefined : validateCap(options.maxAttempts);
  const stateFile = convergeAttemptStatePath(options.gitCommonDir, target);
  const stateDir = join(resolve(options.gitCommonDir), STATE_DIR);
  const lockDir = `${stateFile}.lock`;
  const now = options.now ?? (() => new Date());
  const pid = options.pid ?? process.pid;
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
    lockDir,
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS,
    lockOwner
  );

  try {
    const timestamp = now().toISOString();
    const stored = await readState(stateFile, target);
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
    const state: ConvergeAttemptState = {
      version: STATE_VERSION,
      target,
      cap: effectiveCap,
      migratedAttempts: previous?.migratedAttempts ?? 0,
      attemptsUsed: attempt,
      attempts: [
        ...(previous?.attempts ?? []),
        { attempt, claimedAt: timestamp, pid, source: 'claim' },
      ],
      updatedAt: timestamp,
    };
    await writeStateAtomically(stateFile, state);

    return { target, attempt, attemptsUsed: attempt, cap: effectiveCap, stateFile };
  } finally {
    await releaseOwnedLock(lockDir, lockOwner);
  }
}

export async function loadConvergeAttemptState(
  gitCommonDir: string,
  target: string
): Promise<ConvergeAttemptState | undefined> {
  return readState(convergeAttemptStatePath(gitCommonDir, target), validateTarget(target));
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
