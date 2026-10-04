import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { reviewCycleDirectory } from '../../src/converge/fresh-review.js';
import {
  applyHistoricalDeliveryReconciliation,
  previewHistoricalDeliveryReconciliation,
  verifyHistoricalDeliveryReconciliations,
} from '../../src/converge/historical-delivery-reconciliation.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { applyStaleReport } from '../../src/converge/stale-report.js';
import { readStaleObject } from '../../src/converge/stale-report-storage.js';
import { serializeRecoveryDocument } from '../../src/evidence/original-run/journal.js';
import { mergedBlockingHealth } from '../../src/converge/legacy-launch-health.js';
import type { NativeReviewCycle } from '../../src/converge/review-cycle.js';
import type { HarnessSink } from '../../src/telemetry/sink.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { staleFixture } from './stale-report-fixtures.js';

const retryReason = 'Authenticated delivery completed; one bounded current-input review.';

async function installCycle(dir: string, target: string): Promise<NativeReviewCycle> {
  const operationId = randomUUID();
  const directory = reviewCycleDirectory(dir,target);
  await mkdir(directory,{recursive:true,mode:0o700});
  await chmod(join(dir,'rcl-review-cycles'),0o700);
  await chmod(directory,0o700);
  const archive = {version:1,target,operationId,files:{run:null,attempts:null,ledger:null},
    history:{attempts:0,rounds:0}};
  const archivePath = join(directory,`${operationId}.archive.json`);
  const archiveBytes = serializeRecoveryDocument(archive);
  await writeFile(archivePath,archiveBytes,{mode:0o600});
  return {id:randomUUID(),operationId,previousCycleId:null,repo:'allocator-one/allocator-one',prNumber:9897,
    url:'https://harness.example',archivePath,archiveSha256:sha256(archiveBytes),history:archive.history};
}

async function applyLegacyDisposition(f: Awaited<ReturnType<typeof staleFixture>>, head: string, input: string,
  weak: Record<string,unknown>, reviewerHealth: ReturnType<typeof mergedBlockingHealth>) {
  const state = (await loadConvergeRunState(f.dir,f.target))!;
  const attempts = await readFile(f.attemptsPath);
  const manifest = {
    target:f.target,headSha:head,inputSha256:input,reportPath:f.reportPath,
    reportSha256:f.selection.reportSha256,reason:'The exact replacement inputs supersede this stale report.',
    retryReason,kind:'rcl-stale-report',version:2,outcome:'delivered-hard-failure',
    operationId:randomUUID(),createdAt:new Date().toISOString(),gitCommonDir:f.dir,
    stateSha256:sha256(await readFile(f.statePath)),attemptSha256:sha256(attempts),
    runId:state.lastLaunch!.runId,attempt:state.lastLaunch!.attempt,round:state.lastLaunch!.round,
    previousHeadSha:state.lastLaunch!.headSha,previousInputSha256:state.lastLaunch!.inputSha256,
    cycleId:state.cycle!.id,reviewerHealth,deliveryReconciliation:weak,
  };
  await writeFile(f.manifestPath,serializeRecoveryDocument(manifest));
  await applyStaleReport({manifest:f.manifestPath,
    manifestSha256:sha256(await readFile(f.manifestPath)),mode:'apply'},f.dir);
}

