import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { processRoundReport, loadConvergeRunState, loadConvergeRunStateEvidence } from '../../src/converge/run-state.js';
import { fixture, cleanup } from './round-gap-fixtures.js';
afterEach(cleanup);

it('audits a spent missing report without fabricating round two, then admits exact original round three', async () => {
  const f = await fixture(), manifest = await f.prepare(), attempts = await readFile(f.attemptPath);
  expect(manifest.stateSha256).toBe((await loadConvergeRunStateEvidence(f.dir, f.target))?.sha256);
  expect(await f.apply()).toBe('applied'); expect(await f.apply('resume')).toBe('resumed');
  expect((await loadConvergeRunState(f.dir,f.target))?.rounds.map(r => r.round)).toEqual([1]);
  await expect(processRoundReport({ gitCommonDir:f.dir,target:f.target,round:3,findings:f.report.findings,
    runId:f.input.runId,reportSha256:f.input.reportSha256 })).resolves.toHaveProperty('counts');
  expect((await loadConvergeRunState(f.dir,f.target))?.rounds.map(r => r.round)).toEqual([1,3]);
  expect(await readFile(f.attemptPath)).toEqual(attempts);
});
it('refuses an unbound higher report and changed CAS evidence', async () => {
  const f = await fixture();
  await expect(processRoundReport({gitCommonDir:f.dir,target:f.target,round:3,findings:[],runId:f.input.runId,reportSha256:f.input.reportSha256})).rejects.toThrow('out of order');
  await f.prepare(); f.attempts.attemptsUsed = 4;
  await writeFile(f.attemptPath,JSON.stringify(f.attempts));
  await expect(f.apply()).rejects.toThrow('digest_mismatch');
});
it('refuses a changed manifest reusing an already applied operation id', async () => {
  const f = await fixture(), manifest = await f.prepare(); await f.apply();
  await f.save({...manifest,createdAt:'2026-01-01T00:00:00.000Z'});
  await expect(f.apply('resume')).rejects.toThrow('round_gap_operation_conflict');
});

it('refuses findings substituted behind an otherwise correct original report digest', async () => {
  const f = await fixture(); await f.prepare(); await f.apply();
  const before = await readFile(f.statePath);
  await expect(processRoundReport({gitCommonDir:f.dir,target:f.target,round:3,findings:[],runId:f.input.runId,reportSha256:f.input.reportSha256})).rejects.toThrow();
  expect(await readFile(f.statePath)).toEqual(before);
});
it('continues enforcing the exact original report on a rerun of the admitted round', async () => {
  const f = await fixture(); await f.prepare(); await f.apply();
  await processRoundReport({gitCommonDir:f.dir,target:f.target,round:3,findings:f.report.findings,runId:f.input.runId,reportSha256:f.input.reportSha256});
  const before = await readFile(f.statePath);
  await expect(processRoundReport({gitCommonDir:f.dir,target:f.target,round:3,findings:[],runId:f.input.runId,reportSha256:'f'.repeat(64)})).rejects.toThrow();
  expect(await readFile(f.statePath)).toEqual(before);
});
