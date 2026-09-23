import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withNativeLock } from '../../src/converge/native-lock.js';
import { withRecoveryLock } from '../../src/evidence/original-run/lock.js';
import { localLockScope } from '../../src/evidence/original-run/lock-scope.js';
import { prepareLockRoot } from '../../src/evidence/original-run/lock-path.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

const faults = vi.hoisted(() => ({ overlay: false }));
vi.mock('../../src/evidence/original-run/lock-scope.js', async original => {
  const module = await original<typeof import('../../src/evidence/original-run/lock-scope.js')>();
  return { ...module, localLockScope: vi.fn(module.localLockScope) };
});
vi.mock('../../src/evidence/original-run/lock-path.js', async original => {
  const module = await original<typeof import('../../src/evidence/original-run/lock-path.js')>();
  return { ...module, prepareLockRoot: vi.fn(module.prepareLockRoot) };
});
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, statfs: async (...args: Parameters<typeof fs.statfs>) => {
    const result = await fs.statfs(...args);
    return faults.overlay ? { ...result, type: 0x794c7630n } : result;
  } };
});

let root: string;
const target = 'synthetic-protocol', token = '00000000-0000-4000-8000-000000000001';
const unknownScope = { platform: 'ordinary-unqualified' as const, operating_system: 'win32' };
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-native-lock-'))); });
afterEach(async () => { faults.overlay = false; Object.defineProperty(process, 'platform', platform); await rm(root, { recursive: true, force: true }); });

/** Exact pre-bakery owner document and O_EXCL acquisition shape. */
async function historicalLock(identity: string, acquired: () => void, release: Promise<void>) {
  const path = join(root, `${sha256(identity)}.lock`);
  const token = '00000000-0000-4000-8000-000000000099';
  for (;;) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token }) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      acquired(); await release;
      await unlink(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }
}

it('caches only immutable process scope and leaves recovery filesystem qualification explicit', async () => {
  await withNativeLock(root, target, async () => {});
  await withNativeLock(root, target, async () => {});
  expect(localLockScope).toHaveBeenCalledTimes(1);
  expect(prepareLockRoot).not.toHaveBeenCalled();
  await withRecoveryLock(root, target, async () => {});
  expect(localLockScope).toHaveBeenCalledTimes(2);
  expect(prepareLockRoot).toHaveBeenCalledTimes(2);
});

it.each(['ordinary first', 'recovery first'] as const)('uses the same registry to exclude both wrappers with %s', async order => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = order === 'ordinary first' ? withNativeLock : withRecoveryLock;
  const second = order === 'ordinary first' ? withRecoveryLock : withNativeLock;
  let secondEntered = false;
  const owner = first(root, target, async () => { entered(); await held; });
  let waiter: Promise<void> | undefined;
  try {
    await ready;
    waiter = second(root, target, async () => { secondEntered = true; });
    void waiter.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(secondEntered).toBe(false);
  } finally {
    release(); await owner; await waiter;
  }
  expect(secondEntered).toBe(true);
});

