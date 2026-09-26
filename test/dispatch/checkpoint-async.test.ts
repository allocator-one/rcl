import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { initializeAsyncPhase, openAsyncDelegate, sealAsyncPhase, readAsyncPhase, readAsyncLateAudit } from '../../src/dispatch/checkpoint-async-store.js';
import { decodeAsyncProof } from '../../src/dispatch/checkpoint-async.js';
const durability = vi.hoisted(() => ({failPath:'',synced:[] as string[]}));
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,open:async(...args:Parameters<typeof fs.open>)=>{const h=await fs.open(...args),sync=h.sync.bind(h);h.sync=async()=>{const path=String(args[0]);durability.synced.push(path);if(path===durability.failPath){durability.failPath='';throw Object.assign(new Error('synthetic fsync failure'),{code:'EIO'});}return sync();};return h;}};});
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); durability.failPath=''; durability.synced=[]; await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const target = 'fixture#105', runId = '11111111-1111-4111-8111-111111111111';
const prompts = { systemPrompt: 'async system', userPrompt: 'async user' };
const review = (status = 'success', extra = {}) => JSON.stringify({ model: 'async-model', role: 'general', provider: 'fake', async: true, status, findings: [{ id: 'same', file: 'a.ts', startLine: 1, endLine: 1, severity: 'critical', category: 'security', title: 'keep', description: 'raw finding' }], durationMs: 9, usage: { inputTokens: 3, outputTokens: 2 }, ...extra }, null, 2) + '\n';
async function fixture() {
 const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'async-phase-'))); roots.push(commonDir);
 const configBytes = '{}', toolsBytes = stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } });
 const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: sha256Hex('[]'), configSha256: sha256Hex(configBytes), specSha256: sha256Hex(''), contextSha256: sha256Hex('[]'), toolsSha256: sha256Hex(toolsBytes), parser: { name: 'findings-json', version: 1 }, roster: ['a','b'].map(seat => ({seat, model: seat, role: 'general', route: 'fake'})), chunks: [{index:0,total:1,digest:sha256Hex('chunk')}], prompts: ['a','b'].map(seat=>({seat,chunk:0,systemSha256:sha256Hex('s'),userSha256:sha256Hex('u')})) });
 const role = { name:'general',systemPrompt:'s',focus:[],description:'d',isSpecialized:false };
 const captured = captureReviewerInputs({ plan, policy:{version:1,fraction:2/3},patchBytes:'[]',configBytes,specBytes:'',contextBytes:'[]',toolsBytes,chunkBytes:['chunk'],assignments:plan.cells.map(c=>({model:c.model,provider:c.route,role})),prompts:plan.cells.map(()=>({systemPrompt:'s',userPrompt:'u'})) });
 const now = Date.now(); const launch = createOriginalLaunch({runId,target,planDigest:plan.digest,capturedInputsSha256:captured.digest,originalNativeClaim:{attempt:3,round:2},startedAtMs:now-10,expiresAtMs:now+60_000,maxPhysicalCalls:2,maxAttemptsPerCell:1});
 let journal!: CheckpointJournal;
 await withNativeTarget(commonDir,target,async ownership=>{journal=await CheckpointJournal.create({commonDir,namespace:runId,plan,ownership});await journal.bind('captured-inputs',captured.bytes,ownership);await journal.bind('launch',encodeOriginalLaunch(launch),ownership);});
 const calls = ['assignment-a','assignment-b'].map(assignment=>({id:`${assignment}:0`,assignment,chunk:0,chunkSha256:plan.chunks[0]!.digest,model:'async-model',role:'general',provider:'fake',systemPromptSha256:sha256Hex(prompts.systemPrompt),userPromptSha256:sha256Hex(prompts.userPrompt)}));
 const input = {commonDir,namespace:runId,plan,calls,maxPhysicalCalls:3,maxAttemptsPerCall:2,expiresAtMs:launch.expiresAtMs};
 return {commonDir,plan,journal,launch,captured,input,path:checkpointPath(commonDir,target,runId)};
}
const initialize = (f: Awaited<ReturnType<typeof fixture>>, overrides = {}) => withNativeTarget(f.commonDir,target,ownership=>initializeAsyncPhase({...f.input,...overrides,ownership}));
const seal = (f: Awaited<ReturnType<typeof fixture>>) => withNativeTarget(f.commonDir,target,ownership=>sealAsyncPhase({...f.input,ownership}));
describe('restricted original async checkpoint phase',()=>{
 it('retains separate duplicate-route calls and exact raw results without changing blocking health/history',async()=>{
  const f=await fixture(), before=await f.journal.read(), opened=await initialize(f);
  const writers=await Promise.all(opened.delegates.map(openAsyncDelegate)); const intents=await Promise.all(writers.map((w:any)=>w.claim(prompts)));
  expect(new Set(intents.map((x:any)=>x.attemptId)).size).toBe(2);
  await writers[1].recordResult(intents[1].attemptId,review(),true); await writers[0].recordResult(intents[0].attemptId,review('error'),true);
  const proof=await seal(f);expect(proof.state.intents).toHaveLength(2);expect(proof.state.outcomes.map((x:any)=>x.callIndex)).toEqual([1,0]);expect(proof.state.outcomes[0].reviewBytes).toBe(review());
  expect(proof.state.uncertain).toEqual([]);expect(await f.journal.read()).toEqual(before);expect(proof.bytes).not.toContain(opened.delegates[0].token);
  expect(decodeAsyncProof(proof.bytes,proof.context)).toEqual(proof);
 });
 it('does not retry a lost outcome or reissue a possibly dispatched intent after reopen',async()=>{
  const f=await fixture(),opened=await initialize(f),w=await openAsyncDelegate(opened.delegates[0]);const first=await w.claim(prompts);expect(first).toBeDefined();
  expect(await (await openAsyncDelegate(JSON.parse(JSON.stringify(opened.delegates[0])))).claim(prompts)).toBeUndefined();
  const proof=await seal(f);expect(proof.state.uncertain).toEqual([first]);expect(proof.physicalAttempts[0]).toMatchObject({outcomeCertainty:'uncertain',possiblyBilled:true,reviewBytes:null,durationMs:null,usage:null});
 });
 it('admits only durable failed-outcome retries and honors one atomic global cap',async()=>{
  const f=await fixture(),opened=await initialize(f,{maxPhysicalCalls:2}),w=await openAsyncDelegate(opened.delegates[0]);const first=await w.claim(prompts);await w.recordResult(first.attemptId,review('timeout'),true);
  const other=await openAsyncDelegate(opened.delegates[1]);const next=await Promise.all([w.claim(prompts),other.claim(prompts)]);expect(next.filter(Boolean)).toHaveLength(1);expect((await readAsyncPhase(f.input)).state.intents).toHaveLength(2);
 });
 it('fences concurrent new intents and retries at immutable seal and preserves late audit only',async()=>{
  const f=await fixture(),opened=await initialize(f),a=await openAsyncDelegate(opened.delegates[0]),b=await openAsyncDelegate(opened.delegates[1]);const first=await a.claim(prompts);
  const [proof]=await Promise.all([seal(f),b.claim(prompts)]);const before=proof.bytes;expect(await a.claim(prompts)).toBeUndefined();expect(await b.claim(prompts)).toBeUndefined();
  expect(await a.recordResult(first.attemptId,review(),true)).toBe('late');expect((await seal(f)).bytes).toBe(before);const audit=await readAsyncLateAudit(f.input);expect(audit).toHaveLength(1);expect(audit[0].result.reviewBytes).toBe(review());
  await a.recordResult(first.attemptId,review(),true);expect(await readAsyncLateAudit(f.input)).toHaveLength(1);
 });
 it('checks expired immutable deadline before intent and never obtains provider work',async()=>{
  const f=await fixture(),opened=await initialize(f),w=await openAsyncDelegate(opened.delegates[0]);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.launch.expiresAtMs);
  const adapter=vi.fn();const intent=await w.claim(prompts);if(intent)adapter();expect(adapter).not.toHaveBeenCalled();expect((await seal(f)).state.intents).toEqual([]);
 });
 it('refuses forged authority, wrong delegate call/token and changed prompts without intents',async()=>{
  const f=await fixture();await expect(initializeAsyncPhase({...f.input,ownership:{target}} as any)).rejects.toThrow('native_target');const opened=await initialize(f);
  await expect(openAsyncDelegate({...opened.delegates[0],token:'0'.repeat(64)})).rejects.toThrow('delegate');await expect(openAsyncDelegate({...opened.delegates[0],callIndex:1})).rejects.toThrow('delegate');
  const w=await openAsyncDelegate(opened.delegates[0]);await expect(w.claim({...prompts,userPrompt:'changed'})).rejects.toThrow('prompt');expect((await readAsyncPhase(f.input)).state.intents).toEqual([]);
 });
 it('refuses wrong route and duplicate conflicting results but exact replay is idempotent',async()=>{
  const f=await fixture(),opened=await initialize(f),w=await openAsyncDelegate(opened.delegates[0]);const intent=await w.claim(prompts);
  await expect(w.recordResult(intent.attemptId,review('success',{provider:'other'}),true)).rejects.toThrow('review');await w.recordResult(intent.attemptId,review(),true);await w.recordResult(intent.attemptId,review(),true);
  await expect(w.recordResult(intent.attemptId,review('error'),true)).rejects.toThrow('conflict');expect((await seal(f)).state.outcomes).toHaveLength(1);
 });
 it('rejects changed context and noncanonical or tampered event bytes on reopen',async()=>{
  const f=await fixture(),opened=await initialize(f),w=await openAsyncDelegate(opened.delegates[0]);await w.claim(prompts);const proof=await seal(f);
  expect(()=>decodeAsyncProof(proof.bytes,{...proof.context,capturedInputsSha256:'0'.repeat(64)})).toThrow();
  const path=join(f.path,'async','events','00000001.json');const bytes=await readFile(path,'utf8');await writeFile(path,bytes+' ',{mode:0o600});await expect(readAsyncPhase(f.input)).rejects.toThrow();
 });
 it('fails closed on truncated publication and does not salvage or dispatch',async()=>{
  const f=await fixture(),opened=await initialize(f);await writeFile(join(f.path,'async','events','00000001.json'),'{',{mode:0o600});await expect(openAsyncDelegate(opened.delegates[0])).rejects.toThrow();
  expect(await readFile(join(f.path,'async','events','00000001.json'),'utf8')).toBe('{');
 });
 it('rejects alias or forged parent paths and freezes caller arrays before awaiting',async()=>{
  const f=await fixture();const calls=structuredClone(f.input.calls);let started!:Promise<any>;await withNativeTarget(f.commonDir,target,async ownership=>{started=initializeAsyncPhase({...f.input,calls,ownership});calls[0].model='changed';await started;});
  expect((await readAsyncPhase(f.input)).plan.calls[0].model).toBe('async-model');
  const alias=join(f.commonDir,'alias');await symlink(f.path,alias);const opened=await started;await expect(openAsyncDelegate({...opened.delegates[0],checkpointPath:alias})).rejects.toThrow();
 });
 it('respects original launch reservations, chunk references and sealing state',async()=>{
  const f=await fixture();await expect(initialize(f,{maxPhysicalCalls:499})).rejects.toThrow('budget');await expect(initialize(f,{expiresAtMs:f.launch.expiresAtMs+1})).rejects.toThrow('deadline');
  await expect(initialize(f,{calls:[{...f.input.calls[0],chunkSha256:'0'.repeat(64)}]})).rejects.toThrow('call');
  await withNativeTarget(f.commonDir,target,owner=>f.journal.finalize(owner));await expect(initialize(f)).rejects.toThrow('closed');expect(await readdir(f.path)).not.toContain('async');
 });
 it('atomically fences delegates when the owning main checkpoint finalizes',async()=>{
  const f=await fixture(),opened=await initialize(f),w=await openAsyncDelegate(opened.delegates[0]);const first=await w.claim(prompts);
  await withNativeTarget(f.commonDir,target,owner=>f.journal.finalize(owner));expect((await readAsyncPhase(f.input)).state.cutoffMs).toBeDefined();expect(await (await openAsyncDelegate(opened.delegates[1])).claim(prompts)).toBeUndefined();
  const main=await f.journal.exportProof();await w.recordResult(first.attemptId,review(),true);expect(await f.journal.exportProof()).toEqual(main);expect(await readAsyncLateAudit(f.input)).toHaveLength(1);
 });
 it('keeps a published intent uncertain when its durability acknowledgement fails',async()=>{
  const f=await fixture(),opened=await initialize(f),w=await openAsyncDelegate(opened.delegates[0]);durability.failPath=join(f.path,'async','events');const adapter=vi.fn();
  await expect(w.claim(prompts).then(intent=>{if(intent)adapter();})).rejects.toMatchObject({code:'EIO'});expect(adapter).not.toHaveBeenCalled();expect(await w.claim(prompts)).toBeUndefined();
  const proof=await seal(f);expect(proof.state.intents).toHaveLength(1);expect(proof.state.uncertain).toHaveLength(1);expect(durability.synced).toContain(join(f.path,'async','events','00000001.json'));
 });
 it('delegates across a real process while native ownership is held and never redispatches a killed worker intent',async()=>{
  const f=await fixture();const worker=join(f.commonDir,'worker.mjs'),reference=join(f.commonDir,'delegate.json');
  const source=fileURLToPath(new URL('../../src/dispatch/checkpoint-async-store.ts',import.meta.url));
  await writeFile(worker,`import {readFile} from 'node:fs/promises'; import {openAsyncDelegate} from ${JSON.stringify(source)}; const w=await openAsyncDelegate(JSON.parse(await readFile(process.argv[2],'utf8'))); const i=await w.claim(${JSON.stringify(prompts)}); console.log(JSON.stringify(i??null)); if(process.argv[3]==='hold')setInterval(()=>{},1000);`,{mode:0o600});
  await withNativeTarget(f.commonDir,target,async ownership=>{
   const opened=await initializeAsyncPhase({...f.input,ownership});await writeFile(reference,JSON.stringify(opened.delegates[0]),{mode:0o600});
   const child=spawn(process.execPath,['--import',fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url)),worker,reference,'hold'],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',x=>stderr+=x);const exit=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));
   const intent=await new Promise<any>((resolve,reject)=>{let data='';child.stdout.on('data',x=>{data+=x;if(data.includes('\n')){try{resolve(JSON.parse(data.trim()));}catch(e){reject(e);}}});child.on('exit',()=>reject(new Error(stderr||'worker exited before durable intent')));});
   try { expect(intent.attemptId).toMatch(/^async-/); } finally { child.kill('SIGKILL'); } expect(await exit).toEqual({code:null,signal:'SIGKILL'});
   const reopened=await promisify(execFile)(process.execPath,['--import',fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url)),worker,reference],{encoding:'utf8'});expect(JSON.parse(reopened.stdout)).toBeNull();
   const proof=await sealAsyncPhase({...f.input,ownership});expect(proof.state.uncertain).toEqual([intent]);
  });
 });

 it('refuses a non-UTF8 prompt scalar that aliases the digest of replacement text',async()=>{
  const f=await fixture();const calls=f.input.calls.map(call=>({...call,systemPromptSha256:sha256Hex('�')}));
  const opened=await initialize(f,{calls}),writer=await openAsyncDelegate(opened.delegates[0]);
  await expect(writer.claim({...prompts,systemPrompt:'\uD800'})).rejects.toThrow('prompt');expect((await readAsyncPhase(f.input)).state.intents).toEqual([]);
 });

});
