import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimConvergeAttempt, ConvergeAttemptPostClaimError, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { loadConvergeRunState, processRoundReport, writeState } from '../../src/converge/run-state.js';
import { withNativeTarget, withRecoveryTarget } from '../../src/converge/target-ownership.js';

const faults = vi.hoisted(() => ({ release: false, pausePath: '', entered: () => {}, wait: Promise.resolve(), failWrite: false }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      await fs.unlink(...args);
      if (faults.release && String(args[0]).includes('/rcl-native-target-locks/') && String(args[0]).endsWith('.json')) {
        faults.release = false;
        throw Object.assign(new Error('Synthetic outer cleanup acknowledgment lost'), { code: 'EIO' });
      }
    },
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (String(args[0]) === faults.pausePath) {
        faults.pausePath = ''; faults.entered(); await faults.wait;
        if (faults.failWrite) throw new Error('Synthetic detached write failure');
      }
      return fs.mkdir(...args);
    },
  };
});

let dir: string;
const target = 'synthetic-owner-boundary';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-native-boundary-'))); });
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  faults.release = false; faults.pausePath = ''; faults.failWrite = false;
  await rm(dir, { recursive: true, force: true });
});

it('preserves ordinary attempt and round operations in the Windows platform branch', async () => {
  // Branch simulation, not Windows filesystem qualification. Existing attempt
  // durability explicitly skips directory fsync on Windows.
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  await expect(claimConvergeAttempt({ gitCommonDir: dir, target })).resolves.toMatchObject({ attempt: 1 });
  await expect(processRoundReport({ gitCommonDir: dir, target, round: 1, findings: [] })).resolves.toMatchObject({ roundCap: 15 });
  expect((await loadConvergeRunState(dir, target))?.rounds).toHaveLength(1);
  const recovery = vi.fn();
  await expect(withRecoveryTarget(dir, target, recovery)).rejects.toThrow('unsupported_recovery_lock_scope');
  expect(recovery).not.toHaveBeenCalled();
});

it('returns a committed attempt after publication with a do-not-retry warning when outer cleanup fails', async () => {
  const published = vi.fn(async () => {
    expect((await loadConvergeAttemptState(dir, target))?.attemptsUsed).toBe(1);
    faults.release = true;
  });
  await expect(claimConvergeAttempt({ gitCommonDir: dir, target, afterClaim: published })).resolves.toMatchObject({
    attempt: 1, warning: expect.stringMatching(/durably recorded.*Do not retry/s),
  });
  expect(published).toHaveBeenCalledTimes(1);
  expect((await loadConvergeAttemptState(dir, target))?.attemptsUsed).toBe(1);
});

it('keeps a failed post-claim operation inside ownership without rolling back or duplicating the attempt', async () => {
  const entered = barrier(), release = barrier();
  const failure = new Error('Synthetic publication failure');
  const claim = claimConvergeAttempt({ gitCommonDir: dir, target, afterClaim: async () => {
    entered.resolve(); await release.promise; throw failure;
  } });
  void claim.catch(() => {});
  let next: ReturnType<typeof claimConvergeAttempt> | undefined;
  try {
    await Promise.race([entered.promise, claim]);
    next = claimConvergeAttempt({ gitCommonDir: dir, target });
    void next.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    expect((await loadConvergeAttemptState(dir, target))?.attemptsUsed).toBe(1);
    release.resolve();
    await expect(claim).rejects.toBeInstanceOf(ConvergeAttemptPostClaimError);
    await expect(claim).rejects.toMatchObject({
      name: 'ConvergeAttemptPostClaimError', claim: { target, attempt: 1 }, cause: failure,
    });
    expect(await next).toMatchObject({ attempt: 2 });
    expect((await loadConvergeAttemptState(dir, target))?.attempts.map(entry => entry.attempt)).toEqual([1, 2]);
  } finally {
    release.resolve(); await Promise.allSettled([claim, ...(next ? [next] : [])]);
  }
});

