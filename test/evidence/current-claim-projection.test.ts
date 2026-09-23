import { describe,expect,it } from 'vitest';
import { deriveCurrentClaimProjection,nativeProjectionFingerprint,recoveryProjectionFreshness } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import { packNativeMaterial } from '../../src/evidence/claim-recovery/validation/native-material.js';
import { correctionAnchor } from '../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimDisposition,prepareObligationTransfer } from '../../src/evidence/claim-recovery/validation/occurrence.js';
import { fixture,laterSource,rebind } from './recovery-validation/occurrence-fixtures.js';
import { sha,uuid } from './recovery-validation/fixtures.js';
import { sampleResult,sampleReview } from '../telemetry/fixtures.js';
import { projection } from './original-run-fixtures.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import type { ClaimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
const floor='2026-09-22T13:00:00.123456Z';
function setup(verdict: 'fixed'|'dismissed'='fixed',nongating=false) {
  const f=fixture();
  if(nongating) { f.report.findings[0].gating.reason='none'; rebind(f.disposition,f.report); }
  const split=f.transfer.split;
  const state=JSON.parse(split.selection.nativeJson);
  const anchor=correctionAnchor(split.selection,split.receipt,split.actorUserId,uuid(99));
  f.transfer.eventId=uuid(21);
  f.disposition.eventId=uuid(22);
  f.disposition.verdict=verdict;
  const transfer={
    preparation: f.transfer,actorUserId: f.transfer.actorUserId,receipt: {
      ...split.source.scope,...prepareObligationTransfer(f.transfer).event,
      actor_user_id: f.transfer.actorUserId,attempt: null,sequence: 4,received_at: floor
    }
  };
  const disposition={
    preparation: f.disposition,actorUserId: f.disposition.actorUserId,receipt: {
      ...split.source.scope,...prepareClaimDisposition(f.disposition).event,
      actor_user_id: f.disposition.actorUserId,attempt: null,sequence: 5,received_at: floor
    }
  };
  const history: ClaimHistoryContent={ actorUserId: f.disposition.actorUserId,readWindow: { startedAt: '2026-09-23T00:00:00.000Z',completedAt: '2026-09-23T00:00:01.000Z' },sources: [],histories: [] };
  function add(source: typeof split.source,receipts=[source.classification,...source.corrections]) {
    source.storedRun.received_at??=source.classification.received_at;
    history.sources.push({
      selector: {
        scope: source.scope,target: state.target,round: source.classification.round!,headSha: (source.storedRun.target as any).head_sha,
        reportSha256: sha(source.reportJson)
      },reportJson: source.reportJson,storedRun: source.storedRun,classifications: [source.classification],corrections: source.corrections,correctionIds: source.corrections.map(r => r.id)
    });
    history.histories.push({ runId: source.scope.run_id,eventSequence: Math.max(...receipts.map(r => r.sequence)),receipts });
  }
  add(split.source,[split.source.classification,f.originalVerdict,split.receipt,transfer.receipt,disposition.receipt]);
  function confirm(change?: (report: any,stored: any,event: any) => void) {
    const report=sampleResult({ reviews: [sampleReview({ model: 'a' }),sampleReview({ model: 'b' }),sampleReview({ model: 'c',status: 'timeout' })],findings: [],belowThresholdFindings: [] }) as any;
    report.run.id=uuid(900);
    report.run.target={ ...report.run.target,repo: split.source.scope.repo,pr_number: split.source.scope.pr_number };
    report.run.converge={ target: state.target,round: 2,attempt: 2 };
    report.run.roster=report.reviews.map((r: any) => ({ model: r.model,role: r.role,provider: r.provider,lane: 'blocking' }));
    report.run.started_at='2026-09-22T13:00:00.123457Z';
    report.run.finished_at='2026-09-22T14:00:00.000000Z';
    const stored: any={ repo_verified: true,is_cross_repository: false,received_at: '2026-09-22T14:01:00.000000Z' };
    const event: any={
      ...split.source.classification,id: uuid(901),run_id: report.run.id,round: 2,attempt: 2,sequence: 1,
      received_at: '2026-09-22T14:02:00.000000Z',payload: { classification_version: 1,identities: [] }
    };
    change?.(report,stored,event);
    const raw=JSON.stringify(report);
    Object.assign(stored,projection(buildRunEnvelope(report,{ report_json: raw },{ level: 'full',delivery: { mode: 'direct' } }),{ report_json: 'present' }));
    event.payload.report_json_sha256=sha(raw);
    add({ scope: { ...split.source.scope,run_id: report.run.id },reportJson: raw,storedRun: stored,classification: event,corrections: [] });
  }
  const run=(version: 1|2=2) => deriveCurrentClaimProjection(state,[anchor],[{ transfers: [transfer],dispositions: [disposition],carriers: [],pendingIdentities: [] } as any],history,[],split.selection.nativeJson,version);
  return { f,state,anchor,history,transfer,disposition,add,confirm,run };
}
describe('current complete claim snapshot',() => {
  it('retains snapshot time and digest and distinguishes invalidated local standing from server approval',() => {
    const f=setup('dismissed');
    const projection=f.run();
    const material=packNativeMaterial({ currentProjection: projection }).reference;
    const state={ ...f.state,version: 3,recovery: { version: 2,operations: [{ material }] } };
    expect(recoveryProjectionFreshness(state)).toEqual({
      readWindow: f.history.readWindow,proofSha256: material.rootSha256,
      validForNative: true,qualification: 'authenticated snapshot; not current server approval'
    });
    state.updatedAt='2026-09-24T00:00:00.000Z';
    expect(recoveryProjectionFreshness(state)?.validForNative).toBe(false);
  });
  it('requires a genuinely later conclusive review for fixed and keeps the other co-key members pending',() => {
    const f=setup();
    expect(f.run().claims[0]!.standing).toBe('pending');
    f.confirm();
    const result=f.run();
    expect(result.claims[0]!.standing).toBe('confirmed-fixed');
    expect(result.actionableIdentities).toContain(f.f.transfer.split.selection.previousIdentity);
  });
  it.each(['equal-start','old-start','inconclusive','backfill','missing-eligibility','unmarked','old-receipt'])('retains fixed pending for %s evidence',kind => {
    const f=setup();
    f.confirm((report,stored,event) => {
      if(kind==='equal-start')
        report.run.started_at=floor;
      if(kind==='old-start')
        report.run.started_at='2026-09-22T12:00:00.000000Z';
      if(kind==='inconclusive')
        report.reviews[1].status='timeout';
      if(kind==='backfill')
        report.run.provenance='historical_backfill';
      if(kind==='missing-eligibility')
        stored.repo_verified=false;
      if(kind==='unmarked')
        delete event.payload.classification_version;
      if(kind==='old-receipt')
        stored.received_at=floor;
    });
    expect(f.run().claims[0]!.standing).toBe('pending');
  });
  it('reopens an important dismissal on a later critical gated repeat but not a nongating sighting',() => {
    const f=setup('dismissed');
    expect(f.run().claims[0]!.standing).toBe('dismissed');
    f.add(laterSource(f.f.disposition,2,true,'critical'));
    expect(f.run().claims[0]!.standing).toBe('pending');
    const control=setup('dismissed');
    control.add(laterSource(control.f.disposition,2,false,'critical'));
    expect(control.run().claims[0]!.standing).toBe('dismissed');
  });
  function laterVerdict(round=2) {
    const f=setup('dismissed');
    const source=laterSource(f.f.disposition,round,true,'critical');
    source.storedRun.received_at='2026-09-22T14:00:00.000000Z';
    const receipt={ ...source.classification,id: uuid(925),kind: 'verdicts_recorded',sequence: 2,
      received_at: '2026-09-22T14:01:00.000000Z',payload: { verdicts: [{ identity_key: f.anchor.identity,
        verdict: 'dismissed',severity: 'critical',reason: 'Explicit critical decision on the bound later claim.' }] } };
    f.add(source,[source.classification,receipt]);
    return { ...f,source,receipt };
  }
  function reviseSource(source: ReturnType<typeof laterSource>,change: (report: any) => void) {
    const report=JSON.parse(source.reportJson); change(report);
    source.reportJson=JSON.stringify(report);
    const digest=sha(source.reportJson);
    const all=[...report.findings,...report.belowThresholdFindings];
    source.storedRun.artifacts=[{ kind: 'report_json',stored: true,declared_sha256: digest,declared_bytes: Buffer.byteLength(source.reportJson) }];
    source.storedRun.findings=all.map((row: any,i: number) => ({ ref: `f00${i+1}`,identity_key: row.identity,
      file: row.file,category: row.category,start_line: row.startLine,end_line: row.endLine,severity: row.severity,
      below_threshold: i>=report.findings.length,gating_reason: row.gating.reason,verification_verdict: null,claim_descriptor: row.claimDescriptor }));
    const mapping=(source.classification.payload.identities as any[])[0];
    source.classification.payload.report_json_sha256=digest;
    source.classification.payload.identities=all.map((row: any,i: number) => ({ ...mapping,finding_ref: `f00${i+1}`,
      identity_key: row.identity,report_json_sha256: digest,claim_descriptor: row.claimDescriptor }));
  }
  it('retains the critical appendix severity of an otherwise gated exact-claim batch',() => {
    const f=setup('dismissed');
    const source=laterSource(f.f.disposition,2,true,'important');
    source.storedRun.received_at='2026-09-22T14:00:00.000000Z';
    reviseSource(source,report => {
      report.belowThresholdFindings=[{ ...structuredClone(report.findings[0]),identity: 'critical-appendix',severity: 'critical',gating: { reason: 'none' } }];
    });
    const receipt={ ...source.classification,id: uuid(925),kind: 'verdicts_recorded',sequence: 2,
      received_at: '2026-09-22T14:01:00.000000Z',payload: { verdicts: [{ identity_key: f.anchor.identity,
        verdict: 'dismissed',severity: 'important',reason: 'An important decision cannot clear critical appendix evidence.' }] } };
    f.add(source,[source.classification,receipt]);
    expect(f.run().claims[0]).toMatchObject({ standing: 'pending',reasons: ['critical_disposition_required'] });
  });
  it('retains a conflict when a later repeat binds the recovered key to another descriptor',() => {
    const f=laterVerdict();
    const source=laterSource(f.f.disposition,3,true,'important');
    reviseSource(source,report => { report.findings[0].claimDescriptor.invariant='A different independent claim.'; });
    source.classification.received_at='2026-09-22T15:00:00.000000Z';
    f.add(source);
    expect(f.run().claims[0]).toMatchObject({ standing: 'pending',reasons: ['claim_binding_unproven'] });
  });
  it('requires fixed confirmation beyond a higher gated round received before the assertion',() => {
    const f=laterVerdict();
    f.receipt.payload.verdicts[0]!.verdict='fixed';
    f.add(laterSource(f.f.disposition,4,true,'critical'));
    f.confirm((report,stored,event) => {
      report.run.converge.round=3; event.round=3;
      report.run.started_at='2026-09-22T14:01:00.000001Z';
      report.run.finished_at='2026-09-22T14:02:00.000000Z';
      stored.received_at='2026-09-22T14:03:00.000000Z';
      event.received_at='2026-09-22T14:04:00.000000Z';
    });
    expect(f.run().claims[0]).toMatchObject({ standing: 'pending',reasons: ['eligible_confirmation_unavailable'] });
  });
  it('accepts a same-timestamp later classification only with its sequence beyond the split',() => {
    const f=laterVerdict();
    f.source.storedRun.received_at=f.f.transfer.split.receipt.received_at;
    f.source.classification.received_at=f.f.transfer.split.receipt.received_at;
    f.source.classification.sequence=4;
    f.receipt.sequence=5; f.history.histories.at(-1)!.eventSequence=5;
    expect(f.run().claims[0]!.standing).toBe('dismissed');
    f.source.classification.sequence=3;
    expect(f.run().claims[0]!.standing).toBe('pending');
  });
  it('replays version 1 standing without applying version 2 later-verdict semantics',() => {
    const f=laterVerdict();
    const retained=f.run(1);
    expect(retained).toMatchObject({ version: 1,claims: [{ standing: 'pending',dispositionEventId: f.disposition.receipt.id }] });
    expect(f.run()).toMatchObject({ version: 2,claims: [{ standing: 'dismissed',dispositionEventId: f.receipt.id }] });
    expect(f.run(1)).toEqual(retained);
    expect(() => f.run(3 as 1)).toThrow('current_claim_projection_conflict');
  });
  it('keeps a later same-severity gated repeat adverse until a new explicit decision',() => {
    const f=laterVerdict();
    const source=laterSource(f.f.disposition,3,true,'critical');
    source.classification.received_at='2026-09-22T15:00:00.000000Z';
    f.add(source);
    expect(f.run().claims[0]).toMatchObject({ standing: 'pending',reasons: ['adverse_later_sighting'] });
  });
  it('allows a clean higher confirmation to supersede lower adverse rounds after a fixed assertion',() => {
    const f=laterVerdict();
    f.receipt.payload.verdicts[0]!.verdict='fixed';
    const source=laterSource(f.f.disposition,3,true,'critical');
    source.classification.received_at='2026-09-22T14:02:00.000000Z'; f.add(source);
    f.confirm((report,stored,event) => {
      report.run.converge.round=4; event.round=4;
      report.run.started_at='2026-09-22T14:03:00.000000Z';
      report.run.finished_at='2026-09-22T14:04:00.000000Z';
      stored.received_at='2026-09-22T14:05:00.000000Z'; event.received_at='2026-09-22T14:06:00.000000Z';
    });
    expect(f.run().claims[0]!.standing).toBe('confirmed-fixed');
  });
  it('does not lower a critical floor with an unmarked later important source',() => {
    const f=laterVerdict();
    f.receipt.payload.verdicts[0]!.severity='important';
    const source=laterSource(f.f.disposition,3,true,'important');
    delete source.classification.payload.classification_version;
    f.add(source);
    expect(f.run().claims[0]).toMatchObject({ standing: 'pending',reasons: ['critical_disposition_required'] });
  });
  it('retains an original conflicting binding even when a later correction moves its key away',() => {
    const f=laterVerdict();
    const source=laterSource(f.f.disposition,3,true,'important');
    reviseSource(source,report => { report.findings[0].claimDescriptor.invariant='A different independent claim.'; });
    const mapping=(source.classification.payload.identities as any[])[0];
    source.corrections=[{ ...source.classification,id: uuid(977),kind: 'finding_identity_corrected',sequence: 2,payload: {
      org_id: source.scope.org_id,repo: source.scope.repo,pr_number: source.scope.pr_number,
      head_sha: (source.storedRun.target as any).head_sha,report_json_sha256: sha(source.reportJson),
      finding_ref: 'f001',identity_key: mapping.identity_key,matched_identity: '3333333333333333',
    } }];
    f.add(source);
    expect(f.run().claims[0]).toMatchObject({ standing: 'pending',reasons: ['claim_binding_unproven'] });
  });
  it('requires a new critical decision after an important fixed assertion despite a clean later review',() => {
    const f=laterVerdict();
    reviseSource(f.source,report => { report.findings[0].severity='important'; });
    f.history.sources.at(-1)!.reportJson=f.source.reportJson;
    f.history.sources.at(-1)!.selector.reportSha256=sha(f.source.reportJson);
    f.receipt.payload.verdicts[0]!.verdict='fixed'; f.receipt.payload.verdicts[0]!.severity='important';
    const source=laterSource(f.f.disposition,3,true,'critical');
    source.classification.received_at='2026-09-22T14:02:00.000000Z'; f.add(source);
    f.confirm((report,stored,event) => {
      report.run.converge.round=4; event.round=4;
      report.run.started_at='2026-09-22T14:03:00.000000Z'; report.run.finished_at='2026-09-22T14:04:00.000000Z';
      stored.received_at='2026-09-22T14:05:00.000000Z'; event.received_at='2026-09-22T14:06:00.000000Z';
    });
    expect(f.run().claims[0]).toMatchObject({ standing: 'pending',reasons: ['critical_disposition_required'] });
  });
  it('keeps a conflicting later gated binding pending when the original claim was nongating',() => {
    const f=setup('dismissed',true);
    expect(f.anchor.source.gating).toBe('none');
    const source=laterSource(f.f.disposition,2,true,'critical');
    reviseSource(source,report => { report.findings[0].claimDescriptor.invariant='A different independent claim.'; });
    f.add(source);
    const result=f.run();
    expect(result.claims[0]).toMatchObject({ standing: 'pending',reasons: ['claim_binding_unproven'] });
    expect(result.actionableIdentities).toContain(f.anchor.identity);
  });
  it('uses a later bound critical verdict by server chronology, retaining independent original residuals',() => {
    const f=laterVerdict();
    const before=JSON.stringify({ state: f.state,history: f.history,anchor: f.anchor,disposition: f.disposition });
    const result=f.run();
    expect(result.claims[0]).toMatchObject({ standing: 'dismissed',dispositionEventId: f.receipt.id });
    expect(result.actionableIdentities).not.toContain(f.anchor.identity);
    expect(result.actionableIdentities).toContain(f.anchor.source.previousIdentity);
    expect(JSON.stringify({ state: f.state,history: f.history,anchor: f.anchor,disposition: f.disposition })).toBe(before);
    // Sequence 2 belongs to another run; it must supersede the older Mode B
    // sequence 5 by its genuine later received_at, never by client time.
    expect(f.receipt.sequence).toBeLessThan(f.disposition.receipt.sequence);
  });
  it.each(['unmarked','before-classification','before-split','wrong-claim','wrong-descriptor','missing-source-time',
    'invalid-actor','duplicate-entry','insufficient-severity','reclassified','same-time-other-run'])
  ('does not clear a recovered claim with %s later verdict evidence',kind => {
    const f=laterVerdict();
    if(kind==='unmarked') delete f.source.classification.payload.classification_version;
    if(kind==='before-classification') f.receipt.received_at='2026-09-22T13:59:00.000000Z';
    if(kind==='before-split') {
      f.source.storedRun.received_at='2026-09-22T11:00:00.000000Z';
      f.source.classification.received_at='2026-09-22T11:01:00.000000Z';
    }
    if(kind==='wrong-claim') f.receipt.payload.verdicts[0]!.identity_key='3333333333333333';
    if(kind==='wrong-descriptor') {
      const source=f.history.sources.at(-1)!;
      const report=JSON.parse(source.reportJson!);
      report.findings[0].claimDescriptor.invariant='A different independent upper-bound failure.';
      source.reportJson=JSON.stringify(report); source.selector.reportSha256=sha(source.reportJson);
      const stored=source.storedRun as any;
      stored.findings[0].claim_descriptor=report.findings[0].claimDescriptor;
      stored.artifacts[0].declared_sha256=source.selector.reportSha256;
      stored.artifacts[0].declared_bytes=Buffer.byteLength(source.reportJson);
      f.source.classification.payload.report_json_sha256=source.selector.reportSha256;
      const mapping=(f.source.classification.payload.identities as any[])[0];
      mapping.report_json_sha256=source.selector.reportSha256; mapping.claim_descriptor=report.findings[0].claimDescriptor;
    }
    if(kind==='missing-source-time') delete f.source.storedRun.received_at;
    if(kind==='invalid-actor') f.receipt.actor_user_id=null as any;
    if(kind==='duplicate-entry') f.receipt.payload.verdicts.push({ ...f.receipt.payload.verdicts[0]! });
    if(kind==='insufficient-severity') f.receipt.payload.verdicts[0]!.severity='important';
    if(kind==='reclassified') {
      const history=f.history.histories.at(-1)!;
      history.receipts.push({ ...f.source.classification,id: uuid(926),sequence: 2 });
      f.receipt.sequence=3; history.eventSequence=3;
    }
    if(kind==='same-time-other-run') {
      f.disposition.receipt.received_at=f.receipt.received_at;
    }
    expect(f.run().claims[0]!.standing).toBe('pending');
    expect(f.run().actionableIdentities).toContain(f.anchor.identity);
  });
  it('refuses a later verdict receipt placed in the wrong run history',() => {
    const f=laterVerdict();
    f.receipt.run_id=uuid(999);
    expect(() => f.run()).toThrow('current_claim_projection_conflict');
  });
  it.each([2,5])('requires confirmation beyond the actual later fixed assertion round %s',round => {
    const f=laterVerdict(round);
    f.receipt.payload.verdicts[0]!.verdict='fixed';
    expect(f.run().claims[0]!.standing).toBe('pending');
    f.confirm((report,stored,event) => {
      report.run.converge.round=3; event.round=3;
      report.run.started_at='2026-09-22T14:01:00.000001Z';
      report.run.finished_at='2026-09-22T14:02:00.000000Z';
      stored.received_at='2026-09-22T14:03:00.000000Z';
      event.received_at='2026-09-22T14:04:00.000000Z';
    });
    expect(f.run().claims[0]!.standing).toBe(round===2? 'confirmed-fixed':'pending');
  });
  it('keeps source unavailability and other target scope conflict explicit',() => {
    const f=setup('dismissed');
    f.history.sources[0]!.reportJson=null;
    expect(f.run().claims[0]!.standing).toBe('pending');
    expect(f.run().residuals.length).toBeGreaterThan(0);
    f.history.sources[0]!.selector.scope.org_id=uuid(999);
    expect(() => f.run()).toThrow('current_claim_projection_conflict');
  });
  it('invalidates cached standing after an ordinary native mutation but not recovery metadata alone',() => {
    const f=setup();
    const hash=nativeProjectionFingerprint(f.state);
    expect(nativeProjectionFingerprint({ ...f.state,version: 3,recovery: { version: 2,operations: [] } })).toBe(hash);
    f.state.updatedAt='2026-09-24T00:00:00.000Z';
    expect(nativeProjectionFingerprint(f.state)).not.toBe(hash);
  });
});
