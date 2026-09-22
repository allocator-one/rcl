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
  const first = withRecoveryLock(root, 'same destination/org/run', async () => { entered.push('first'); });
  await waiting;
  let second: PromiseSettledResult<void>;
  try {
    [second] = await Promise.allSettled([
      withRecoveryLock(root, 'same destination/org/run', async () => { entered.push('second'); }),
    ]);
  } finally { release(); }
  await first;
  expect(second!.status).toBe('fulfilled');
  expect(entered).toEqual(['second', 'first']);
  expect(await readdir(root)).toEqual([]);
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
