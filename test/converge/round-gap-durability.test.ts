import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, cleanup } from './round-gap-fixtures.js';
import { applyRoundGap, previewRoundGap, roundGapOperationPath } from '../../src/converge/round-gap.js';
import { claimConvergeAttempt } from '../../src/converge/attempt-budget.js';
import { loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
afterEach(cleanup);

it('preserves exact original snapshots, finding history and counters with an explicit unknown exit', async () => {
  const f = await fixture();
  const r1 = await processRoundReport({gitCommonDir:f.dir,target:f.target,round:1,findings:[
    sampleFinding({identity:'1111111111111111',file:'pending.ts',severity:'critical',gating:{reason:'critical'}}),
    sampleFinding({identity:'2222222222222222',file:'dismissed.ts'}),sampleFinding({identity:'3333333333333333',file:'fixed.ts'})]});
  await recordVerdicts({gitCommonDir:f.dir,target:f.target,round:1,verdicts:[
    {key:r1.findings[1]!.identity,verdict:'dismissed',reason:'Exact original dismissal'},
    {key:r1.findings[2]!.identity,verdict:'fixed',reason:'Actual change requires later evidence'}]});
  const before = await readFile(f.statePath), attempts = await readFile(f.attemptPath), report = await readFile(f.input.reportPath);
  const m = await f.prepare(); await f.apply(); const dir = roundGapOperationPath(f.dir,m.operationId);
  expect(await readFile(join(dir,'native-before.json'))).toEqual(before);
  expect(await readFile(join(dir,'attempts-before.json'))).toEqual(attempts);
  expect(await readFile(join(dir,'source-0.bin'))).toEqual(report);
  expect(await readFile(join(dir,'source-1.bin'))).toEqual(await readFile(f.input.incompletePath));
  const after = await loadConvergeRunState(f.dir,f.target), prior = JSON.parse(before.toString());
  expect(after).toMatchObject({...prior,updatedAt:m.createdAt});
  expect(after?.findings[r1.findings[0]!.identity].severity).toBe('critical');
  expect(after?.rounds.map(r => r.round)).toEqual([1]);
  expect(after?.lastAnnotations).toEqual(prior.lastAnnotations);
  expect(await readFile(f.attemptPath)).toEqual(attempts);
  expect(m.disposition).toEqual({kind:'missing-terminal-report',controllerExit:'unknown',scope:'supplied-evidence-only'});
});

it.each(['sources_retained','native_write_intent','native_audit_verified','complete'])(
  'resumes after an interrupted %s checkpoint without replacing prior history', async phase => {
    const f = await fixture(), m = await f.prepare(), before = await readFile(f.statePath), attempts = await readFile(f.attemptPath);
    await expect(f.apply('apply',{beforeCheckpoint:async (next:string) => {if(next===phase) throw new Error('synthetic crash');}})).rejects.toThrow('synthetic crash');
    const stateBeforeResume = await readFile(f.statePath);
    expect(await f.apply('resume')).toBe(['native_audit_verified','complete'].includes(phase) ? 'resumed' : 'applied');
    const state = await loadConvergeRunState(f.dir,f.target);
    expect(state?.roundGapAudit?.entries).toHaveLength(1); expect(state?.rounds.map(r=>r.round)).toEqual([1]);
    if(['native_audit_verified','complete'].includes(phase)) expect(await readFile(f.statePath)).toEqual(stateBeforeResume);
    expect(await readFile(join(roundGapOperationPath(f.dir,m.operationId),'native-before.json'))).toEqual(before);
    expect(await readFile(f.attemptPath)).toEqual(attempts);
  });

it('serializes two identical applies and resumes without duplicate audit entries', async () => {
  const f = await fixture(); await f.prepare();
  expect((await Promise.all([f.apply(),f.apply()])).sort()).toEqual(['applied','resumed']);
  expect((await loadConvergeRunState(f.dir,f.target))?.roundGapAudit?.entries).toHaveLength(1);
});
it('retains all journal checkpoints byte for byte across repeated acknowledgment loss', async () => {
  const f = await fixture(), m = await f.prepare(); await f.apply();
  const dir = join(roundGapOperationPath(f.dir,m.operationId),'journal'), names = await readdir(dir);
  const snapshots = await Promise.all(names.map(n=>readFile(join(dir,n))));
  await f.apply('resume');
  for (let i=0;i<names.length;i++) expect(await readFile(join(dir,names[i]!))).toEqual(snapshots[i]);
});
it('rejects missing or conflicting original gap records even when migrated totals would suffice', async () => {
  const f = await fixture(); f.attempts.migratedAttempts=2; f.attempts.attempts=f.attempts.attempts.slice(2);
  await writeFile(f.attemptPath,JSON.stringify(f.attempts));
  await expect(previewRoundGap(f.input,f.dir)).rejects.toThrow('round_gap_not_bound_to_spent_attempt');
});
it.each(['round','attempt','id'] as const)('rejects original report %s drift with an otherwise correct digest', async field => {
  const f = await fixture();
  if(field==='id') f.report.run!.id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; else f.report.run!.converge![field]=4;
  await writeFile(f.input.reportPath,JSON.stringify(f.report));
  await expect(previewRoundGap({...f.input,reportSha256:sha256(await readFile(f.input.reportPath))},f.dir)).rejects.toThrow('binding_mismatch');
});
it('rejects changed native source after preview before creating an audit operation', async () => {
  const f = await fixture(); await f.prepare(); await recordVerdicts({gitCommonDir:f.dir,target:f.target,round:1,verdicts:[]});
  const before=await readFile(f.statePath);
  await expect(f.apply()).rejects.toThrow('digest_mismatch'); expect(await readFile(f.statePath)).toEqual(before);
  await expect(readdir(join(f.dir,'rcl-converge-gap-audits'))).rejects.toMatchObject({code:'ENOENT'});
});
it('requires the exact reviewed manifest bytes, including whitespace', async () => {
  const f = await fixture(); await f.prepare(); const hash=sha256(await readFile(f.manifestPath)); await writeFile(f.manifestPath,(await readFile(f.manifestPath)).toString()+'\n');
  await expect(applyRoundGap({manifest:f.manifestPath,manifestSha256:hash,mode:'apply'},f.dir)).rejects.toThrow('digest_mismatch');
});
it('rejects duplicate-key manifests instead of accepting the last assertion', async () => {
  const f=await fixture(); await f.prepare(); const text=(await readFile(f.manifestPath)).toString(); await writeFile(f.manifestPath,text.replace('"gapRound": 2','"gapRound": 4, "gapRound": 2'));
  await expect(f.apply()).rejects.toThrow('ambiguous');
});
it('preview creates no audit, lock or native changes and rejects symlink sources', async () => {
  const f=await fixture(), before=(await readdir(f.dir)).sort(), state=await readFile(f.statePath), attempts=await readFile(f.attemptPath);
  await previewRoundGap(f.input,f.dir); expect((await readdir(f.dir)).sort()).toEqual(before); expect(await readFile(f.statePath)).toEqual(state); expect(await readFile(f.attemptPath)).toEqual(attempts);
  const alias=join(f.dir,'report-link'); await symlink(f.input.reportPath,alias);
  await expect(previewRoundGap({...f.input,reportPath:alias},f.dir)).rejects.toThrow('symlink_file');
});
it('refuses cross-repository manifests and explicit unknown audit fields without mutation', async () => {
  const f=await fixture(), other=await fixture(); await f.prepare();
  await expect(applyRoundGap({manifest:f.manifestPath,manifestSha256:sha256(await readFile(f.manifestPath)),mode:'apply'},other.dir)).rejects.toThrow('repository_changed');
  const m=JSON.parse((await readFile(f.manifestPath)).toString()); m.disposition.controllerExit=0; await f.save(m);
  await expect(f.apply()).rejects.toThrow('invalid_round_gap_audit');
});
it('does not turn a reserved missing round into a fabricated empty report', async () => {
  const f=await fixture(); await f.prepare(); await f.apply(); const before=await readFile(f.statePath);
  await expect(processRoundReport({gitCommonDir:f.dir,target:f.target,round:2,findings:[]})).rejects.toThrow('explicit_original_evidence');
  expect(await readFile(f.statePath)).toEqual(before);
});
it('refuses tampered retained source and candidate audit schemas on subsequent admission', async () => {
  const f=await fixture(), m=await f.prepare(); await f.apply();
  await writeFile(join(roundGapOperationPath(f.dir,m.operationId),'source-0.bin'),'{}');
  await expect(processRoundReport({gitCommonDir:f.dir,target:f.target,round:3,findings:f.report.findings,runId:f.input.runId,reportSha256:f.input.reportSha256})).rejects.toThrow('digest_mismatch');
  const state=JSON.parse((await readFile(f.statePath)).toString()); state.roundGapAudit.extra='unsupported'; await writeFile(f.statePath,JSON.stringify(state));
  await expect(loadConvergeRunState(f.dir,f.target)).rejects.toThrow('invalid_round_gap_audit');
});
it('refuses a corrupt append-only journal even when a completion marker exists', async () => {
  const f=await fixture(), m=await f.prepare(); await f.apply();
  const journal=join(roundGapOperationPath(f.dir,m.operationId),'journal','00000001.json');
  const checkpoint=JSON.parse((await readFile(journal)).toString()); checkpoint.manifest_sha256='f'.repeat(64); await writeFile(journal,JSON.stringify(checkpoint));
  const before=await readFile(f.statePath);
  await expect(processRoundReport({gitCommonDir:f.dir,target:f.target,round:3,findings:f.report.findings,runId:f.input.runId,reportSha256:f.input.reportSha256})).rejects.toThrow();
  expect(await readFile(f.statePath)).toEqual(before);
});
it('rechecks selected source bytes at the final native publication boundary', async () => {
  const f=await fixture(); await f.prepare(); const before=await readFile(f.statePath);
  await expect(f.apply('apply',{beforeCheckpoint:async(phase:string)=>{if(phase==='native_write_intent')await writeFile(f.input.incompletePath,'substituted during preparation');}})).rejects.toThrow();
  expect(await readFile(f.statePath)).toEqual(before);
});
it('rejects ambiguous retained journal records before a resumed native mutation', async () => {
  const f=await fixture(),m=await f.prepare(),before=await readFile(f.statePath);
  await expect(f.apply('apply',{beforeCheckpoint:async(phase:string)=>{if(phase==='native_write_intent')throw new Error('synthetic interruption');}})).rejects.toThrow('synthetic interruption');
  const path=join(roundGapOperationPath(f.dir,m.operationId),'journal','00000001.json');
  const text=(await readFile(path)).toString(); await writeFile(path,text.replace('"sequence": 1','"sequence": 99, "sequence": 1'));
  await expect(f.apply('resume')).rejects.toThrow(); expect(await readFile(f.statePath)).toEqual(before);
});
it('preserves a cap lowered below already spent attempts without spending or raising it', async () => {
  const f=await fixture(); f.attempts.cap=2; await writeFile(f.attemptPath,JSON.stringify(f.attempts)); const before=await readFile(f.attemptPath);
  await f.prepare(); await f.apply(); expect(await readFile(f.attemptPath)).toEqual(before);
  await expect(claimConvergeAttempt({gitCommonDir:f.dir,target:f.target})).rejects.toThrow('budget exhausted');
  expect(await readFile(f.attemptPath)).toEqual(before);
});
it('refuses altered source byte lengths before writing the native audit', async () => {
  const f=await fixture(),m=await f.prepare(),before=await readFile(f.statePath);
  m.report.bytes++;await f.save(m);
  await expect(f.apply()).rejects.toThrow();expect(await readFile(f.statePath)).toEqual(before);
});
