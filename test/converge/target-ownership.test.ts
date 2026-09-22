import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withNativeTarget, withRecoveryTarget, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, writeState } from '../../src/converge/run-state.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';

let dir: string;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-target-ownership-'))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const target = 'synthetic-recovery';
function finding(index = 0): ConsensusFinding {
  return { id: `finding-${index}`, identity: `key-${index}`, file: `src/file-${index}.ts`, startLine: 1, endLine: 2,
    severity: 'important', category: 'correctness', title: `Claim ${index}`, description: 'Synthetic review',
    consensus: { score: 2, total: 3, models: ['first', 'second'], roles: ['general'], crossRole: false,
      crossModel: true, elevated: false, elevation: 'none', confidence: 0.8, confidenceLabel: 'High', tier: 'majority' },
    gating: { reason: 'consensus' } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('serializes sibling report operations under one explicit owner before reading their v1 source', async () => {
  await withNativeTarget(dir, target, async ownership => {
    const results = await Promise.all([1, 2].map(round => processRoundReport({
      gitCommonDir: dir, target, ownership, round, findings: [finding()],
    })));
    expect(results.map(result => result.findings[0]!.status)).toEqual(['new', 'repeat']);
  });
  const state = (await loadConvergeRunState(dir, target))!;
  expect(state.version).toBe(1);
  expect(state.rounds.map(round => round.round)).toEqual([1, 2]);
  expect(Object.values(state.findings)).toHaveLength(1);
});

it('permits a different target to progress during recovery', async () => {
  await withRecoveryTarget(dir, target, async () => {
    await processRoundReport({ gitCommonDir: dir, target: 'unrelated', round: 1, findings: [] });
    expect((await loadConvergeRunState(dir, 'unrelated'))?.rounds).toHaveLength(1);
  });
});



it('rejects forged, wrong-target and released write authority without native mutation', async () => {
  await processRoundReport({ gitCommonDir: dir, target, round: 1, findings: [finding()] });
  const state = (await loadConvergeRunState(dir, target))!, before = await readFile(convergeRunStatePath(dir, target));
  await expect(writeState(dir, state, { target })).rejects.toThrow('native_target_not_owned');
  let expired!: NativeTargetOwnership;
  await withNativeTarget(dir, target, async ownership => {
    expired = ownership;
    await expect(writeState(dir, { ...state, target: 'another' }, ownership)).rejects.toThrow('native_target_not_owned');
  });
  await expect(writeState(dir, state, expired)).rejects.toThrow('native_target_not_owned');
  expect(await readFile(convergeRunStatePath(dir, target))).toEqual(before);
});

it('serializes a separately launched native writer under recovery ownership', async () => {
  const worker = new URL('../fixtures/native-target-worker.ts', import.meta.url);
  const entered = deferred(), release = deferred();
  let authority!: NativeTargetOwnership;
  const owner = withRecoveryTarget(dir, target, async ownership => { authority = ownership; entered.resolve(); await release.promise; });
  let child: Promise<unknown> | undefined;
  try {
    await Promise.race([entered.promise, owner]);
    child = promisify(execFile)(process.execPath, ['--import', 'tsx', worker.pathname, dir, target], { timeout: 10_000 });
    void child.catch(() => {});
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await readFile(join(dir, 'child-ready')); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    await expect(readFile(convergeRunStatePath(dir, target))).rejects.toMatchObject({ code: 'ENOENT' });
    // A separate process must read the state again after obtaining ownership.
    // Install a synthetic valid round while it is waiting, preserving our lock.
    await writeState(dir, { version: 1, target, roundCap: 15, rounds: [
      { round: 1, counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } },
    ], findings: {}, updatedAt: new Date().toISOString() }, authority);
  } finally {
    release.resolve();
    const settled = await Promise.allSettled([owner, ...(child ? [child] : [])]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
  }
  expect((await loadConvergeRunState(dir, target))?.rounds.map(round => round.round)).toEqual([1, 2]);
}, 15_000);
