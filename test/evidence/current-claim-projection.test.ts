import { describe,expect,it } from 'vitest';
import { deriveCurrentClaimProjection,nativeProjectionFingerprint,recoveryProjectionFreshness } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import { packNativeMaterial } from '../../src/evidence/claim-recovery/validation/native-material.js';
import { correctionAnchor } from '../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimDisposition,prepareObligationTransfer } from '../../src/evidence/claim-recovery/validation/occurrence.js';
import { fixture,laterSource } from './recovery-validation/occurrence-fixtures.js';
import { sha,uuid } from './recovery-validation/fixtures.js';
import { sampleResult,sampleReview } from '../telemetry/fixtures.js';
import { projection } from './original-run-fixtures.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import type { ClaimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
const floor='2026-09-22T13:00:00.123456Z';
function setup(verdict: 'fixed'|'dismissed'='fixed') {
  const f=fixture();
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
  const run=() => deriveCurrentClaimProjection(state,[anchor],[{ transfers: [transfer],dispositions: [disposition],carriers: [],pendingIdentities: [] } as any],history,[],split.selection.nativeJson);
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
