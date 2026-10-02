import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  claimConvergeAttempt, convergeAttemptStatePath, loadConvergeAttemptState,
  recordConvergeAttemptLaunch, type ConvergeAttemptClaim, type ConvergeAttemptState,
} from '../../src/converge/attempt-budget.js';
import { withNativeTarget, withOwnedNativeOperation } from '../../src/converge/target-ownership.js';
import type { GuardedLaunchState } from '../../src/converge/launch-record.js';

const fault = vi.hoisted(() => ({
  file: '', directory: '', renamed: false, fail: false, failures: 0, synced: 0, readOnlySyncs: 0,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args);
      if (String(args[1]) === fault.file) fault.renamed = true;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) === fault.file && args[1] === 'r') {
        return new Proxy(handle, { get(target, property) {
          if (property === 'sync') return async () => {
            fault.readOnlySyncs++;
            throw Object.assign(new Error('Synthetic Windows read-only fsync refusal.'), { code: 'EACCES' });
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      }
      if (String(args[0]) !== fault.directory) return handle;
      return new Proxy(handle, { get(target, property) {
        if (property === 'sync') return async () => {
          if (fault.renamed && fault.fail) {
            fault.failures++;
            throw Object.assign(new Error('Synthetic attempt-directory fsync failure.'), { code: 'EIO' });
          }
          await target.sync();
          if (fault.renamed) fault.synced++;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
});

let directory: string;
const target = 'synthetic-launch-record';
beforeEach(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'rcl-attempt-launch-'))); });
afterEach(async () => {
  Object.assign(fault, {
    file: '', directory: '', renamed: false, fail: false, failures: 0, synced: 0, readOnlySyncs: 0,
  });
  await rm(directory, { recursive: true, force: true });
});

function pending(claim: Pick<ConvergeAttemptClaim, 'attempt' | 'processIdentity'>): GuardedLaunchState {
  return { status: 'pending', attempt: claim.attempt, round: 2, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
    startedAt: new Date().toISOString(), pid: process.pid,
    ...(claim.processIdentity ? { processIdentity: claim.processIdentity } : {}) };
}
function completed(launch: GuardedLaunchState): GuardedLaunchState {
  return { ...launch, status: 'completed', runId: '00000000-0000-7000-8000-000000000901',
    reportJsonSha256: 'c'.repeat(64), successfulReviews: 2, totalReviews: 2, deliveryPending: false };
}
function persist(launch: GuardedLaunchState) {
  return withNativeTarget(directory, target, ownership => recordConvergeAttemptLaunch(directory, target, launch, ownership));
}
function accounting(state: ConvergeAttemptState) {
  return { version: state.version, target: state.target, cap: state.cap, migratedAttempts: state.migratedAttempts,
    attemptsUsed: state.attemptsUsed, attempts: state.attempts };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('owned attempt launch metadata', () => {
  it.each(['pending', 'completed'] as const)('pins %s input before an earlier owned operation finishes', async status => {
    const claim = await claimConvergeAttempt({ gitCommonDir: directory, target, maxAttempts: 4 });
    const first = pending(claim);
    if (status === 'completed') await persist(first);
    // Retain the caller's nested reference, including terminal completion facts.
    const request = { launch: status === 'completed' ? completed(first) : first };
    const expected = structuredClone(request.launch);
    const before = accounting((await loadConvergeAttemptState(directory, target))!);
    await withNativeTarget(directory, target, async ownership => {
      const entered = barrier(), release = barrier();
      const earlier = withOwnedNativeOperation(ownership, directory, target, async () => {
        entered.resolve(); await release.promise;
      });
      await entered.promise;
      const recorded = recordConvergeAttemptLaunch(directory, target, request.launch, ownership);
      if (status === 'pending') request.launch.headSha = 'd'.repeat(40);
      else {
        request.launch.runId = '00000000-0000-7000-8000-000000000902';
        request.launch.reportJsonSha256 = 'e'.repeat(64);
        request.launch.successfulReviews = 1;
      }
      release.resolve();
      await Promise.all([earlier, recorded]);
    });

    const after = (await loadConvergeAttemptState(directory, target))!;
    expect(after.lastLaunch).toEqual(expected);
    expect(accounting(after)).toEqual(before);
  });

  it.each(['foreign-pid', 'migrated-only'] as const)('refuses retained launch attribution for %s without rewriting the ledger', async kind => {
    await writeFile(join(directory, `rcl-converge-${target}-ledger.md`), '## Round 2\n', { mode: 0o600 });
    const claim = await claimConvergeAttempt({ gitCommonDir: directory, target, maxAttempts: 7 });
    expect(claim.attempt).toBe(3);
    const path = convergeAttemptStatePath(directory, target);
    const state = (await loadConvergeAttemptState(directory, target))!;
    state.lastLaunch = pending({ attempt: kind === 'migrated-only' ? 2 : claim.attempt,
      ...(kind === 'foreign-pid' && claim.processIdentity ? { processIdentity: claim.processIdentity } : {}) });
    if (kind === 'foreign-pid') state.lastLaunch.pid = process.pid + 1;
    const corrupted = JSON.stringify(state);
    await writeFile(path, corrupted, { mode: 0o600 });

    await expect(loadConvergeAttemptState(directory, target)).rejects.toThrow(/launch|claim|attempt/i);

    expect(await readFile(path, 'utf8')).toBe(corrupted);
  });

  it('retains a valid older launch and every claim when the next attempt is spent', async () => {
    const first = await claimConvergeAttempt({ gitCommonDir: directory, target, maxAttempts: 4 });
    const launch = pending(first);
    await persist(launch);
    await persist(completed(launch));
    const before = (await loadConvergeAttemptState(directory, target))!;

    await claimConvergeAttempt({ gitCommonDir: directory, target });

    const after = (await loadConvergeAttemptState(directory, target))!;
    expect(after.lastLaunch).toEqual(before.lastLaunch);
    expect(after).toMatchObject({ cap: 4, migratedAttempts: 0, attemptsUsed: 2 });
    expect(after.attempts.slice(0, 1)).toEqual(before.attempts);
    expect(after.attempts.map(record => record.attempt)).toEqual([1, 2]);
  });

  it.runIf(process.platform !== 'win32')('retries directory durability after rename without changing committed accounting or launch facts', async () => {
    await writeFile(join(directory, `rcl-converge-${target}-ledger.md`), '## Round 2\n', { mode: 0o600 });
    const claim = await claimConvergeAttempt({ gitCommonDir: directory, target, maxAttempts: 7 });
    const before = (await loadConvergeAttemptState(directory, target))!;
    const launch = pending(claim);
    const path = convergeAttemptStatePath(directory, target);
    Object.assign(fault, { file: path, directory: dirname(path), fail: true });

    await expect(persist(launch)).rejects.toThrow(/sync|durab/i);
    expect(fault.renamed).toBe(true);
    expect(fault.failures).toBe(1);
    const committed = (await loadConvergeAttemptState(directory, target))!;
    expect(committed.lastLaunch).toEqual(launch);
    expect(accounting(committed)).toEqual(accounting(before));

    await expect(persist(launch)).rejects.toThrow(/sync|durab/i);
    expect(fault.failures + fault.readOnlySyncs).toBe(2);
    fault.fail = false;
    await persist(launch);

    expect(fault.readOnlySyncs).toBe(0);
    expect(fault.synced).toBeGreaterThan(0);
    const after = (await loadConvergeAttemptState(directory, target))!;
    expect(after.lastLaunch).toEqual(committed.lastLaunch);
    expect(accounting(after)).toEqual(accounting(before));
  });
});
