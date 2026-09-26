import { staleFixture as fixture } from './stale-report-fixtures.js';
import { expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { loadConvergeRunState, processRoundReport } from '../../src/converge/run-state.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { previewStaleReport, applyStaleReport } from '../../src/converge/stale-report.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';


it('preserves the stale report and spent attempt, then guards exactly one fresh launch at the native ordinal', async () => {
  const f = await fixture(), before = await f.bytes();
  await expect(guardReviewLaunch({...f.options,...f.selection})).rejects.toThrow('report_not_admitted');
  await f.prepare(); expect(await f.bytes()).toEqual(before);
  expect(await f.apply()).toBe('applied');
  expect(await f.apply('resume')).toBe('resumed');
  expect((await f.bytes()).slice(1)).toEqual(before.slice(1));
  expect(await loadConvergeRunState(f.dir,f.target)).toMatchObject({rounds:[],findings:{},lastLaunch:{attempt:1,round:1}});
  await guardReviewLaunch({...f.options,...f.selection});
  expect(f.options.run.mock.calls.at(-1)?.[0]).toEqual({target:f.target,round:1,attempt:2});
  expect(await loadConvergeAttemptState(f.dir,f.target)).toMatchObject({attemptsUsed:2,cap:20});
});

it('requires ordinary admission for unchanged input, even with an explicit stale reason', async () => {
  const f = await fixture(), before = await f.bytes();
  await expect(previewStaleReport({...f.selection,headSha:f.options.headSha,inputSha256:f.options.inputSha256},f.dir)).rejects.toThrow('inputs_unchanged');
  expect(await f.bytes()).toEqual(before);
});

it('refuses changed native evidence before applying the reviewed manifest', async () => {
  const f = await fixture(); await f.prepare();
  await writeFile(f.statePath,(await readFile(f.statePath,'utf8'))+'\n');
  const before = await f.bytes(); await expect(f.apply()).rejects.toThrow('digest_mismatch');
  expect(await f.bytes()).toEqual(before);
});

it('cannot use the disposition for a different current input or admit the preserved stale report', async () => {
  const f = await fixture(); await f.prepare(); await f.apply(); const before = await f.bytes();
  await expect(guardReviewLaunch({...f.options,...f.selection,inputSha256:'e'.repeat(64)})).rejects.toThrow('stale_report_input_mismatch');
  await expect(processRoundReport({gitCommonDir:f.dir,target:f.target,round:1,runId:(await loadConvergeRunState(f.dir,f.target))!.lastLaunch!.runId,
    reportSha256:f.reportSha256,findings:[]})).rejects.toThrow('stale_report_cannot_be_admitted');
  expect(await f.bytes()).toEqual(before);
});

it('audits a corrected replacement input without spending another attempt', async () => {
  const f = await fixture(); await f.prepare(); await f.apply();
  const corrected = {...f.selection,headSha:'e'.repeat(40),inputSha256:'f'.repeat(64),reason:'The inspected replacement inputs changed before continuation.'};
  await expect(guardReviewLaunch({...f.options,...corrected})).rejects.toThrow('stale_report_input_mismatch');
  const manifest = await previewStaleReport(corrected,f.dir);
  const manifestPath = join(f.dir,'corrected-manifest.json');
  await writeFile(manifestPath,JSON.stringify(manifest));
  await expect(applyStaleReport({manifest:manifestPath,manifestSha256:sha256(await readFile(manifestPath)),mode:'apply'},f.dir)).resolves.toBe('applied');
  expect((await loadConvergeRunState(f.dir,f.target))?.staleReportAudit).toHaveLength(2);
  await guardReviewLaunch({...f.options,...corrected});
  expect(f.options.run.mock.calls.at(-1)?.[0]).toEqual({target:f.target,round:1,attempt:2});
  expect(await loadConvergeAttemptState(f.dir,f.target)).toMatchObject({attemptsUsed:2});
});

it.each(['beforeNativeWrite','afterNativeWrite'] as const)('resumes an interruption at %s without spending or fabricating a round', async boundary => {
  const f = await fixture(); await f.prepare(); const original = await f.bytes();
  await expect(f.apply('apply',{[boundary]:async () => {throw new Error('interrupted');}})).rejects.toThrow('interrupted');
  await f.apply('resume');
  expect((await f.bytes()).slice(1)).toEqual(original.slice(1));
  expect((await loadConvergeRunState(f.dir,f.target))?.staleReportAudit).toHaveLength(1);
  await guardReviewLaunch({...f.options,...f.selection});
  expect(await loadConvergeAttemptState(f.dir,f.target)).toMatchObject({attemptsUsed:2});
});

it.each(['pending','failed','delivery','unhealthy','hardFailure'] as const)('refuses unsupported %s outcomes without touching evidence', async kind => {
  const f = await fixture(), state = (await loadConvergeRunState(f.dir,f.target))!;
  if (kind === 'pending' || kind === 'failed') state.lastLaunch!.status = kind;
  if (kind === 'delivery') state.lastLaunch!.deliveryPending = true;
  if (kind === 'unhealthy') state.lastLaunch!.successfulReviews = 1;
  if (kind === 'hardFailure') state.lastLaunch!.hardFailure = true;
  await writeFile(f.statePath,JSON.stringify(state)); const before = await f.bytes();
  await expect(f.prepare()).rejects.toThrow('stale_report_outcome_ineligible');
  expect(await f.bytes()).toEqual(before);
});

it('refuses a forged manifest binding and leaves state and budgets unchanged', async () => {
  const f = await fixture(), manifest = await f.prepare(), before = await f.bytes();
  await writeFile(f.manifestPath,JSON.stringify({...manifest,runId:'019921a0-0000-7000-8000-000000000002'}));
  await expect(f.apply()).rejects.toThrow('stale_report_manifest_binding_mismatch');
  expect(await f.bytes()).toEqual(before);
});

it('refuses a deleted receipt rather than treating an audit entry as permission', async () => {
  const f = await fixture(), m = await f.prepare(); await f.apply();
  await rm(join(f.dir,'rcl-stale-report-audits',m.operationId,'complete.json'));
  const before = await f.bytes();
  await expect(guardReviewLaunch({...f.options,...f.selection})).rejects.toMatchObject({code:'stale_report_audit_invalid'});
  expect(await f.bytes()).toEqual(before);
  expect(f.options.run).toHaveBeenCalledTimes(1);
});

it('serializes conflicting dispositions and preserves the winner', async () => {
  const f = await fixture(); await f.prepare();
  const other = await previewStaleReport({...f.selection,reason:'Another explicit inspected disposition.'},f.dir);
  const path = join(f.dir,'other.json'); await writeFile(path,JSON.stringify(other));
  const results = await Promise.allSettled([f.apply(), applyStaleReport({manifest:path,manifestSha256:sha256(await readFile(path)),mode:'apply'},f.dir)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await loadConvergeRunState(f.dir,f.target))?.staleReportAudit).toHaveLength(1);
  expect(await loadConvergeAttemptState(f.dir,f.target)).toMatchObject({attemptsUsed:1});
});

it('does not let stale recovery raise an exhausted attempt cap', async () => {
  const f = await fixture(), attempts = JSON.parse(await readFile(f.attemptsPath,'utf8')); attempts.cap = 1;
  await writeFile(f.attemptsPath,JSON.stringify(attempts));
  await f.prepare(); await f.apply(); const before = await f.bytes();
  await expect(guardReviewLaunch({...f.options,...f.selection})).rejects.toThrow(/budget exhausted/i);
  expect(await f.bytes()).toEqual(before);
});

it('preserves all earlier finding obligations and admitted rounds during stale continuation', async () => {
  const f = await fixture(false,true), before = (await loadConvergeRunState(f.dir,f.target))!;
  await f.prepare(); await f.apply(); await guardReviewLaunch({...f.options,...f.selection});
  const after = (await loadConvergeRunState(f.dir,f.target))!;
  expect(after.rounds).toEqual(before.rounds); expect(after.findings).toEqual(before.findings);
  expect(after.lastAnnotations).toEqual(before.lastAnnotations);
  expect(f.options.run.mock.calls.at(-1)?.[0]).toEqual({target:f.target,round:2,attempt:2});
});

it('refuses disposition when an earlier admitted obligation is unresolved', async () => {
  const f = await fixture(false,true), state = (await loadConvergeRunState(f.dir,f.target))!;
  for (const entry of Object.values(state.findings)) { delete entry.verdict; delete entry.verdictRound; }
  await writeFile(f.statePath,JSON.stringify(state)); const before = await f.bytes();
  await expect(f.prepare()).rejects.toThrow('triage_required');
  expect(await f.bytes()).toEqual(before);
});

it('refuses changed attempts after disposition even with an explicit retry reason', async () => {
  const f = await fixture(); await f.prepare(); await f.apply();
  const attempts = JSON.parse(await readFile(f.attemptsPath,'utf8'));
  attempts.attemptsUsed = 2; attempts.attempts.push({...attempts.attempts[0],attempt:2});
  await writeFile(f.attemptsPath,JSON.stringify(attempts)); const before = await f.bytes();
  await expect(guardReviewLaunch({...f.options,...f.selection,retryReason:'Cannot replace the original inspection.'})).rejects.toThrow('stale_report_attempt_mismatch');
  expect(await f.bytes()).toEqual(before);
});

it('continues the incident shape at attempt 18 and round 14 while retaining 13 admitted rounds', async () => {
  const f = await fixture(false,true), state = (await loadConvergeRunState(f.dir,f.target))!;
  state.rounds = Array.from({length:13},(_,i)=>({...state.rounds[0],round:i+1}));
  state.lastAnnotations!.round = 13;
  for (const finding of Object.values(state.findings)) finding.verdictRound = 13;
  state.lastLaunch!.attempt = 17; state.lastLaunch!.round = 14;
  const report = JSON.parse(await readFile(f.reportPath,'utf8'));
  report.run.converge = {target:f.target,attempt:17,round:14};
  await writeFile(f.reportPath,JSON.stringify(report));
  f.selection.reportSha256 = sha256(await readFile(f.reportPath)); state.lastLaunch!.reportJsonSha256 = f.selection.reportSha256;
  await writeFile(f.statePath,JSON.stringify(state));
  const attempts = JSON.parse(await readFile(f.attemptsPath,'utf8'));
  attempts.attemptsUsed = 17; attempts.attempts = Array.from({length:17},(_,i)=>({...attempts.attempts[0],attempt:i+1}));
  await writeFile(f.attemptsPath,JSON.stringify(attempts));
  const before = await f.bytes(); await f.prepare(); await f.apply();
  expect((await f.bytes()).slice(1)).toEqual(before.slice(1));
  await guardReviewLaunch({...f.options,...f.selection});
  expect(f.options.run.mock.calls.at(-1)?.[0]).toEqual({target:f.target,attempt:18,round:14});
  const after = (await loadConvergeRunState(f.dir,f.target))!;
  expect(after.rounds).toEqual(state.rounds); expect(after.findings).toEqual(state.findings);
  expect(await loadConvergeAttemptState(f.dir,f.target)).toMatchObject({attemptsUsed:18,cap:20});
});