async function historicalFixture(deadPid = 999_999) {
  const f = await staleFixture();
  const cycle = await installCycle(f.dir,f.target);
  const report = JSON.parse(await readFile(f.reportPath,'utf8'));
  for (const seat of report.run.roster) seat.lane = 'blocking';
  report.run.cycle_id = cycle.id;
  report.run.converge={target:f.target,attempt:25,round:14};
  report.run.target={...report.run.target,kind:'patch',repo:cycle.repo,pr_number:cycle.prNumber,
    head_sha:f.options.headSha,base_sha:'b'.repeat(40),diff_sha256:'8'.repeat(64)};
  await writeFile(f.reportPath,JSON.stringify(report));
  expect(JSON.parse(await readFile(f.reportPath,'utf8')).run.target.repo).toBe(cycle.repo);
  f.selection.reportSha256 = sha256(await readFile(f.reportPath));
  const reportBytes=(await readFile(f.reportPath)).byteLength;
  const reviewerHealth = mergedBlockingHealth(report,2/3);
  const state = (await loadConvergeRunState(f.dir,f.target))!;
  state.version=2; state.cycle=cycle;
  state.roundCap=30;
  state.rounds=Array.from({length:13},(_,index)=>({round:index+1,
    counts:{new:0,repeat:0,suppressed:0,regating:0}}));
  state.lastAnnotations={round:13,identities:[]};
  state.lastLaunch={...state.lastLaunch!,pid:deadPid,reportJsonSha256:f.selection.reportSha256,
    attempt:25,round:14,deliveryPending:false,hardFailure:true,exitCode:4,reviewerHealth};
  const weak={version:1,runId:state.lastLaunch.runId!,reportJsonSha256:state.lastLaunch.reportJsonSha256!,
    headSha:state.lastLaunch.headSha,attempt:state.lastLaunch.attempt,round:state.lastLaunch.round};
  state.lastLaunch.deliveryReconciliation=weak;
  await writeFile(f.statePath,JSON.stringify(state));
  const attempts=JSON.parse(await readFile(f.attemptsPath,'utf8'));
  attempts.version=3; attempts.cycle=cycle; attempts.cap=35; attempts.attemptsUsed=25;
  attempts.attempts=Array.from({length:25},(_,index)=>({attempt:index+1,
    claimedAt:new Date(1_700_000_000_000+index).toISOString(),pid:index===24?deadPid:800_000+index,source:'claim'}));
  await writeFile(f.attemptsPath,JSON.stringify(attempts));

  await applyLegacyDisposition(f,'c'.repeat(40),'d'.repeat(64),weak,reviewerHealth);
  expect(JSON.parse((await readStaleObject(f.dir,f.selection.reportSha256)).text).run.target.repo)
    .toBe(cycle.repo);
  await applyLegacyDisposition(f,'e'.repeat(40),'f'.repeat(64),weak,reviewerHealth);

  const disposed=(await loadConvergeRunState(f.dir,f.target))!;
  const {deliveryReconciliation:_weak,...priorLaunch}=disposed.lastLaunch!;
  const successorRunId=randomUUID();
  disposed.lastLaunch={...priorLaunch,status:'completed',attempt:26,round:14,headSha:'e'.repeat(40),
    inputSha256:'f'.repeat(64),pid:999_998,startedAt:new Date().toISOString(),runId:successorRunId,
    reportJsonSha256:'9'.repeat(64),successfulReviews:2,totalReviews:2,deliveryPending:false,
    hardFailure:false,exitCode:0,reviewerHealth};
  await writeFile(f.statePath,JSON.stringify(disposed));
  const advanced=JSON.parse(await readFile(f.attemptsPath,'utf8'));
  advanced.attemptsUsed=26;
  advanced.attempts.push({attempt:26,claimedAt:new Date().toISOString(),pid:999_998,source:'claim'});
  await writeFile(f.attemptsPath,JSON.stringify(advanced));

  const server={
    id:weak.runId,provenance:'live',received_at:'2026-10-03T20:30:55.792621Z',cycle_id:cycle.id,
    repo_verified:true,head_verified:'mismatch',is_cross_repository:false,
    converge:{target:f.target,attempt:25,round:14},
    target:{kind:'patch',repo:cycle.repo,pr_number:cycle.prNumber,head_sha:weak.headSha,
      base_sha:'b'.repeat(40),diff_sha256:'8'.repeat(64)},
    artifacts:[{kind:'report_json',stored:true,declared_sha256:weak.reportJsonSha256,declared_bytes:reportBytes}],
    findings:[],calls:[],
  };
  const getRun=vi.fn(async () => ({kind:'ok' as const,value:server}));
  return {...f,cycle,weak,successorRunId,server,getRun,sink:{baseUrl:cycle.url} as HarnessSink};
}

