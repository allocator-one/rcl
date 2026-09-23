import { afterEach,describe,expect,it } from 'vitest';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import { sha,uuid } from './recovery-validation/fixtures.js';
import { fixture as originalFixture,laterSource } from './recovery-validation/occurrence-fixtures.js';
import { publicLoopback } from './public-claim-loopback.js';
const cleanups: Array<() => Promise<void>>=[];
afterEach(async () => { for(const cleanup of cleanups.splice(0)) await cleanup(); });
async function interrupted(stage=1,accepted=true) {
  const input=originalFixture();
  const f=await publicLoopback(input);
  cleanups.push(f.cleanup);
  const original=await readFile(f.statePath);
  expect((await f.preview()).exit).toBe(0);
  const manifest=await readFile(f.manifest,'utf8');
  if(accepted) f.hideAfterPost(true,stage); else f.deferPostAt(stage);
  expect((await f.execute()).exit).not.toBe(0);
  expect(f.calls.filter(c => c.method==='POST')).toHaveLength(stage);
  f.hideAfterPost(false);
  const later=laterSource(input.disposition,2,true,'important');
  // A different claim is new target history, not new ownership of this key.
  for(const row of later.classification.payload.identities as any[]) row.matched_identity='8888888888888888';
  f.addSource(later);
  const next=f.root+'/operation/adopted.json';
  const adopt=() => f.command(['--preview','--adopt-manifest',f.manifest,'--adopt-manifest-sha256',sha(manifest),'--manifest',next,'--json']);
  const apply=async (mode='apply') => f.command(['--'+mode,'--manifest',next,'--manifest-sha256',sha(await readFile(next,'utf8')),'--json']);
  return { ...f,original,oldManifest:manifest,next,adopt,apply };
}
describe('public acknowledgment adoption',{timeout:60000},() => {
  it.each([1,2,3])('adopts %i exact acknowledged stages after lost ACK and foreign history, then uses fresh remaining events without reposting',async acceptedCount => {
    const f=await interrupted(acceptedCount);
    const split=(f.calls.find(c => c.method==='POST')!.body as any).events[0];
    expect((await f.execute('resume')).exit).not.toBe(0);
    const preview=await f.adopt();
    expect(preview,preview.stdout+preview.stderr).toMatchObject({exit:0});
    expect(await readFile(f.statePath)).toEqual(f.original);
    expect(await readFile(f.manifest,'utf8')).toBe(f.oldManifest);
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(acceptedCount);
    const old=JSON.parse(f.oldManifest),next=JSON.parse(await readFile(f.next,'utf8'));
    expect(next.stages[0].id).toBe(split.id);
    expect(next.stages.slice(acceptedCount).every((s:any) => !old.stages.some((o:any) => o.id===s.id))).toBe(true);
    const result=await f.apply();
    expect(result,result.stdout+result.stderr).toMatchObject({exit:0});
    expect((await f.apply('resume')).exit).toBe(0);
    const posted=f.calls.filter(c => c.method==='POST').flatMap(c => (c.body as any).events);
    expect(posted).toHaveLength(3);
    expect(posted.filter(e => e.kind==='finding_claim_split')).toEqual([split]);
    const state=JSON.parse(await readFile(f.statePath,'utf8'));
    for(const key of ['rounds','findings','roundCap']) expect(state[key]).toEqual(JSON.parse(f.original.toString())[key]);
  });
  it('requires complete authenticated absence reads before replacing unaccepted stages',async () => {
    const f=await interrupted();
    const old=JSON.parse(f.oldManifest);
    f.change((body,url) => {
      if(url.searchParams.get('ids')?.split(',').some(id => old.stages.slice(1).some((s:any) => s.id===id))) return {data:[],meta:{}};
      return body;
    });
    const result=await f.adopt();
    expect(result.exit).not.toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe('claim_adoption_receipt_unanswered');
    expect((await readdir(f.root+'/operation')).some(name => name.startsWith('adopted.json'))).toBe(false);
    expect(f.calls.filter(c => c.method==='POST')).toHaveLength(1);
    expect(await readFile(f.statePath)).toEqual(f.original);
  });
  it('refuses a superseded old packet arriving after adoption preview without posting its replacement',async () => {
    const f=await interrupted(2,false);
    expect((await f.adopt()).exit).toBe(0);
    const event=(f.calls.filter(c=>c.method==='POST')[1]!.body as any).events[0];
    f.addReceipt({...event,org_id:f.source.scope.org_id,repo:f.source.scope.repo,pr_number:f.source.scope.pr_number,actor_user_id:uuid(900),attempt:null,received_at:new Date().toISOString()});
    const result=await f.apply();
    expect(result.exit).not.toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe('claim_superseded_receipt_arrived');
    expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(2);
    expect(await readFile(f.statePath)).toEqual(f.original);
  });
  it('revalidates the retained old packet before applying an adoption manifest',async () => {
    const f=await interrupted();
    expect((await f.adopt()).exit).toBe(0);
    const id=JSON.parse(f.oldManifest).stages[0].id;
    await writeFile(`${f.manifest}.${id}.packet`,'changed');
    const result=await f.apply();
    expect(result.exit).not.toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe('claim_adoption_source_changed');
    expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(1);
    expect(await readFile(f.statePath)).toEqual(f.original);
  });
  it('refuses adoption by a different current actor',async () => {
    const f=await interrupted();
    f.change((body,url)=> {if(url.pathname.endsWith('/runs/'+f.source.scope.run_id))body.meta.actor_user_id=uuid(901);return body;});
    expect((await f.adopt()).exit).not.toBe(0);
    expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(1);
    expect(await readFile(f.statePath)).toEqual(f.original);
  });
  it.each(['original-field','other-member','projection-actor','artifact-url'])('refuses %s drift while adopting the exact owned split',async kind=>{
    const f=await interrupted();
    f.change((body,url)=>{
      if(url.pathname.endsWith('/runs/'+f.source.scope.run_id)) {
        if(kind==='original-field') body.data.findings[0].title='Changed original title';
        if(kind==='other-member') body.data.findings[1].claim_identity=f.selection.identity;
        if(kind==='projection-actor') body.data.findings[0].identity_provenance.actor_user_id=uuid(999);
        if(kind==='artifact-url') body.data.artifacts[0].url='https://other.example/original';
      }
      return body;
    });
    const result=await f.adopt();
    expect(result.exit).not.toBe(0);
    expect(f.calls.filter(c=>c.method==='POST')).toHaveLength(1);
    expect(await readFile(f.statePath)).toEqual(f.original);
    expect(await readFile(f.manifest,'utf8')).toBe(f.oldManifest);
    expect((await readdir(f.root+'/operation')).some(name=>name.startsWith('adopted.json'))).toBe(false);
  });

});
