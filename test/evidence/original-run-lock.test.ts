import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

const controls = vi.hoisted(() => ({
  beforeWrite: undefined as (() => Promise<void>) | undefined,
  failTemporaryUnlink: false,
  failDirectorySync: false,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, unlink: async (path: Parameters<typeof fs.unlink>[0]) => {
    if (controls.failTemporaryUnlink && String(path).endsWith('.tmp')) {
      controls.failTemporaryUnlink = false;
      throw Object.assign(new Error('readonly'), { code: 'EROFS' });
    }
    return fs.unlink(path);
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = (async (...writeArgs: Parameters<typeof handle.writeFile>) => {
      const hook = controls.beforeWrite; controls.beforeWrite = undefined;
      await hook?.();
      return write(...writeArgs);
    }) as typeof handle.writeFile;
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (controls.failDirectorySync && (await handle.stat()).isDirectory()) {
        controls.failDirectorySync = false;
        throw Object.assign(new Error('readonly'), { code: 'EROFS' });
      }
      return sync();
    };
    return handle;
  } };
});
const directories: string[] = [];
async function completeContenderBeforeRelease(first: Promise<void>, ready: Promise<void>, startSecond: () => Promise<void>, release: () => void, timeoutMs = 1500): Promise<void> {
  let second: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  try {
    await Promise.race([ready, first.then(() => { throw new Error('writer_completed_before_pause'); })]);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('contender_did_not_complete_before_release')), timeoutMs);
    });
    second = startSecond();
    await Promise.race([second, timeout]);
  } catch (error) { failed = true; throw error; }
  finally {
    clearTimeout(timer); release();
    const settled = await Promise.allSettled([first, ...(second ? [second] : [])]);
    if (!failed) for (const result of settled) if (result.status === 'rejected') throw result.reason;
  }
}
afterEach(async () => {
  controls.beforeWrite = undefined;
  controls.failTemporaryUnlink = false;
  controls.failDirectorySync = false;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it.each(['temporary unlink', 'directory sync'])('releases only its own published lock after %s fails before recovery', async (failure) => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-original-lock-')); directories.push(root);
  if (failure === 'temporary unlink') controls.failTemporaryUnlink = true;
  else controls.failDirectorySync = true;
  const identity = 'same destination/org/run'; const work = vi.fn();
  await expect(withRecoveryLock(root, identity, work)).rejects.toMatchObject({ code: 'EROFS' });
  expect(work).not.toHaveBeenCalled();
  await expect(readFile(join(root, `${sha256(identity)}.lock`))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(withRecoveryLock(root, identity, async () => 'recovered')).resolves.toBe('recovered');
});

it('lets contending recovery complete while another owner document is still being written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-original-lock-')); directories.push(root);
  let reached!: () => void; const waiting = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
  controls.beforeWrite = async () => { reached(); await paused; };
  const entered: string[] = [];
  const first = withRecoveryLock(root, 'same destination/org/run', async () => { entered.push('first'); }, { legacy: false });
  await completeContenderBeforeRelease(first, waiting,
    () => withRecoveryLock(root, 'same destination/org/run', async () => { entered.push('second'); }, { legacy: false }), release);
  expect(entered).toEqual(['second', 'first']);
  expect(await readdir(join(root, `${sha256('same destination/org/run')}.bakery`))).toEqual([]);
});

it('releases and settles owned work when a contender incorrectly waits for the paused writer', async () => {
  vi.useFakeTimers();
  let releaseWriter!: () => void; let firstSettled = false; let secondSettled = false;
  const first = new Promise<void>(resolve => { releaseWriter = resolve; }).then(() => { firstSettled = true; });
  const release = vi.fn(() => releaseWriter());
  const completed = completeContenderBeforeRelease(first, Promise.resolve(), () => first.then(() => { secondSettled = true; }), release)
    .then(() => undefined, error => error as Error);
  try {
    await vi.advanceTimersByTimeAsync(1500);
    expect(release).toHaveBeenCalledOnce();
    expect(await completed).toMatchObject({ message: 'contender_did_not_complete_before_release' });
    expect(firstSettled).toBe(true); expect(secondSettled).toBe(true); expect(vi.getTimerCount()).toBe(0);
  } finally { releaseWriter(); await completed; vi.useRealTimers(); }
});

it('retains an existing incomplete lock without entering recovery or overwriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-original-lock-')); directories.push(root);
  const identity = 'same destination/org/run'; const path = join(root, `${sha256(identity)}.lock`);
  await writeFile(path, '{"pid":');
  const work = vi.fn();
  await expect(withRecoveryLock(root, identity, work)).rejects.toThrow('incomplete_recovery_lock_requires_inspection');
  expect(work).not.toHaveBeenCalled();
  expect(await readFile(path, 'utf8')).toBe('{"pid":');
  expect(await readdir(root)).toEqual([`${sha256(identity)}.lock`]);
});