describe('historical delivery reconciliation',()=>{
  it('upgrades a two-receipt weak predecessor after its successor without changing accounting',async()=>{
    const f=await historicalFixture();
    const beforeState=await readFile(f.statePath);
    const beforeAttempts=await readFile(f.attemptsPath);
    const before=(await loadConvergeRunState(f.dir,f.target))!;
    expect(before.staleReportAudit).toHaveLength(2);

    const manifest=await previewHistoricalDeliveryReconciliation({target:f.target,runId:f.weak.runId},
      f.dir,f.sink,{getRun:f.getRun});
    expect(f.getRun).toHaveBeenCalledWith(f.sink,f.weak.runId,{requireCompleteRead:true});
    expect(await readFile(f.statePath)).toEqual(beforeState);
    expect(await readFile(f.attemptsPath)).toEqual(beforeAttempts);
    expect(manifest).toMatchObject({runId:f.weak.runId,sourceStaleManifestSha256s:[
      before.staleReportAudit![0]!.manifestSha256,before.staleReportAudit![1]!.manifestSha256,
    ].sort(),successor:{runId:f.successorRunId,attempt:26,round:14},
    reconciliation:{version:2,attempt:25,round:14,claimPid:999_999},
    server:{repoVerified:true,target:{repo:f.cycle.repo,prNumber:f.cycle.prNumber}}});
    expect(manifest.serverProjectionSha256)
      .toBe(sha256(Buffer.from(serializeRecoveryDocument(manifest.server))));

    const path=join(f.dir,'historical-manifest.json');
    await writeFile(path,serializeRecoveryDocument(manifest));
    const pinned={manifest:path,manifestSha256:sha256(await readFile(path))};
    await expect(applyHistoricalDeliveryReconciliation(pinned,f.dir,f.sink,{getRun:f.getRun}))
      .resolves.toBe('applied');
    const after=(await loadConvergeRunState(f.dir,f.target))!;
    expect(after.lastLaunch).toEqual(before.lastLaunch);
    expect(after.staleReportAudit).toEqual(before.staleReportAudit);
    expect(after.rounds).toEqual(before.rounds);
    expect(after.findings).toEqual(before.findings);
    expect(after.cycle).toEqual(before.cycle);
    expect(await readFile(f.attemptsPath)).toEqual(beforeAttempts);
    expect(after.historicalDeliveryReconciliationAudit).toHaveLength(1);
    await expect(verifyHistoricalDeliveryReconciliations(f.dir,after)).resolves.toBeUndefined();
    const appliedBytes=await readFile(f.statePath);
    const operationDir=join(f.dir,'rcl-historical-delivery-reconciliations',manifest.operationId);
    const serverProjection=await readFile(join(operationDir,'server-projection.json'));
    const receipt=JSON.parse(await readFile(join(operationDir,'complete.json'),'utf8'));
    expect(manifest.serverProjectionSha256).toBe(sha256(serverProjection));
    expect(receipt).toMatchObject({beforeStateSha256:sha256(beforeState),
      afterStateSha256:sha256(appliedBytes),attemptStateSha256:sha256(beforeAttempts),
      serverProjectionSha256:sha256(serverProjection)});
    const pendingId=randomUUID(),cycleDirectory=reviewCycleDirectory(f.dir,f.target);
    await writeFile(join(cycleDirectory,`${pendingId}.json`),serializeRecoveryDocument({version:1,
      target:f.target,operationId:pendingId,repo:f.cycle.repo,prNumber:f.cycle.prNumber,url:f.cycle.url,
      headSha:before.lastLaunch!.headSha,previousCycleId:f.cycle.id,attemptCap:35,roundCap:30,
      archiveSha256:f.cycle.archiveSha256,phase:'prepared'}));
    await writeFile(join(cycleDirectory,'current.json'),serializeRecoveryDocument({operationId:pendingId}));
    await expect(applyHistoricalDeliveryReconciliation(pinned,f.dir,f.sink,{getRun:f.getRun}))
      .resolves.toBe('unchanged');
    expect(await readFile(f.statePath)).toEqual(appliedBytes);
    const competing={...manifest,operationId:randomUUID(),createdAt:new Date().toISOString()};
    const competingPath=join(f.dir,'competing.json');
    await writeFile(competingPath,serializeRecoveryDocument(competing));
    await expect(applyHistoricalDeliveryReconciliation({manifest:competingPath,
      manifestSha256:sha256(await readFile(competingPath))},f.dir,f.sink,{getRun:f.getRun}))
      .rejects.toThrow('historical_delivery_reconciliation_operation_conflict');
    await writeFile(join(operationDir,'complete.json'),'{}\n');
    await expect(verifyHistoricalDeliveryReconciliations(f.dir,after)).rejects.toThrow();
  },20_000);

  it.each([
    ['provenance',(f:any)=>{f.server.provenance='backfill';}],
    ['run id',(f:any)=>{f.server.id=randomUUID();}],
    ['repository verification',(f:any)=>{f.server.repo_verified=false;}],
    ['cross-repository source',(f:any)=>{f.server.is_cross_repository=true;}],
    ['head verification',(f:any)=>{delete f.server.head_verified;}],
    ['cycle',(f:any)=>{f.server.cycle_id=randomUUID();}],
    ['repository',(f:any)=>{f.server.target.repo='other/repo';}],
    ['pull request',(f:any)=>{f.server.target.pr_number=1;}],
    ['head',(f:any)=>{f.server.target.head_sha='7'.repeat(40);}],
    ['target kind',(f:any)=>{f.server.target.kind='pr';}],
    ['base',(f:any)=>{f.server.target.base_sha='7'.repeat(40);}],
    ['diff',(f:any)=>{f.server.target.diff_sha256='7'.repeat(64);}],
    ['attempt',(f:any)=>{f.server.converge.attempt=24;}],
    ['round',(f:any)=>{f.server.converge.round=13;}],
    ['report digest',(f:any)=>{f.server.artifacts[0].declared_sha256='7'.repeat(64);}],
    ['report bytes',(f:any)=>{f.server.artifacts[0].declared_bytes++;}],
    ['unstored report',(f:any)=>{f.server.artifacts[0].stored=false;}],
    ['missing report',(f:any)=>{f.server.artifacts=[];}],
    ['duplicate report',(f:any)=>{f.server.artifacts.push({...f.server.artifacts[0]});}],
  ])('refuses mismatched %s without native mutation',async(_name,mutate)=>{
    const f=await historicalFixture(),beforeState=await readFile(f.statePath),
      beforeAttempts=await readFile(f.attemptsPath);
    mutate(f);
    await expect(previewHistoricalDeliveryReconciliation({target:f.target,runId:f.weak.runId},
      f.dir,f.sink,{getRun:f.getRun})).rejects.toThrow();
    expect(await readFile(f.statePath)).toEqual(beforeState);
    expect(await readFile(f.attemptsPath)).toEqual(beforeAttempts);
  },20_000);

  it('refuses a live retained claim owner',async()=>{
    const f=await historicalFixture(process.pid),before=await readFile(f.statePath);
    await expect(previewHistoricalDeliveryReconciliation({target:f.target,runId:f.weak.runId},
      f.dir,f.sink,{getRun:f.getRun})).rejects.toThrow('terminal_rejection_owner_live_or_uncertain');
    expect(await readFile(f.statePath)).toEqual(before);
  });

  it.each([
    ['missing successor claim','Invalid convergence attempt state',async(f:any)=>{const attempts=JSON.parse(await readFile(f.attemptsPath,'utf8'));
      attempts.attempts=attempts.attempts.filter((entry:any)=>entry.attempt!==26);
      await writeFile(f.attemptsPath,JSON.stringify(attempts));}],
    ['successor PID mismatch','historical_delivery_reconciliation_successor_attempt_mismatch',async(f:any)=>{const attempts=JSON.parse(await readFile(f.attemptsPath,'utf8'));
      attempts.attempts.find((entry:any)=>entry.attempt===26).pid=123_456;
      await writeFile(f.attemptsPath,JSON.stringify(attempts));}],
    ['successor beyond ledger','historical_delivery_reconciliation_successor_attempt_mismatch',async(f:any)=>{const state=JSON.parse(await readFile(f.statePath,'utf8'));
      state.lastLaunch.attempt=27; await writeFile(f.statePath,JSON.stringify(state));}],
  ])('refuses %s',async(_name,error,mutate)=>{
    const f=await historicalFixture(); await mutate(f);
    await expect(previewHistoricalDeliveryReconciliation({target:f.target,runId:f.weak.runId},
      f.dir,f.sink,{getRun:f.getRun}))
      .rejects.toThrow(error);
  },20_000);

  it('refuses the wrong Harness endpoint and incomplete server reads',async()=>{
    const f=await historicalFixture(),selection={target:f.target,runId:f.weak.runId};
    await expect(previewHistoricalDeliveryReconciliation(selection,f.dir,
      {baseUrl:'https://other.example'} as HarnessSink,{getRun:f.getRun}))
      .rejects.toThrow('historical_delivery_reconciliation_server_origin_mismatch');
    const unavailable=vi.fn(async()=>({kind:'unavailable' as const,reason:'incomplete'}));
    await expect(previewHistoricalDeliveryReconciliation(selection,f.dir,f.sink,
      {getRun:unavailable as any})).rejects.toThrow('historical_delivery_reconciliation_server_unavailable');
    expect(unavailable).toHaveBeenCalledWith(f.sink,f.weak.runId,{requireCompleteRead:true});
  },20_000);

  it('serializes concurrent applies and returns one deterministic readback',async()=>{
    const f=await historicalFixture();
    const manifest=await previewHistoricalDeliveryReconciliation({target:f.target,runId:f.weak.runId},
      f.dir,f.sink,{getRun:f.getRun});
    const path=join(f.dir,'concurrent.json'); await writeFile(path,serializeRecoveryDocument(manifest));
    const pinned={manifest:path,manifestSha256:sha256(await readFile(path))};
    const results=await Promise.all([
      applyHistoricalDeliveryReconciliation(pinned,f.dir,f.sink,{getRun:f.getRun}),
      applyHistoricalDeliveryReconciliation(pinned,f.dir,f.sink,{getRun:f.getRun}),
    ]);
    expect(results.sort()).toEqual(['applied','unchanged']);
    expect((await loadConvergeRunState(f.dir,f.target))!.historicalDeliveryReconciliationAudit).toHaveLength(1);
  },20_000);

  it('refuses state drift after preview',async()=>{
    const f=await historicalFixture();
    const manifest=await previewHistoricalDeliveryReconciliation({target:f.target,runId:f.weak.runId},
      f.dir,f.sink,{getRun:f.getRun});
    const path=join(f.dir,'pinned.json'); await writeFile(path,serializeRecoveryDocument(manifest));
    const pinned={manifest:path,manifestSha256:sha256(await readFile(path))};
    const state=JSON.parse(await readFile(f.statePath,'utf8')); state.updatedAt=new Date().toISOString();
    await writeFile(f.statePath,JSON.stringify(state));
    await expect(applyHistoricalDeliveryReconciliation(pinned,f.dir,f.sink,{getRun:f.getRun}))
      .rejects.toThrow('historical_delivery_reconciliation_state_changed');
  },20_000);

  it('refuses ambiguous pinned manifest bytes before native mutation',async()=>{
    const f=await historicalFixture(),beforeState=await readFile(f.statePath),
      beforeAttempts=await readFile(f.attemptsPath);
    const manifest=await previewHistoricalDeliveryReconciliation({target:f.target,runId:f.weak.runId},
      f.dir,f.sink,{getRun:f.getRun});
    const ambiguous=serializeRecoveryDocument(manifest).replace('{\n',
      `{\n  "operationId": ${JSON.stringify(randomUUID())},\n`);
    const path=join(f.dir,'ambiguous.json'); await writeFile(path,ambiguous);
    await expect(applyHistoricalDeliveryReconciliation({manifest:path,
      manifestSha256:sha256(await readFile(path))},f.dir,f.sink,{getRun:f.getRun}))
      .rejects.toThrow('invalid_or_ambiguous_original_json');
    const paddedPath=join(f.dir,'padded.json');
    await writeFile(paddedPath,serializeRecoveryDocument(manifest)+'\n');
    await expect(applyHistoricalDeliveryReconciliation({manifest:paddedPath,
      manifestSha256:sha256(await readFile(paddedPath))},f.dir,f.sink,{getRun:f.getRun}))
      .rejects.toThrow('historical_delivery_reconciliation_manifest_noncanonical');
    expect(await readFile(f.statePath)).toEqual(beforeState);
    expect(await readFile(f.attemptsPath)).toEqual(beforeAttempts);
  },20_000);
});
