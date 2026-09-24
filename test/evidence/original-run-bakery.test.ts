import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';
import { localLockScope } from '../../src/evidence/original-run/lock-scope.js';
import { readStable, sha256 } from '../../src/telemetry/recovery/files.js';
import type { LockHooks, LockRegistration } from '../../src/evidence/original-run/lock.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function root() { const path = await mkdtemp(join(tmpdir(), 'rcl-bakery-')); roots.push(path); return path; }
const identity = 'destination/org/run';
const tokenA = '00000000-0000-4000-8000-000000000001';
const tokenB = '00000000-0000-4000-8000-000000000002';
function registry(path: string) { return join(path, `${sha256(identity)}.bakery`); }
async function stale(path: string, state: 'choosing' | 'ready' = 'ready', extra = {}) {
  await mkdir(registry(path), { mode: 0o700 });
  const owner = { version: 1, token: tokenA, pid: 2147483647, scope: await localLockScope(), state, ...(state === 'ready' ? { ticket: 1 } : {}), ...extra };
  await writeFile(join(registry(path), `${tokenA}.json`), JSON.stringify(owner), { mode: 0o600 });
  return owner;
}

it.each(['choosing', 'ready'] as const)('reclaims a dead %s unique registration', async state => {
  const path = await root(); await stale(path, state);
  await expect(withRecoveryLock(path, identity, async () => 'resumed')).resolves.toBe('resumed');
  expect(await readdir(registry(path))).toEqual([]);
});

it('does not probe any PID or perform work when scope is unavailable', async () => {
  const path = await root(); const probe = vi.fn(); const work = vi.fn();
  await expect(withRecoveryLock(path, identity, work, { scope: async () => { throw new Error('unsupported_recovery_lock_scope'); }, probe })).rejects.toThrow('unsupported_recovery_lock_scope');
  expect(probe).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled(); expect(await readdir(path)).toEqual([]);
});

it.each(['boot', 'namespace'] as const)('refuses a foreign %s without PID probes or deleting its registration', async field => {
  const path = await root(); const scope = { ...await localLockScope(), platform: 'linux' as const, namespace: '12:345' };
  const owner = await stale(path, 'ready', { scope: { ...scope, [field]: field === 'boot' ? tokenB : '123:456' } });
  const probe = vi.fn(); const work = vi.fn();
  await expect(withRecoveryLock(path, identity, work, { probe, scope: async () => scope })).rejects.toThrow('foreign_recovery_lock_scope');
  expect(probe).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(join(registry(path), `${tokenA}.json`), 'utf8'))).toEqual(owner);
});

it.each(['reused PID', 'EPERM'])('preserves an uncertain owner on %s', async mode => {
  const path = await root(); await stale(path);
  let now = 0; const work = vi.fn();
  const probe = vi.fn(() => { if (mode === 'EPERM') throw Object.assign(new Error('permission'), { code: 'EPERM' }); });
  await expect(withRecoveryLock(path, identity, work, { probe, now: () => now, wait: async () => { now += 1000; } })).rejects.toThrow(mode === 'EPERM' ? 'recovery_lock_liveness_unknown' : 'recovery_run_locked');
  expect(work).not.toHaveBeenCalled(); expect(await readdir(registry(path))).toEqual([`${tokenA}.json`]);
});

it('breaks equal tickets by token and retains one fixed ticket while waiting', async () => {
  const path = await root(); const selected = barrier(); let count = 0;
  const allReady = barrier(); let readyCount = 0;
  const tickets: number[] = []; const order: string[] = []; let active = 0; let maximum = 0;
  const hooks = (token: string): LockHooks => ({ token: () => token, onEvent: async event => {
    if (event.stage === 'ticket_selected') { tickets.push(event.registration.ticket!); if (++count === 2) selected.release(); await selected.promise; }
    if (event.stage === 'ready_published') { if (++readyCount === 2) allReady.release(); await allReady.promise; }
  } });
  const work = (name: string) => async () => { maximum = Math.max(maximum, ++active); order.push(name); await new Promise(r => setImmediate(r)); active--; };
  await Promise.all([withRecoveryLock(path, identity, work('B'), hooks(tokenB)), withRecoveryLock(path, identity, work('A'), hooks(tokenA))]);
  expect(tickets).toEqual([1, 1]); expect(order).toEqual(['A', 'B']); expect(maximum).toBe(1);
});

