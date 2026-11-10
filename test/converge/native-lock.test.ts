import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withNativeLock } from '../../src/converge/native-lock.js';
import { withRecoveryLock } from '../../src/evidence/original-run/lock.js';
import { localLockScope } from '../../src/evidence/original-run/lock-scope.js';
import { prepareLockRoot } from '../../src/evidence/original-run/lock-path.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { RegistryCleanupError, withLegacyReservation } from '../../src/coordination/registry-lock.js';

const faults = vi.hoisted(() => ({
  overlay: false,
  registryRmdirCode: undefined as 'ENOENT' | undefined,
  rootSyncCode: undefined as 'ENOENT' | 'EIO' | undefined,
  rootSyncPath: undefined as string | undefined,
  rootSyncArmed: false,
  outerReservationObserved: false,
}));
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
  return {
    ...fs,
    statfs: async (...args: Parameters<typeof fs.statfs>) => {
      const result = await fs.statfs(...args);
      return faults.overlay ? { ...result, type: 0x794c7630n } : result;
    },
    rmdir: async (...args: Parameters<typeof fs.rmdir>) => {
      const path = String(args[0]);
      if (!path.endsWith('.bakery')) return fs.rmdir(...args);
      const lock = `${path.slice(0, -'.bakery'.length)}.lock`;
      faults.outerReservationObserved = await fs.readFile(lock).then(() => true, () => false);
      if (faults.registryRmdirCode === 'ENOENT') {
        faults.registryRmdirCode = undefined;
        await fs.rmdir(...args);
        throw Object.assign(new Error('already removed'), { code: 'ENOENT' });
      }
      const result = await fs.rmdir(...args);
      if (faults.rootSyncCode !== undefined) faults.rootSyncArmed = true;
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (faults.rootSyncArmed && String(args[0]) === faults.rootSyncPath) {
        faults.rootSyncArmed = false;
        const code = faults.rootSyncCode!;
        faults.rootSyncCode = undefined;
        throw Object.assign(new Error(`root sync ${code}`), { code });
      }
      return fs.open(...args);
    },
  };
});

let root: string;
const target = 'synthetic-protocol', token = '00000000-0000-4000-8000-000000000001';
const unknownScope = { platform: 'ordinary-unqualified' as const, operating_system: 'win32' };
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-native-lock-'))); });
afterEach(async () => {
  faults.overlay = false;
  faults.registryRmdirCode = undefined;
  faults.rootSyncCode = undefined;
  faults.rootSyncPath = undefined;
  faults.rootSyncArmed = false;
  faults.outerReservationObserved = false;
  Object.defineProperty(process, 'platform', platform);
  await rm(root, { recursive: true, force: true });
});

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

it('preserves a completed legacy reservation result when its outer cleanup fails', async () => {
  let syncs = 0;
  const sync = async () => { if (++syncs === 2) throw Object.assign(new Error('outer release failed'), { code: 'EIO' }); };
  let error: unknown;
  try {
    await withLegacyReservation(root, target, { pid: process.pid, token }, async () => 'committed', { sync });
  } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RegistryCleanupError);
  expect((error as RegistryCleanupError<string>).result).toBe('committed');
  expect((error as Error).cause).toMatchObject({ code: 'EIO' });
});

it('preserves an inner cleanup result when outer legacy cleanup also fails', async () => {
  let syncs = 0;
  const sync = async () => { if (++syncs === 2) throw Object.assign(new Error('outer release failed'), { code: 'EIO' }); };
  let error: unknown;
  try {
    await withLegacyReservation(root, target, { pid: process.pid, token }, async () => {
      throw new RegistryCleanupError('committed', new Error('inner cleanup failed'));
    }, { sync });
  } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RegistryCleanupError);
  expect((error as RegistryCleanupError<string>).result).toBe('committed');
  expect((error as Error).cause).toBeInstanceOf(AggregateError);
});

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
  expect(await readdir(root)).toEqual([]);
});

