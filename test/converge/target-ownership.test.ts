import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  let child: ReturnType<typeof fork> | undefined;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let ordinaryWriterCommitted = false;
  try {
    await Promise.race([entered.promise, owner]);
    const lockRoot = join(dir, 'rcl-native-target-locks');
    const lockName = `${createHash('sha256').update(target).digest('hex')}.lock`;
    const before = await readFile(join(lockRoot, lockName));
    // The fixture invokes processRoundReport without an ownership token. It
    // wraps only the real legacy link publication and reports two exact
    // EEXIST retries through complete IPC messages.
    child = fork(fileURLToPath(worker), [dir, target], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    childExit = new Promise(resolve => child!.once('exit', (code, signal) => resolve({ code, signal })));
    const retries = new Promise<void>((resolve, reject) => {
      let count = 0;
      child!.on('message', message => {
        if (!message || typeof message !== 'object') return;
        const event = message as { type?: unknown; pid?: unknown };
        if (event.type === 'legacy_lock_retry' && event.pid === child!.pid && ++count === 2) resolve();
        if (event.type === 'ordinary_writer_committed' && event.pid === child!.pid) ordinaryWriterCommitted = true;
      });
      child!.once('error', reject);
    });
    await Promise.race([retries, childExit.then(exit => {
      throw new Error(`ordinary writer exited before observing retries: ${exit.code ?? exit.signal}`);
    })]);
    expect(await readFile(join(lockRoot, lockName))).toEqual(before);
    await expect(readFile(convergeRunStatePath(dir, target))).rejects.toMatchObject({ code: 'ENOENT' });
    // A separate process must read the state again after obtaining ownership.
    // Install a synthetic valid round while it is waiting, preserving our lock.
    await writeState(dir, { version: 1, target, roundCap: 15, rounds: [
      { round: 1, counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } },
    ], findings: {}, updatedAt: new Date().toISOString() }, authority);
  } finally {
    release.resolve();
    await owner;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      if (childExit) {
        exit = await Promise.race([
          childExit,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ordinary writer did not exit after release')), 5_000)),
        ]);
      }
    } finally {
      if (child && child.exitCode === null) child.kill();
    }
    expect(exit).toEqual({ code: 0, signal: null });
    expect(ordinaryWriterCommitted).toBe(true);
  }
  expect((await loadConvergeRunState(dir, target))?.rounds.map(round => round.round)).toEqual([1, 2]);
}, 15_000);