it('preserves the committed claim when post-claim work and target cleanup both fail', async () => {
  const failure = new Error('Synthetic publication failure');
  const claim = claimConvergeAttempt({ gitCommonDir: dir, target, afterClaim: async () => {
    faults.release = true;
    throw failure;
  } });
  await expect(claim).rejects.toMatchObject({
    name: 'ConvergeAttemptPostClaimError', claim: { target, attempt: 1 }, cause: failure,
  });
  expect((await loadConvergeAttemptState(dir, target))?.attemptsUsed).toBe(1);
});

it('pins attempt ownership inputs before waiting for a target lock', async () => {
  const other = 'synthetic-owner-other';
  const entered = barrier(), release = barrier();
  const holder = withNativeTarget(dir, target, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const options = { gitCommonDir: dir, target };
  const claim = claimConvergeAttempt(options);
  void claim.catch(() => {});
  try {
    options.target = other;
    release.resolve();
    await expect(claim).resolves.toMatchObject({ target, attempt: 1 });
    expect((await loadConvergeAttemptState(dir, target))?.attemptsUsed).toBe(1);
    expect(await loadConvergeAttemptState(dir, other)).toBeUndefined();
  } finally {
    release.resolve();
    await Promise.allSettled([holder, claim]);
  }
});

it('keeps attempt state in the canonical directory when a caller symlink is retargeted while waiting', async () => {
  const canonical = join(dir, 'canonical'), diverted = join(dir, 'diverted'), alias = join(dir, 'alias');
  await mkdir(canonical); await mkdir(diverted); await symlink(canonical, alias);
  const entered = barrier(), release = barrier();
  const holder = withNativeTarget(canonical, target, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const claim = claimConvergeAttempt({ gitCommonDir: alias, target });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    await unlink(alias); await symlink(diverted, alias);
    release.resolve();
    await expect(claim).resolves.toMatchObject({ attempt: 1 });
    expect((await loadConvergeAttemptState(canonical, target))?.attemptsUsed).toBe(1);
    expect(await loadConvergeAttemptState(diverted, target)).toBeUndefined();
  } finally {
    release.resolve();
    await Promise.allSettled([holder, claim]);
  }
});

it('uses caller lock timing while waiting for target ownership', async () => {
  const entered = barrier(), release = barrier();
  const holder = withNativeTarget(dir, target, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const claim = claimConvergeAttempt({ gitCommonDir: dir, target, lockTimeoutMs: 25, lockRetryMs: 1 });
  try {
    const result = await Promise.race([
      claim.then(() => 'resolved', error => error),
      new Promise(resolve => setTimeout(() => resolve('late'), 250)),
    ]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('recovery_run_locked');
  } finally {
    release.resolve();
    await Promise.allSettled([holder, claim]);
  }
});

it.each([false, true])('drains a started owned write before release and surfaces detached failure=%s', async failure => {
  const entered = barrier(), releaseWrite = barrier();
  faults.pausePath = join(dir, 'rcl-converge-runs'); faults.entered = entered.resolve;
  faults.wait = releaseWrite.promise; faults.failWrite = failure;
  let detached: Promise<void> | undefined, settled = false;
  const state = { version: 1 as const, target, roundCap: 12, rounds: [], findings: {}, updatedAt: new Date().toISOString() };
  const first = withNativeTarget(dir, target, async ownership => {
    detached = writeState(dir, state, ownership); void detached.catch(() => {});
    await entered.promise;
  }).finally(() => { settled = true; });
  void first.catch(() => {});
  let second: Promise<void> | undefined;
  try {
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 100));
    expect.soft(settled).toBe(false);
    second = withNativeTarget(dir, target, async ownership => {
      await writeState(dir, { ...state, roundCap: 15 }, ownership);
    });
    void second.catch(() => {});
    releaseWrite.resolve();
    if (failure) await expect(first).rejects.toThrow('Synthetic detached write failure');
    else await expect(first).resolves.toBeUndefined();
    await second;
    expect((await loadConvergeRunState(dir, target))?.roundCap).toBe(15);
  } finally {
    releaseWrite.resolve();
    await Promise.allSettled([first, ...(second ? [second] : []), ...(detached ? [detached] : [])]);
  }
});
