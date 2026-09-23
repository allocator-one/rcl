import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { claimConvergeAttempt, convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { sampleFinding } from '../telemetry/fixtures.js';

let dir: string;
const target = 'synthetic-main-writer';
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-main-owner-'))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it.each(['report', 'verdict', 'attempt'])('excludes the main %s writer for the entire recovery target transaction', async kind => {
  const initial = kind === 'verdict' ? await processRoundReport({ gitCommonDir: dir, target, round: 1, findings: [sampleFinding()] }) : undefined;
  const path = kind === 'attempt' ? convergeAttemptStatePath(dir, target) : convergeRunStatePath(dir, target);
  const before = initial ? await readFile(path) : undefined;
  const entered = barrier(), release = barrier();
  const owner = withRecoveryTarget(dir, target, async () => { entered.resolve(); await release.promise; });
  let writer: Promise<unknown> | undefined;
  try {
    await Promise.race([entered.promise, owner]);
    writer = kind === 'attempt' ? claimConvergeAttempt({ gitCommonDir: dir, target })
      : kind === 'report' ? processRoundReport({ gitCommonDir: dir, target, round: 1, findings: [] })
        : recordVerdicts({ gitCommonDir: dir, target, round: 1,
          verdicts: [{ key: initial!.findings[0]!.identity, verdict: 'dismissed', reason: 'Synthetic guard' }] });
    void writer.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 150));
    if (before) expect(await readFile(path)).toEqual(before);
    else await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release.resolve();
    const settled = await Promise.allSettled([owner, ...(writer ? [writer] : [])]);
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
  }
  if (kind === 'attempt') expect(await loadConvergeAttemptState(dir, target)).toMatchObject({ attemptsUsed: 1, cap: 20 });
  else expect((await loadConvergeRunState(dir, target))?.version).toBe(1);
});

it('retains all concurrent main verdict updates without changing v1 identity or round semantics', async () => {
  const findings = Array.from({ length: 6 }, (_, i) => sampleFinding({ file: `src/synthetic-${i}.ts`, identity: `original-${i}` }));
  const round = await processRoundReport({ gitCommonDir: dir, target, round: 1, findings });
  await Promise.all(round.findings.map(({ identity }) => recordVerdicts({ gitCommonDir: dir, target, round: 1,
    verdicts: [{ key: identity, verdict: 'dismissed', reason: 'Independent synthetic triage' }] })));
  const state = (await loadConvergeRunState(dir, target))!;
  expect(Object.values(state.findings).filter(entry => entry.verdict === 'dismissed')).toHaveLength(6);
  expect(state.version).toBe(1); expect(state.rounds).toHaveLength(1); expect(state.roundCap).toBe(15);
  expect(Object.keys(state.findings).sort()).toEqual(round.findings.map(f => f.identity).sort());
});
