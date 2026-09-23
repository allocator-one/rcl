import { expect, it } from 'vitest';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './round-gap-fixtures.js';
import { previewRoundGap } from '../../src/converge/round-gap.js';
import { loadConvergeRunState, processRoundReport } from '../../src/converge/run-state.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

async function laterGap(auditedEarlierGap = false) {
  const f = await fixture();
  if (auditedEarlierGap) {
    await f.prepare(); await f.apply();
    await processRoundReport({ gitCommonDir: f.dir, target: f.target, round: 3,
      findings: f.report.findings, runId: f.input.runId, reportSha256: f.input.reportSha256 });
  } else {
    for (const round of [2, 3]) await processRoundReport({ gitCommonDir: f.dir, target: f.target, round, findings: [] });
  }
  f.attempts.attemptsUsed = 5;
  for (const attempt of [4, 5]) f.attempts.attempts.push({ ...f.attempts.attempts[0]!, attempt });
  await writeFile(f.attemptPath, JSON.stringify(f.attempts));
  f.report.run!.converge!.round = 5; f.report.run!.converge!.attempt = 5;
  await writeFile(f.input.reportPath, JSON.stringify(f.report));
  Object.assign(f.input, { gapRound: 4, admittingRound: 5, attempt: 4, reportSha256: sha256(await readFile(f.input.reportPath)) });
  return f;
}

async function omitRoundTwo(f: Awaited<ReturnType<typeof laterGap>>) {
  const state = JSON.parse((await readFile(f.statePath)).toString());
  state.rounds = state.rounds.filter((r: { round: number }) => r.round !== 2);
  await writeFile(f.statePath, JSON.stringify(state));
}

it('refuses preview over an unexplained earlier hole without changing selected state or creating audit files', async () => {
  const f = await laterGap(); await omitRoundTwo(f);
  const native = await readFile(f.statePath), attempts = await readFile(f.attemptPath), names = (await readdir(f.dir)).sort();
  await expect(previewRoundGap(f.input, f.dir)).rejects.toThrow('round_gap_not_contiguous');
  expect(await readFile(f.statePath)).toEqual(native); expect(await readFile(f.attemptPath)).toEqual(attempts);
  expect((await readdir(f.dir)).sort()).toEqual(names);
});

it('refuses an exact manifest bound to an incomplete prefix before native mutation or audit retention', async () => {
  const f = await laterGap(), manifest = await f.prepare(); await omitRoundTwo(f);
  const native = await readFile(f.statePath), attempts = await readFile(f.attemptPath);
  await f.save({ ...manifest, stateSha256: sha256(native) });
  await expect(f.apply()).rejects.toThrow('round_gap_not_contiguous');
  expect(await readFile(f.statePath)).toEqual(native); expect(await readFile(f.attemptPath)).toEqual(attempts);
  await expect(readdir(join(f.dir, 'rcl-converge-gap-audits'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses an additional gap after an earlier audited gap rather than treating audit metadata as prefix coverage', async () => {
  const f = await laterGap(true), native = await readFile(f.statePath), attempts = await readFile(f.attemptPath);
  const priorOperations = (await readdir(join(f.dir, 'rcl-converge-gap-audits'))).sort();
  await expect(previewRoundGap(f.input, f.dir)).rejects.toThrow('round_gap_not_contiguous');
  expect(await readFile(f.statePath)).toEqual(native); expect(await readFile(f.attemptPath)).toEqual(attempts);
  expect((await readdir(join(f.dir, 'rcl-converge-gap-audits'))).sort()).toEqual(priorOperations);
});

it('admits a later single gap after a complete ordinary prefix while preserving its exact history and attempts', async () => {
  const f = await laterGap(), before = (await loadConvergeRunState(f.dir, f.target))!, attempts = await readFile(f.attemptPath);
  await f.prepare(); expect(await f.apply()).toBe('applied'); expect(await f.apply('resume')).toBe('resumed');
  expect((await loadConvergeRunState(f.dir, f.target))!.rounds).toEqual(before.rounds);
  await processRoundReport({ gitCommonDir: f.dir, target: f.target, round: 5,
    findings: f.report.findings, runId: f.input.runId, reportSha256: f.input.reportSha256 });
  const after = (await loadConvergeRunState(f.dir, f.target))!;
  expect(after.rounds.map(r => r.round)).toEqual([1, 2, 3, 5]);
  expect(after.rounds.slice(0, 3)).toEqual(before.rounds); expect(await readFile(f.attemptPath)).toEqual(attempts);
});