it('makes a late chooser wait for the already ready holder', async () => {
  const path = await root(); const entered = barrier(); const release = barrier(); const selected = barrier();
  let active = 0; let maximum = 0; let lateTicket = 0;
  const first = withRecoveryLock(path, identity, async () => { maximum = Math.max(maximum, ++active); entered.release(); await release.promise; active--; });
  await entered.promise;
  const second = withRecoveryLock(path, identity, async () => { maximum = Math.max(maximum, ++active); active--; }, { onEvent: async event => {
    if (event.stage === 'ready_published') { lateTicket = event.registration.ticket!; selected.release(); }
  } });
  await selected.promise; expect(active).toBe(1); expect(lateTicket).toBe(2); release.release();
  await Promise.all([first, second]); expect(maximum).toBe(1);
});

it('blocks on a live choosing registration before its ticket is known', async () => {
  const path = await root(); const choosing = barrier(); const release = barrier();
  const first = withRecoveryLock(path, identity, async () => undefined, { onEvent: async event => {
    if (event.stage === 'choosing_published') { choosing.release(); await release.promise; }
  } });
  await choosing.promise; let clock = 0; const work = vi.fn();
  try {
    await expect(withRecoveryLock(path, identity, work, { now: () => clock, wait: async () => { clock += 1000; } })).rejects.toThrow('recovery_run_locked');
    expect(work).not.toHaveBeenCalled();
  } finally { release.release(); await first; }
});

it('refuses an exhausted ticket instead of rounding or wrapping its order', async () => {
  const path = await root(); await stale(path, 'ready', { ticket: Number.MAX_SAFE_INTEGER }); const work = vi.fn();
  await expect(withRecoveryLock(path, identity, work)).rejects.toThrow('recovery_lock_ticket_exhausted');
  expect(work).not.toHaveBeenCalled(); expect(await readdir(registry(path))).toEqual([`${tokenA}.json`]);
});

it('never lets a delayed reaper delete the replacement owner at a different path', async () => {
  const path = await root(); await stale(path);
  const selected = barrier(); let selecting = 0;
  const reaping = barrier(); const releaseReaper = barrier(); const reaped = barrier();
  const entered = barrier(); const releaseWork = barrier();
  let current: LockRegistration | undefined; let active = 0; let maximum = 0;
  const selectTogether = async () => { if (++selecting === 2) selected.release(); await selected.promise; };
  const first = withRecoveryLock(path, identity, async () => { maximum = Math.max(maximum, ++active); active--; }, {
    token: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    onEvent: async event => {
      if (event.stage === 'ticket_selected') await selectTogether();
      if (event.stage === 'before_reap' && event.peer?.token === tokenA) { reaping.release(); await releaseReaper.promise; }
      if (event.stage === 'after_reap' && event.peer?.token === tokenA) reaped.release();
    },
  });
  // B chooses the same ticket but the earlier token. It can legitimately work
  // while A is delayed reaping S; no live PID is declared dead by this fixture.
  const second = withRecoveryLock(path, identity, async () => {
    maximum = Math.max(maximum, ++active); entered.release(); await releaseWork.promise; active--;
  }, {
    token: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    onEvent: async event => {
      if (event.stage === 'ticket_selected') { await selectTogether(); await reaping.promise; }
      if (event.stage === 'ready_published') current = event.registration;
    },
  });
  await entered.promise;
  const currentPath = join(registry(path), `${current!.token}.json`); const bytes = await readFile(currentPath);
  releaseReaper.release(); await reaped.promise;
  expect(await readFile(currentPath)).toEqual(bytes); expect(active).toBe(1);
  releaseWork.release(); await Promise.all([first, second]); expect(maximum).toBe(1);
});

it('rereads a peer whose atomic ready publication changes an in-flight read', async () => {
  const path = await root(); const entered = barrier(); const release = barrier(); let changed = false;
  const first = withRecoveryLock(path, identity, async () => { entered.release(); await release.promise; });
  await entered.promise;
  let clock = 0;
  const work = vi.fn();
  await expect(withRecoveryLock(path, identity, work, { now: () => clock, wait: async () => { clock += 1000; }, read: async file => {
    if (!changed) { changed = true; throw new Error('changing_source'); }
    return (await readStable(file, 2048)).text;
  } })).rejects.toThrow('recovery_run_locked');
  expect(changed).toBe(true); expect(work).not.toHaveBeenCalled(); release.release(); await first;
});

it.each(['choosing_published', 'ready_published', 'before_reap', 'work'])('recovers after a real child is killed at %s', async stage => {
  const path = await root();
  if (stage === 'before_reap') await stale(path);
  const child = fork(resolve('test/fixtures/original-run-lock-child.ts'), [path, identity, stage], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH } });
  children.push(child);
  const message = await new Promise<unknown>((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`child exited before barrier: ${code}`))); });
  expect(message).toEqual({ stage });
  child.kill('SIGKILL'); await once(child, 'exit');
  await expect(withRecoveryLock(path, identity, async () => 'resumed')).resolves.toBe('resumed');
  expect(await readdir(registry(path))).toEqual([]);
});
