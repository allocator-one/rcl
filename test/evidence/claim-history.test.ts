import { describe,expect,it } from 'vitest';
import { readClaimTargetHistory,claimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { historyFixture } from './claim-history-fixture.js';
import { sha, uuid } from './recovery-validation/fixtures.js';
async function read(f: ReturnType<typeof historyFixture>) { return readClaimTargetHistory(f.sink,f.sources[0]!.selector,f.actor); }
describe('complete pinned claim history',() => {
  it('refuses a self-consistent artifact that differs from the authenticated run digest', async () => {
    const f = historyFixture(false);
    const selection = structuredClone(f.sources[0]!.selector);
    expect((await readClaimTargetHistory(f.sink, selection, f.actor)).kind).toBe('ok');
    const source = f.sources[0]!;
    const original = source.reportJson!;
    const report = JSON.parse(original);
    report.findings[0].title = 'Altered cache entries';
    const alternate = JSON.stringify(report);
    expect(Buffer.byteLength(alternate)).toBe(Buffer.byteLength(original));
    expect(sha(alternate)).not.toBe(selection.reportSha256);
    // The transport body and header agree; the selected and stored digests stay pinned.
    source.reportJson = alternate;
    source.selector.reportSha256 = sha(alternate);
    expect(await readClaimTargetHistory(f.sink, selection, f.actor))
      .toMatchObject({ kind: 'conflict', message: 'claim_history_artifact_conflict' });
  });

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
    const result = await read(f);
    expect(result.kind).not.toBe('ok');
    const expected = {
      'missing-receipt': { kind: 'conflict', message: 'claim_history_receipt_unavailable' },
      'inline-prefix': { kind: 'conflict', message: 'claim_history_inline_index_conflict' },
      'false-complete': { kind: 'conflict', message: 'claim_history_inline_index_conflict' },
      'sequence-drift': { kind: 'conflict', message: 'claim_history_changed' },
    }[kind] ?? { kind: 'rejected', error: 'malformed_response' };
    expect(result).toMatchObject(expected);
  });
  it('refuses duplicate receipts in place of a complete indexed event batch', async () => {
    const f = historyFixture(false);
    const source = f.sources[0]!;
    source.corrections = [{ ...source.classifications![0]!, id: uuid(1000), sequence: 2, kind: 'finding_identity_corrected', payload: {} }];
    source.correctionIds = source.corrections.map(receipt => receipt.id);
    expect((await read(f)).kind).toBe('ok');
    let corruptedBatches = 0;
    f.change((body, url) => {
      if (url.searchParams.get('ids')) {
        expect(url.searchParams.get('ids')!.split(',')).toHaveLength(2);
        expect(body.data).toHaveLength(2);
        body.data = [body.data[0], body.data[0]];
        corruptedBatches++;
      }
      return body;
    });
    expect(await read(f)).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    expect(corruptedBatches).toBe(1);
  });

  it('accepts a selected repository spelling that differs only in case from retained history', async () => {
    const f = historyFixture(false); const selection = structuredClone(f.sources[0]!.selector);
    selection.scope.repo = selection.scope.repo.toUpperCase();
    const result = await readClaimTargetHistory(f.sink, selection, f.actor);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw Error(JSON.stringify(result));
    expect(claimHistoryContent(result.value).sources).toEqual(f.sources);
  });
});
