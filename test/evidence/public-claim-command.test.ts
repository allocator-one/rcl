import { afterEach,describe,expect,it } from 'vitest';
import { readFile,readdir,writeFile,unlink } from 'node:fs/promises';
import { sha } from './recovery-validation/fixtures.js';
import { fixture as originalFixture,laterSource,rebind } from './recovery-validation/occurrence-fixtures.js';
import { uuid } from './recovery-validation/fixtures.js';
import { publicLoopback } from './public-claim-loopback.js';
const cleanups: Array<() => Promise<void>>=[];
afterEach(async () => {
  for(const fn of cleanups.splice(0))
    await fn();
});
async function fixture() { const f=await publicLoopback(); cleanups.push(f.cleanup); return f; }
describe('actual public Mode B command',{ timeout: 45000 },() => {
  it.each(['finding', 'verdict', 'split', 'classification'])('refuses a new claim key with prior %s history before creating a manifest or event', async kind => {
    const input = originalFixture();
    const f = await publicLoopback(input);
    cleanups.push(f.cleanup);
    const before = await readFile(f.statePath);
    if (kind === 'classification') {
      f.addSource(laterSource(input.disposition, 2, true, 'important'));
    } else if (kind === 'finding') {
      f.change((body, url) => {
        if (url.pathname.endsWith('/runs/' + f.source.scope.run_id)) {
          body.data.findings[0].identity_key = f.selection.identity;
        }
        return body;
      });
    } else if (kind === 'verdict') {
      const receipt = structuredClone(input.originalVerdict);
      receipt.id = uuid(780);
      (receipt.payload.verdicts as any[])[0].identity_key = f.selection.identity;
      f.addReceipt(receipt);
    } else {
      f.addReceipt(input.transfer.split.receipt);
    }
    const result = await f.preview();
    expect(JSON.parse(result.stdout), result.stdout).toMatchObject({ status: 'refused', reason: 'claim_identity_already_used' });
    expect(result.exit).not.toBe(0);
    expect(f.calls.filter(call => call.method === 'POST')).toEqual([]);
    expect(await readFile(f.statePath)).toEqual(before);
    expect(await readdir(f.root + '/operation')).toEqual(['selection.json']);
  });
  it.each(['changed','missing'])('refuses %s shared operation proof before POST or native mutation',async (kind) => {
    const f=await fixture();
    const before=await readFile(f.statePath);
    expect((await f.preview()).exit).toBe(0);
    const root=JSON.parse(await readFile(f.manifest+'.material','utf8'));
    const material=f.manifest+'.proofs/'+root.sha256s[0];
    if(kind==='missing')
      await unlink(material);
    else
      await writeFile(material,'changed');
    expect((await f.execute()).exit).not.toBe(0);
    expect(f.calls.filter(c => c.method==='POST')).toEqual([]);
    expect(await readFile(f.statePath)).toEqual(before);
  });
  it('previews a later important decision consistently with the latest proven gated batch',async () => {
    const input=originalFixture();
    input.report.findings[0].severity='critical';
    rebind(input.disposition,input.report);
    const f=await publicLoopback(input);
    cleanups.push(f.cleanup);
    await writeFile(f.selectionPath,JSON.stringify({ ...f.selection,disposition: { ...f.selection.disposition,severity: 'critical' } }));
    expect((await f.preview()).exit).toBe(0);
    expect((await f.execute()).exit).toBe(0);
    const later=laterSource(input.disposition,2,true,'important');
    later.classification.received_at=new Date().toISOString();
    f.addSource(later);
    const path=f.root+'/operation/later.json';
    const selection=f.root+'/operation/later-selection.json';
    await writeFile(selection,JSON.stringify({
      ...f.selection,action: 'disposition',disposition: {
        ...f.selection.disposition,
        severity: 'important',reason: 'Explicit decision against the later important gated batch.'
      }
    }));
    const preview=await f.command(['--preview','--selection',selection,'--manifest',path,'--json']);
    expect(preview,preview.stdout).toMatchObject({ exit: 0 });
    const applied=await f.command(['--apply','--manifest',path,'--manifest-sha256',sha(await readFile(path,'utf8')),'--json']);
    expect(applied,applied.stdout).toMatchObject({ exit: 0 });
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(4);
  });
  it('previews without effects then applies split/transfer/fresh disposition and resumes without duplicate POST',async () => {
    const f=await fixture();
    const original=await readFile(f.statePath);
    const report=f.source.reportJson;
    expect(await f.preview()).toMatchObject({ exit: 0,stderr: '' });
    expect(await readFile(f.statePath)).toEqual(original);
    expect(f.calls.every(c => c.method==='GET')).toBe(true);
    const apply=await f.execute();
    expect(apply,apply.stdout+apply.stderr).toMatchObject({ exit: 0,stderr: '' });
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(3);
    const outcome=JSON.parse(apply.stdout);
    expect(outcome.actionable_identities).toContain(f.selection.previousIdentity);
    expect(outcome.actionable_identities).not.toContain(f.selection.identity);
    const state=JSON.parse(await readFile(f.statePath,'utf8'));
    expect(state.version).toBe(3);
    expect(state.recovery.version).toBe(2);
    expect(state.recovery.operations[0].material.rootSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(state.recovery.operations[0].occurrences).toBeUndefined();
    for(const field of ['rounds','findings','roundCap'])
      expect(state[field]).toEqual(JSON.parse(original.toString())[field]);
    expect(state.recovery.operations[0].anchors[0].source.findingRef).toBe('f001');
    const resumed=await f.execute('resume');
    expect(resumed,resumed.stdout+resumed.stderr).toMatchObject({ exit: 0,stderr: '' });
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(3);
    expect(f.source.reportJson).toBe(report);
    expect(await readFile(f.statePath,'utf8')).toBe(JSON.stringify(state,null,2)+'\n');
  });
  it('resolves every accepted POST with lost acknowledgments from exact authenticated receipts',async () => {
    const f=await fixture();
    expect((await f.preview()).exit).toBe(0);
    f.loseAck();
    const result=await f.execute();
    expect(result,result.stdout+result.stderr).toMatchObject({ exit: 0 });
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(3);
    expect((await f.execute('resume')).exit).toBe(0);
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(3);
  });
  it('retains an uncertain accepted event and resumes the same UUID after receipt reads recover',async () => {
    const f=await fixture();
    // Backend FindingVerdicts drops this legacy co-key display after split.
    (f.source.storedRun.findings as any[])[0].verdict={ identity_key: f.selection.previousIdentity,
      verdict: 'fixed',reason: 'Historical shared-key decision.',round: 1,
      recorded_at: f.receipts[1].received_at,actor: { id: f.receipts[1].actor_user_id } };
    const before=await readFile(f.statePath);
    expect((await f.preview()).exit).toBe(0);
    f.hideAfterPost();
    const uncertain=await f.execute();
    expect(uncertain.exit).not.toBe(0);
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(1);
    expect(await readFile(f.statePath)).toEqual(before);
    const first=(f.calls.find(c => c.method==='POST')!.body as any).events[0];
    f.hideAfterPost(false);
    const resumed=await f.execute('resume');
    expect(resumed,resumed.stdout).toMatchObject({ exit: 0 });
    const posted=f.calls.filter(c => c.method==='POST').flatMap(c => (c.body as any).events);
    expect(posted).toHaveLength(3);
    expect(posted.filter((event: any) => event.id===first.id)).toHaveLength(1);
  });
  it('refreshes an existing anchor with no new event and fails if retained material disappears',async () => {
    const f=await fixture();
    expect((await f.preview()).exit).toBe(0);
    expect((await f.execute()).exit).toBe(0);
    const next={ ...f.selection,action: 'refresh',disposition: undefined };
    const selectionPath=f.root+'/operation/refresh-selection.json';
    const manifest=f.root+'/operation/refresh.json';
    await writeFile(selectionPath,JSON.stringify(next));
    const preview=await f.command(['--preview','--selection',selectionPath,'--manifest',manifest,'--json']);
    expect(preview,preview.stdout).toMatchObject({ exit: 0 });
    const result=await f.command(['--apply','--manifest',manifest,'--manifest-sha256',sha(await readFile(manifest,'utf8')),'--json']);
    expect(result,result.stdout).toMatchObject({ exit: 0 });
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(3);
    const native=JSON.parse(await readFile(f.statePath,'utf8'));
    const material=native.recovery.operations.at(-1).material;
    await writeFile(f.statePath+'.recovery-materials/'+material.rootSha256,'{}');
    const failed=await f.command(['--preview','--selection',selectionPath,'--manifest',f.root+'/operation/refuse.json','--json']);
    expect(failed.exit).not.toBe(0);
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(3);
  });
  it('keeps each co-key member pending until all kept and appendix occurrences have separate accepted transfers',async () => {
    const f=await fixture();
    expect((await f.preview()).exit).toBe(0);
    expect((await f.execute()).exit).toBe(0);
    const sizes: number[]=[];
    for(const [ref,identity] of [['f002','3333333333333333'],['f003','4444444444444444']]) {
      const selectionPath=f.root+'/operation/'+ref+'-selection.json';
      const manifest=f.root+'/operation/'+ref+'.json';
      await writeFile(selectionPath,JSON.stringify({ ...f.selection,findingRef: ref,identity }));
      const preview=await f.command(['--preview','--selection',selectionPath,'--manifest',manifest,'--json']);
      expect(preview,preview.stdout).toMatchObject({ exit: 0 });
      const applied=await f.command(['--apply','--manifest',manifest,'--manifest-sha256',sha(await readFile(manifest,'utf8')),'--json']);
      expect(applied,applied.stdout).toMatchObject({ exit: 0 });
      const output=JSON.parse(applied.stdout);
      if(ref==='f002')
        expect(output.actionable_identities).toContain(f.selection.previousIdentity);
      else
        expect(output.actionable_identities).toEqual([]);
      sizes.push((await readFile(f.statePath)).length);
    }
    expect(sizes[1]!).toBeLessThan(sizes[0]!*2);
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(9);
    const state=JSON.parse(await readFile(f.statePath,'utf8'));
    expect(state.recovery.operations).toHaveLength(3);
    expect(state.rounds).toEqual(JSON.parse(f.original.nativeJson).rounds);
    // A later, unambiguous marked empty report does not undo the complete transfer.
    const later=laterSource(originalFixture().disposition,2);
    let report=JSON.parse(later.reportJson);
    report.findings=[];
    report.belowThresholdFindings=[];
    later.reportJson=JSON.stringify(report);
    later.storedRun={
      ...report.run,artifacts: [{
        kind: 'report_json',declared_sha256: sha(later.reportJson),
        declared_bytes: Buffer.byteLength(later.reportJson),stored: true
      }],findings: []
    };
    later.classification.payload={ classification_version: 1,report_json_sha256: sha(later.reportJson),identities: [] };
    f.addSource(later);
    async function refresh(name: string) {
      const path=f.root+'/operation/'+name+'.json';
      const selected=f.root+'/operation/'+name+'-selection.json';
      await writeFile(selected,JSON.stringify({ ...f.selection,action: 'refresh',disposition: undefined }));
      const preview=await f.command(['--preview','--selection',selected,'--manifest',path,'--json']);
      expect(preview,preview.stdout).toMatchObject({ exit: 0 });
      const result=await f.command(['--apply','--manifest',path,'--manifest-sha256',sha(await readFile(path,'utf8')),'--json']);
      expect(result,result.stdout).toMatchObject({ exit: 0 });
      return JSON.parse(result.stdout);
    }
    expect((await refresh('later-empty')).actionable_identities).toEqual([]);
    // An earlier run is uploaded afterwards; the old snapshot is not current approval.
    const late=structuredClone(f.source);
    report=JSON.parse(late.reportJson);
    report.run.id=uuid(800);
    late.scope.run_id=report.run.id;
    late.reportJson=JSON.stringify(report);
    late.storedRun={
      ...late.storedRun,...report.run,
      artifacts: [{ kind: 'report_json',declared_sha256: sha(late.reportJson),declared_bytes: Buffer.byteLength(late.reportJson),stored: true }]
    };
    late.classification={ ...late.classification,id: uuid(801),run_id: report.run.id,sequence: 1 };
    f.addSource(late);
    const refreshed=await refresh('earlier-arrival');
    expect(refreshed.actionable_identities).toContain(f.selection.previousIdentity);
    expect(refreshed.projection_freshness.read_window.completedAt).toBeTruthy();
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(9);
  },90000);
  it('rejects unsupported preserved attribution at preview before creating events or a manifest',async () => {
    const f=await fixture();
    const report=JSON.parse(f.source.reportJson);
    for(const member of [...report.findings,...report.belowThresholdFindings])
      delete member.claimDescriptor;
    // The selected descriptor remains an explicit correction, never historical evidence.
    f.replaceOriginal(report);
    await writeFile(f.selectionPath,JSON.stringify({
      ...f.selection,disposition: {
        mode: 'preserved',verdict: 'fixed',
        severity: 'important',reason: f.receipts[1].payload.verdicts[0].reason,originalVerdictEventId: f.receipts[1].id
      }
    }));
    const before=await readFile(f.statePath);
    const preview=await f.preview();
    expect(preview.exit).not.toBe(0);
    expect(await readdir(f.root+'/operation')).toEqual(['selection.json']);
    expect(f.calls.every(c => c.method==='GET')).toBe(true);
    expect(await readFile(f.statePath)).toEqual(before);
  });
  it('records a new explicit disposition on an existing anchor without another split or transfer',async () => {
    const f=await fixture();
    expect((await f.preview()).exit).toBe(0);
    expect((await f.execute()).exit).toBe(0);
    const path=f.root+'/operation/decision.json';
    const selection=f.root+'/operation/decision-selection.json';
    await writeFile(selection,JSON.stringify({
      ...f.selection,action: 'disposition',disposition: {
        ...f.selection.disposition,
        verdict: 'fixed',reason: 'A separate explicit fixed assertion; no confirming review exists.'
      }
    }));
    expect(await f.command(['--preview','--selection',selection,'--manifest',path,'--json'])).toMatchObject({ exit: 0 });
    const result=await f.command(['--apply','--manifest',path,'--manifest-sha256',sha(await readFile(path,'utf8')),'--json']);
    expect(result,result.stdout).toMatchObject({ exit: 0 });
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(4);
    expect(JSON.parse(result.stdout).actionable_identities).toContain(f.selection.identity);
  });
  it('uses an exact post-split ordinary dismissal without borrowing the old bare-key verdict',async () => {
    const f=await fixture();
    await writeFile(f.selectionPath,JSON.stringify({ ...f.selection,disposition: undefined }));
    expect((await f.preview()).exit).toBe(0);
    const applied=await f.execute();
    expect(applied,applied.stdout).toMatchObject({ exit: 0 });
    expect(JSON.parse(applied.stdout).actionable_identities).toContain(f.selection.identity);
    f.addReceipt({
      ...f.receipts[1],id: uuid(890),actor_user_id: uuid(900),received_at: new Date().toISOString(),
      payload: { verdicts: [{ identity_key: f.selection.identity,verdict: 'dismissed',severity: 'important',reason: 'Exact recovered claim only.' }] }
    });
    const path=f.root+'/operation/ordinary.json';
    const selected=f.root+'/operation/ordinary-selection.json';
    await writeFile(selected,JSON.stringify({ ...f.selection,action: 'refresh',disposition: undefined }));
    expect(await f.command(['--preview','--selection',selected,'--manifest',path,'--json'])).toMatchObject({ exit: 0 });
    const result=await f.command(['--apply','--manifest',path,'--manifest-sha256',sha(await readFile(path,'utf8')),'--json']);
    expect(result,result.stdout).toMatchObject({ exit: 0 });
    expect(JSON.parse(result.stdout).actionable_identities).not.toContain(f.selection.identity);
    expect(JSON.parse(result.stdout).actionable_identities).toContain(f.selection.previousIdentity);
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(2);
  });
  it('refuses newly changed server history before apply without using the preview snapshot as current authority', async () => {
    const f = await fixture(); const before = await readFile(f.statePath);
    expect((await f.preview()).exit).toBe(0);
    f.addSource(laterSource(originalFixture().disposition, 2));
    expect((await f.execute()).exit).not.toBe(0);
    expect(f.calls.filter(c => c.method === 'POST')).toEqual([]);
    expect(await readFile(f.statePath)).toEqual(before);
  });
  it('refuses changed actor after preview before POST or native mutation',async () => {
    const f=await fixture();
    const before=await readFile(f.statePath);
    expect((await f.preview()).exit).toBe(0);
    f.change(body => {
      if(body.meta?.actor_user_id)
        body.meta.actor_user_id='00000000-0000-7000-8000-000000009999'; return body;
    });
    expect((await f.execute()).exit).not.toBe(0);
    expect(f.calls.filter(c => c.method==='POST')).toEqual([]);
    expect(await readFile(f.statePath)).toEqual(before);
  });
  it('refuses duplicate original selector keys before HTTP and never creates a manifest',async () => {
    const f=await fixture();
    await writeFile(f.selectionPath,'{"version":1,"version":1}');
    expect((await f.preview()).exit).toBe(2);
    expect(f.calls).toEqual([]);
    expect(await readdir(f.root+'/operation')).toEqual(['selection.json']);
  });
});
