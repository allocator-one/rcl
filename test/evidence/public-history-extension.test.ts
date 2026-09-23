import { describe,expect,it } from 'vitest';
import { assertHistoryExtension } from '../../src/evidence/claim-recovery/public-model.js';
import type { ClaimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { fixture } from './recovery-validation/occurrence-fixtures.js';
import { projectedRun } from './public-claim-loopback.js';
import { sha,uuid } from './recovery-validation/fixtures.js';

function extension() {
  const f=fixture();
  const { source,selection,receipt }=f.transfer.split;
  const before: ClaimHistoryContent={
    readWindow: { startedAt: '2026-09-22T14:00:00Z',completedAt: '2026-09-22T14:00:01Z' },
    actorUserId: receipt.actor_user_id!,
    sources: [{ selector: { scope: source.scope,target: selection.target,round: receipt.round!,
      headSha: (source.storedRun.target as any).head_sha,reportSha256: sha(source.reportJson) },
    reportJson: source.reportJson,storedRun: source.storedRun,classifications: [source.classification],corrections: [],correctionIds: [] }],
    histories: [{ runId: source.scope.run_id,eventSequence: 2,receipts: [source.classification,f.originalVerdict] }]
  };
  const after=structuredClone(before);
  after.histories[0]!.eventSequence=3;
  after.histories[0]!.receipts.push(receipt);
  after.sources[0]!.storedRun=projectedRun(source.storedRun,[receipt]);
  const owned=new Map([[receipt.id,JSON.stringify(prepareClaimSplit(selection).event)]]);
  return { before,after,owned,receipt };
}

describe('preview history extension after an owned split',()=>{
  it('accepts exactly the authenticated split-derived finding projection without modifying either history',()=>{
    const { before,after,owned }=extension();
    const original=structuredClone({ before,after });
    expect(()=>assertHistoryExtension(before,after,owned)).not.toThrow();
    expect({ before,after }).toEqual(original);
  });
  it('allows unchanged source projections while receipt propagation catches up',()=>{
    const { before,after,owned }=extension();
    after.sources=structuredClone(before.sources);
    expect(()=>assertHistoryExtension(before,after,owned)).not.toThrow();
  });
  it('allows only removal of an inherited displayed verdict after splitting to the unused identity',()=>{
    const { before,after,owned }=extension();
    (before.sources[0]!.storedRun!.findings as any[])[0].verdict={
      identity_key: '1111111111111111',verdict: 'fixed',reason: 'Historical shared-key decision.',
      round: 1,recorded_at: '2026-09-22T11:10:00.123456Z',actor: { id: uuid(9) }
    };
    (after.sources[0]!.storedRun!.findings as any[])[0].verdict=null;
    expect(()=>assertHistoryExtension(before,after,owned)).not.toThrow();
    (after.sources[0]!.storedRun!.findings as any[])[0].verdict={ verdict: 'dismissed' };
    expect(()=>assertHistoryExtension(before,after,owned)).toThrow();
  });
  it.each(['actor','payload','occurred_at','scope','target','round','unowned'])('rejects %s changes even with a matching displayed split identity',kind=>{
    const { before,after,owned,receipt }=extension();
    const changed=after.histories[0]!.receipts.at(-1)!;
    if(kind==='actor') changed.actor_user_id=uuid(999);
    if(kind==='payload') changed.payload.reason='Changed prepared evidence.';
    if(kind==='occurred_at') changed.occurred_at='2026-09-22T12:00:00.123457Z';
    if(kind==='scope') changed.org_id=uuid(999);
    if(kind==='target') changed.converge_target='another-target';
    if(kind==='round') changed.round=2;
    if(kind==='unowned') owned.delete(receipt.id);
    after.sources[0]!.storedRun=projectedRun(before.sources[0]!.storedRun!,[changed]);
    expect(()=>assertHistoryExtension(before,after,owned)).toThrow();
  });
  it.each(['identity','actor','received_at','descriptor','native_evidence','source_event_ids','extra_field','other_member'])('rejects unbound %s projection changes',kind=>{
    const { before,after,owned }=extension();
    const findings=after.sources[0]!.storedRun!.findings as any[];
    const finding=findings[0];
    if(kind==='identity') finding.claim_identity='3333333333333333';
    if(kind==='actor') finding.identity_provenance.actor_user_id=uuid(999);
    if(kind==='received_at') finding.identity_provenance.received_at='2026-09-22T12:00:00.123457Z';
    if(kind==='descriptor') finding.identity_provenance.claim_descriptor.invariant='Another claim';
    if(kind==='native_evidence') finding.identity_provenance.native_evidence.state_sha256='a'.repeat(64);
    if(kind==='source_event_ids') finding.identity_provenance.source_event_ids=[];
    if(kind==='extra_field') finding.identity_provenance.attested=true;
    if(kind==='other_member') Object.assign(findings[1],{ claim_identity: finding.claim_identity,identity_provenance: finding.identity_provenance });
    expect(()=>assertHistoryExtension(before,after,owned)).toThrow();
  });
  it.each(['original','artifact','url','identity_key','descriptor','classification','correction','old_receipt','external_event'])('preserves strict %s source/history equality',kind=>{
    const { before,after,owned }=extension();
    const source=after.sources[0]!;
    if(kind==='original') source.reportJson+=' ';
    if(kind==='artifact') (source.storedRun!.artifacts as any[])[0].declared_sha256='a'.repeat(64);
    if(kind==='url') (source.storedRun!.artifacts as any[])[0].url='https://other.example/original';
    if(kind==='identity_key') (source.storedRun!.findings as any[])[0].identity_key='3333333333333333';
    if(kind==='descriptor') (source.storedRun!.findings as any[])[0].claim_descriptor.invariant='Another claim';
    if(kind==='classification') source.classifications![0]!.payload.identities=[];
    if(kind==='correction') source.correctionIds!.push(uuid(999));
    if(kind==='old_receipt') after.histories[0]!.receipts[0]!.received_at='2026-09-22T12:00:00.123457Z';
    if(kind==='external_event') { after.histories[0]!.receipts.push({ ...after.histories[0]!.receipts.at(-1)!,id: uuid(999),sequence: 4 }); after.histories[0]!.eventSequence=4; }
    expect(()=>assertHistoryExtension(before,after,owned)).toThrow();
  });
  it('rejects a projected split without any newly accepted owned receipt',()=>{
    const { before,after,owned }=extension();
    after.histories=structuredClone(before.histories);
    expect(()=>assertHistoryExtension(before,after,owned)).toThrow();
  });
});
