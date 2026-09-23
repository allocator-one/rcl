import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { withRegistryLock, type RegistryHooks } from '../coordination/registry-lock.js';
import { serializeRecoveryDocument } from '../evidence/original-run/journal.js';
import { localLockScope, validLockScope, type LockScope } from '../evidence/original-run/lock-scope.js';

interface UnqualifiedScope { platform: 'ordinary-unqualified'; operating_system: string }
export type NativeLockScope = LockScope | UnqualifiedScope;
const scopes = new Map<string, Promise<LockScope>>();

/** Boot and this process's PID namespace cannot change during its lifetime. */
async function nativeScope(): Promise<NativeLockScope> {
  const platform = process.platform;
  if (platform === 'darwin' || platform === 'linux') {
    let pending = scopes.get(platform);
    if (!pending) {
      pending = localLockScope(); scopes.set(platform, pending);
      void pending.catch(() => { if (scopes.get(platform) === pending) scopes.delete(platform); });
    }
    try { return await pending; } catch { /* No invented boot or PID namespace. */ }
  }
  return { platform: 'ordinary-unqualified', operating_system: platform };
}

export function validNativeLockScope(value: unknown): value is NativeLockScope {
  if (validLockScope(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const scope = value as Partial<UnqualifiedScope>;
  return scope.platform === 'ordinary-unqualified' && typeof scope.operating_system === 'string' &&
    /^[a-z0-9_-]{1,32}$/.test(scope.operating_system) && Object.keys(value).length === 2;
}

/** Windows flushes file bytes but does not expose fsync-able directory handles. */
export async function syncNativeDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function inspectNativeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path ||
      (process.platform !== 'win32' && ((info.mode & 0o7777) !== 0o700 || info.uid !== process.geteuid?.()))) {
    throw new Error('unsafe_native_lock_directory');
  }
}

async function prepareNativeRoot(input: string): Promise<string> {
  const path = resolve(input);
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('unsafe_native_lock_directory');
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await inspectNativeDirectory(path);
  return path;
}

/** Bounded atomic-registration read, including platforms without O_NOFOLLOW. */
async function readNativeRegistration(path: string): Promise<string> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('invalid_native_lock_registration');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 2048 || entry.ino !== before.ino || entry.dev !== before.dev) throw new Error('changing_source');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await handle.read(bytes, length, bytes.length - length, length);
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(path);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || !current.isFile()) {
      throw new Error('changing_source');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

/** Existing ordinary storage is not thereby qualified for recovery durability. */
export function withNativeLock<T>(root: string, target: string, work: () => Promise<T>,
  hooks: RegistryHooks<NativeLockScope> = {}, timing: { lockTimeoutMs?: number; lockRetryMs?: number } = {}): Promise<T> {
  return withRegistryLock(root, target, work, {
    scope: nativeScope, validScope: validNativeLockScope, prepareRoot: prepareNativeRoot,
    inspectRegistry: inspectNativeDirectory, sync: syncNativeDirectory, read: readNativeRegistration,
    // Unqualified registrations are never reaped using a PID or elapsed time.
    // Interrupted owners need inspection, including after a reboot.
    mayProbePid: validLockScope,
    ...timing,
  }, hooks);
}

/** Native atomic replacement uses the same JSON bytes and platform durability as attempts. */
export async function writeNativeStateExclusive(path: string, value: unknown): Promise<void> {
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('symlink_directory');
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(serializeRecoveryDocument(value)); await handle.sync(); }
  finally { await handle.close(); }
  await syncNativeDirectory(dirname(path));
}