it('removes and recreates an empty registry between a holder and queued contender', async () => {
  let entered!: () => void, releaseHolder!: () => void, queued!: () => void, retry!: () => void;
  const holderEntered = new Promise<void>(resolve => { entered = resolve; });
  const holderHeld = new Promise<void>(resolve => { releaseHolder = resolve; });
  const contenderQueued = new Promise<void>(resolve => { queued = resolve; });
  const retryAllowed = new Promise<void>(resolve => { retry = resolve; });
  let contenderEntered = false;
  const holder = withNativeLock(root, target, async () => { entered(); await holderHeld; });
  let contender: Promise<void> | undefined;
  try {
    await holderEntered;
    contender = withNativeLock(root, target, async () => { contenderEntered = true; }, {
      wait: async () => { queued(); await retryAllowed; },
    });
    void contender.catch(() => {});
    await contenderQueued;
    expect(contenderEntered).toBe(false);
    releaseHolder();
    await holder;
    expect(await readdir(root)).toEqual([]);
    retry();
    await contender;
    expect(contenderEntered).toBe(true);
    expect(await readdir(root)).toEqual([]);
  } finally {
    releaseHolder(); retry();
    await Promise.allSettled([holder, ...(contender ? [contender] : [])]);
  }
});

it('removes empty registries for unique identities after releasing their outer reservations', async () => {
  for (let index = 0; index < 10; index++) {
    await expect(withNativeLock(root, `target-${index}`, async () => index)).resolves.toBe(index);
  }
  expect(await readdir(root)).toEqual([]);
});

it('accepts an already absent empty registry while the outer reservation is held', async () => {
  faults.registryRmdirCode = 'ENOENT';
  await expect(withNativeLock(root, target, async () => 'committed')).resolves.toBe('committed');
  expect(faults.outerReservationObserved).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

it('removes an empty registry when acquisition fails before registration publication', async () => {
  await expect(withNativeLock(root, target, async () => undefined, {
    onEvent: async event => { if (event.stage === 'legacy_reserved') throw new Error('pre-publication failure'); },
  })).rejects.toThrow('pre-publication failure');
  expect(faults.outerReservationObserved).toBe(true);
  expect(await readdir(root)).toEqual([]);
});

it('conservatively retains a registry that gains an unknown entry during work', async () => {
  const registry = join(root, `${sha256(target)}.bakery`);
  await withNativeLock(root, target, async () => {
    await writeFile(join(registry, 'inspection-required'), 'retain', { mode: 0o600 });
  });
  expect(faults.outerReservationObserved).toBe(true);
  expect(await readdir(registry)).toEqual(['inspection-required']);
  expect(await readdir(root)).toEqual([`${sha256(target)}.bakery`]);
});

it.each(['ENOENT', 'EIO'] as const)('preserves completed work when post-removal root sync fails with %s', async syncCode => {
  faults.rootSyncPath = root;
  faults.rootSyncCode = syncCode;
  let error: unknown;
  try { await withNativeLock(root, target, async () => 'committed'); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RegistryCleanupError);
  expect((error as RegistryCleanupError<string>).result).toBe('committed');
  expect((error as Error).cause).toMatchObject({ code: syncCode });
  expect(faults.outerReservationObserved).toBe(true);
  expect(await readdir(root)).toEqual([]);
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

it('never exposes a partial legacy owner while a contender prepares publication', async () => {
  let prepared!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { prepared = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const first = withNativeLock(root, target, async () => 'first', {
    onLegacyPrepared: async () => { prepared(); await hold; },
  });
  try {
    await reached;
    await expect(withNativeLock(root, target, async () => 'second')).resolves.toBe('second');
  } finally {
    release(); await first;
  }
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

it('never reaps an unqualified scoped legacy reservation using PID absence', async () => {
  const path = join(root, `${sha256(target)}.lock`);
  const original = JSON.stringify({ pid: 2147483647, token: 'old-client-token', scope: unknownScope }) + '\n';
  await writeFile(path, original, { mode: 0o600 });
  let clock = 0; const work = vi.fn();
  const probe = vi.fn(() => { throw Object.assign(new Error('not running'), { code: 'ESRCH' }); });
  await expect(withNativeLock(root, target, work, { scope: async () => unknownScope, probe,
    now: () => clock, wait: async () => { clock += 1_000; } })).rejects.toThrow('legacy_recovery_lock_requires_inspection');
  expect(probe).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe(original);
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
