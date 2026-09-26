import { describe,expect,it } from 'vitest';
import { readClaimTargetHistory,claimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { historyFixture } from './claim-history-fixture.js';
import { uuid } from './recovery-validation/fixtures.js';
async function read(f: ReturnType<typeof historyFixture>) { return readClaimTargetHistory(f.sink,f.sources[0]!.selector,f.actor); }
describe('complete pinned claim history',() => {
  it('always indexes all same-target runs including later rounds and reconstructs exact selected history',async () => {
    const f=historyFixture();
    const result=await read(f);
    expect(result.kind).toBe('ok');
    if(result.kind!=='ok')
      throw Error(JSON.stringify(result));
    const c=claimHistoryContent(result.value);
    expect(c.sources).toHaveLength(3);
    expect(c.histories.flatMap(h => h.receipts)).toEqual([...f.sources].sort((a,b) => a.selector.scope.run_id.localeCompare(b.selector.scope.run_id)).flatMap(s => s.classifications!));
    expect(f.calls.filter(c => c.includes('index=claim_recovery'))).toHaveLength(3);
    expect(() => claimHistoryContent(JSON.parse(JSON.stringify(result.value)))).toThrow('unverified_claim_history');
  });
  it('discharges a truncated inline correction prefix only with the complete pinned index and receipts',async () => {
    const f=historyFixture(false);
    const s=f.sources[0]!;
    const first=s.classifications![0]!;
    s.corrections=Array.from({ length: 52 },(_,i) => ({ ...first,id: uuid(1000+i),sequence: i+2,kind: 'finding_identity_corrected',payload: {} }));
    s.correctionIds=s.corrections.map(e => e.id);
    f.change(body => {
      if(body.meta.recovery) {
        body.meta.recovery.truncated=true;
        body.meta.recovery.native_corrections.splice(2);
        body.meta.recovery.claim_events_complete=false;
        body.meta.recovery.claim_events.splice(3);
      } return body;
    });
    const result=await read(f);
    expect(result.kind).toBe('ok');
    if(result.kind!=='ok')
      throw Error(JSON.stringify(result));
    expect(claimHistoryContent(result.value).sources[0]!.corrections).toHaveLength(52);
    expect(f.calls.filter(c => c.includes('index=claim_recovery'))).toHaveLength(2);
  });
  it.each(['missing-receipt','bad-cursor','wrong-ceiling','unknown-kind','inline-prefix','false-complete','scope','sequence-drift'])('refuses %s without an authenticated history',async (kind) => {
    const f=historyFixture(false);
    f.change((body,url,visit) => {
      if(url.searchParams.get('index')) {
        if(kind==='bad-cursor') {
          body.meta.complete=false;
          body.meta.next_after_sequence=0;
        }
        if(kind==='wrong-ceiling')
          body.meta.through_sequence++;
        if(kind==='unknown-kind')
          body.data[0].kind='future_recovery';
        if(kind==='false-complete')
          body.data=[];
        if(kind==='scope')
          body.meta.org_id=uuid(999);
      }
      if(url.searchParams.get('ids')&&kind==='missing-receipt')
        body.data=[];
      if(body.meta.recovery) {
        if(kind==='inline-prefix')
          body.meta.recovery.claim_events[0].id=uuid(999);
        if(kind==='sequence-drift'&&visit>2)
          body.meta.recovery.event_sequence++;
      }
      return body;
    });
    expect((await read(f)).kind).not.toBe('ok');
  });
});