it.each(['historical first', 'bakery first'] as const)('excludes a historical owner with %s acquisition', async order => {
  let releaseHistorical!: () => void, releaseBakery!: () => void;
  const historicalReleased = new Promise<void>(resolve => { releaseHistorical = resolve; });
  const bakeryReleased = new Promise<void>(resolve => { releaseBakery = resolve; });
  let historicalAcquired!: () => void, bakeryReserved!: () => void;
  const historicalReady = new Promise<void>(resolve => { historicalAcquired = resolve; });
  const bakeryReady = new Promise<void>(resolve => { bakeryReserved = resolve; });
  let historicalDone = false, bakeryEntered = false;
  const modernLock = () => withNativeLock(root, target, async () => { bakeryEntered = true; await bakeryReleased; }, {
    onEvent: async event => { if (event.stage === 'legacy_reserved') bakeryReserved(); },
  });
  let old: Promise<void> | undefined;
  let modern: Promise<void> | undefined;
  try {
    if (order === 'historical first') {
      old = historicalLock(target, historicalAcquired, historicalReleased).then(() => { historicalDone = true; });
      await historicalReady;
      modern = modernLock();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(bakeryEntered).toBe(false);
      releaseHistorical(); await old; await bakeryReady;
      expect(historicalDone).toBe(true);
      releaseBakery(); await modern;
    } else {
      modern = modernLock();
      await bakeryReady;
      old = historicalLock(target, historicalAcquired, historicalReleased).then(() => { historicalDone = true; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(historicalDone).toBe(false);
      releaseBakery(); await modern; await historicalReady; releaseHistorical(); await old;
      expect(bakeryEntered).toBe(true);
    }
  } finally {
    releaseHistorical(); releaseBakery();
    await Promise.allSettled([...(old ? [old] : []), ...(modern ? [modern] : [])]);
  }
});

it('reclaims a dead historical owner before publishing the bakery registration', async () => {
  const path = join(root, `${sha256(target)}.lock`);
  await writeFile(path, JSON.stringify({ pid: 2147483647, token: 'old-client-token' }) + '\n', { mode: 0o600 });
  const probe = vi.fn(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
  await expect(withNativeLock(root, target, async () => 'resumed', { probe })).resolves.toBe('resumed');
  expect(probe).toHaveBeenCalledWith(2147483647);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('times out behind a live historical owner without entering work', async () => {
  const path = join(root, `${sha256(target)}.lock`);
  await writeFile(path, JSON.stringify({ pid: process.pid, token: 'old-client-token' }) + '\n', { mode: 0o600 });
  let clock = 0; const work = vi.fn();
  await expect(withNativeLock(root, target, work, {
    now: () => clock, wait: async () => { clock += 1_000; },
  })).rejects.toThrow('recovery_run_locked');
  expect(work).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toContain('old-client-token');
});

async function unqualifiedRegistration() {
  const registry = join(root, `${sha256(target)}.bakery`);
  await mkdir(registry, { mode: 0o700 });
  const path = join(registry, `${token}.json`);
  const bytes = JSON.stringify({ version: 1, pid: 2147483647, token, scope: unknownScope, state: 'ready', ticket: 1 });
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, bytes };
}

it('never reaps an unqualified owner using PID absence or elapsed time', async () => {
  const original = await unqualifiedRegistration(); let clock = 0;
  const probe = vi.fn(() => { throw Object.assign(new Error('not running'), { code: 'ESRCH' }); });
  const work = vi.fn();
  await expect(withNativeLock(root, target, work, { scope: async () => unknownScope, probe,
    now: () => clock, wait: async () => { clock += 1000; } })).rejects.toThrow('recovery_run_locked');
  expect(probe).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  expect(await readFile(original.path, 'utf8')).toBe(original.bytes);
});

it('refuses an unqualified registration under strict recovery without deleting it', async () => {
  const original = await unqualifiedRegistration(), work = vi.fn(), probe = vi.fn();
  await expect(withRecoveryLock(root, target, work, { probe })).rejects.toThrow('invalid_recovery_lock_requires_inspection');
  expect(work).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  expect(await readFile(original.path, 'utf8')).toBe(original.bytes);
});

it('preserves ordinary overlay behavior without qualifying that filesystem for recovery', async () => {
  // Simulate the Linux statfs branch; this is not overlay filesystem qualification.
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }); faults.overlay = true;
  const scope = { platform: 'linux' as const, boot: token, namespace: '1:123' };
  await expect(withNativeLock(root, target, async () => 'ordinary', { scope: async () => scope })).resolves.toBe('ordinary');
  const recovery = vi.fn();
  await expect(withRecoveryLock(root, target, recovery, { scope: async () => scope })).rejects.toThrow('unsupported_recovery_lock_filesystem');
  expect(recovery).not.toHaveBeenCalled();
});
