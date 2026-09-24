import { expect,it } from 'vitest';
import { readFile,writeFile,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { publicLoopback } from './public-claim-loopback.js';
import { fixture,rebind } from './recovery-validation/occurrence-fixtures.js';
import { sha,uuid } from './recovery-validation/fixtures.js';
import { loadConvergeRunState,processRoundReport,recordVerdicts } from '../../src/converge/run-state.js';
import { recoveryProjectionFreshness } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import { deriveNativeRecovery,nativeRecoveryPlanProjectionVersion,type NativeRecoveryPlan } from '../../src/converge/recovery-state.js';
import { readClaimProof,writeClaimProof } from '../../src/evidence/claim-recovery/proof-storage.js';
import { validateRetainedNativeEvidence } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { nativeMaterial } from '../../src/evidence/claim-recovery/validation/native-material.js';
import { roundIdentities } from '../../src/telemetry/events.js';

it.each([1,2] as const)('retains version %s proof and authenticates a later-round refresh of only its recovered claim',async version => {
  const input=fixture();
  Object.assign(input.report.findings[1],{ title: 'Upper index is unchecked',description: 'An independent upper index is unchecked.',
    claimDescriptor: { version: 1,operation: 'cache.ts :: upper index',invariant: 'The upper index exceeds the array length.',
      evidence: ['Clamp the upper index before lookup.'] } });
  rebind(input.disposition,input.report);
  const f=await publicLoopback(input);
  try {
    const common=join(f.repo,'.git');
    const original=JSON.parse(await readFile(f.statePath,'utf8'));
    expect(await f.preview()).toMatchObject({ exit: 0 });
    const applied=await f.execute();
    expect(applied,applied.stdout).toMatchObject({ exit: 0 });
    const planPath=f.manifest+'.native-plan',pool=f.manifest+'.proofs';
    if(version===1) {
      // Build a historical-format fixture without adding fields to its saved
      // plan. Only this disposable test namespace is replaced before replay.
      const saved=await readClaimProof(planPath,pool) as NativeRecoveryPlan;
      const { sourceVersion: _version,sourceSha256: _source,resultJson: _result,resultSha256: _resultHash,
        actionableIdentities: _actionable,recoveryMaterials: _materials,...input }=saved;
      const legacy=deriveNativeRecovery({ ...input,recoveryMaterials: [] },1);
      expect(nativeRecoveryPlanProjectionVersion(legacy)).toBe(1);
      for(const row of legacy.recoveryMaterials!) await writeFile(join(f.statePath+'.recovery-materials',row.sha256),row.text,{ mode: 0o600 });
      await writeFile(f.statePath,legacy.resultJson,{ mode: 0o600 });
      await rename(planPath,planPath+'.fixture-v2');
      await writeClaimProof(planPath,pool,legacy);
      const savedBytes=await readFile(planPath,'utf8');
      const posts=f.calls.filter(c => c.method==='POST').length;
      const resumed=await f.execute('resume');
      expect(resumed,resumed.stdout+resumed.stderr).toMatchObject({ exit: 0 });
      expect(await readFile(f.statePath,'utf8')).toBe(legacy.resultJson);
      expect(await readFile(planPath,'utf8')).toBe(savedBytes);
      expect(f.calls.filter(c => c.method==='POST')).toHaveLength(posts);
      expect(validateRetainedNativeEvidence({ sourceJson: legacy.resultJson,target: legacy.target,reports: legacy.reports,
        recoveryMaterials: legacy.recoveryMaterials,nativeSourceJsons: [legacy.sourceJson] }).actionableIdentities).toEqual(legacy.actionableIdentities);
    }
    const recovered=(await loadConvergeRunState(common,original.target))!;
    const report=JSON.parse(f.source.reportJson);
    const runId=uuid(920);
    report.run.id=runId;
    report.run.gating={ bound_classification_protocol: 1 };
    report.run.converge={ target: original.target,round: 2,attempt: 2,
      recovery_source: { version: 1,native_sha256: sha(await readFile(f.statePath,'utf8')) } };
    report.findings=report.findings.map((row: any,i: number) => ({ ...row,severity: 'critical',identity: `report:${runId}:claim-${i}` }));
    report.belowThresholdFindings=[];
    const reportJson=JSON.stringify(report);
    const admitted=await processRoundReport({ gitCommonDir: common,target: original.target,round: 2,runId,
      findings: report.findings,evidence: { reportJson } });
    expect(admitted.findings[0]!.status).toBe('regating');
    const independent=admitted.findings[1]!.identity;
    expect(independent).not.toBe(f.selection.identity);
    expect(admitted.legacyPendingIdentities).toContain(f.selection.previousIdentity);
    const received=new Date().toISOString();
    const classification={ ...f.source.classification,id: uuid(921),run_id: runId,round: 2,attempt: 2,sequence: 1,
      actor_user_id: uuid(900),received_at: received,occurred_at: received,payload: {
        classification_version: 1,report_json_sha256: sha(reportJson),identities: roundIdentities(admitted.findings),
        legacy_pending_identities: admitted.legacyPendingIdentities,
      } };
    const source={ scope: { ...f.source.scope,run_id: runId },reportJson,classification,corrections: [],storedRun: {
      ...report.run,received_at: received,artifacts: [{ kind: 'report_json',stored: true,declared_sha256: sha(reportJson),declared_bytes: Buffer.byteLength(reportJson) }],
      findings: report.findings.map((row: any,i: number) => ({ ref: `f00${i+1}`,identity_key: row.identity,file: row.file,category: row.category,
        start_line: row.startLine,end_line: row.endLine,severity: row.severity,below_threshold: false,gating_reason: row.gating.reason,
        verification_verdict: null,claim_descriptor: row.claimDescriptor })),
    } };
    f.addSource(source);
    const triaged=await recordVerdicts({ gitCommonDir: common,target: original.target,round: 2,
      verdicts: [{ key: f.selection.identity,verdict: 'dismissed',reason: 'Explicit later critical judgment for the recovered claim only.' }] });
    expect(triaged.resolution!.unresolved).toContain(f.selection.identity);
    const verdict={ ...classification,id: uuid(922),kind: 'verdicts_recorded',attempt: null,sequence: 2,
      received_at: new Date().toISOString(),payload: { verdicts: [{ identity_key: f.selection.identity,
        verdict: 'dismissed',severity: 'critical',reason: 'Explicit later critical judgment for the recovered claim only.' }] } };
    f.addSourceReceipt(runId,verdict);
    const before=await readFile(f.statePath,'utf8');
    const selected=join(f.root,'operation/later-refresh-selection.json');
    const manifest=join(f.root,'operation/later-refresh.json');
    await writeFile(selected,JSON.stringify({ ...f.selection,action: 'refresh',disposition: undefined }));
    const postCount=f.calls.filter(call => call.method==='POST').length;
    const preview=await f.command(['--preview','--selection',selected,'--manifest',manifest,'--json']);
    expect(preview,preview.stdout+preview.stderr).toMatchObject({ exit: 0 });
    expect(await readFile(f.statePath,'utf8')).toBe(before);
    const digest=sha(await readFile(manifest,'utf8'));
    const refreshed=await f.command(['--apply','--manifest',manifest,'--manifest-sha256',digest,'--json']);
    expect(refreshed,refreshed.stdout+refreshed.stderr).toMatchObject({ exit: 0 });
    const result=JSON.parse(refreshed.stdout);
    expect(result.actionable_identities).not.toContain(f.selection.identity);
    expect(result.actionable_identities).toEqual(expect.arrayContaining([independent,f.selection.previousIdentity]));
    expect(f.calls.filter(call => call.method==='POST')).toHaveLength(postCount);
    const after=(await loadConvergeRunState(common,original.target))!;
    for(const field of ['rounds','findings','roundCap','updatedAt','sightings'] as const) expect(after[field]).toEqual(JSON.parse(before)[field]);
    expect(after.rounds[0]).toEqual(original.rounds[0]);
    expect(after.recovery!.operations.slice(0,recovered.recovery!.operations.length)).toEqual(recovered.recovery!.operations);
    expect(after.findings[independent]!.verdict).toBeUndefined();
    expect(after.findings[independent]!.pendingRound).toBe(2);
    expect(recoveryProjectionFreshness(after)?.validForNative).toBe(true);
    const finalPlan=await readClaimProof(manifest+'.native-plan',manifest+'.proofs') as NativeRecoveryPlan;
    expect(nativeRecoveryPlanProjectionVersion(finalPlan)).toBe(2);
    expect(nativeMaterial(after.recovery!.operations[0]!.material!,finalPlan.recoveryMaterials!).currentProjection!.version).toBe(version);
    const finalBytes=await readFile(f.statePath,'utf8');
    expect(await f.command(['--resume','--manifest',manifest,'--manifest-sha256',digest,'--json'])).toMatchObject({ exit: 0 });
    expect(await readFile(f.statePath,'utf8')).toBe(finalBytes);
    expect(f.calls.filter(call => call.method==='POST')).toHaveLength(postCount);
  } finally { await f.cleanup(); }
},45000);
