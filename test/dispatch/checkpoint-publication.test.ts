import { minimalCheckpointCapture } from './checkpoint-capture-fixture.js';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, lstat, link, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { initializeAsyncPhase, readAsyncPhase } from '../../src/dispatch/checkpoint-async-store.js';
import { planGating } from '../../src/consensus/gating.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';
import { sha256Hex, stableStringify } from '../../src/report/run-header.js';

const faults = vi.hoisted(() => ({ partial: '', directory: false, initializationAck: '' }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (faults.directory && String(args[0]).includes('async') && String(args[0]).endsWith('/events')) {
        faults.directory = false;
        throw Object.assign(new Error('interrupted async preparation'), { code: 'ENOSPC' });
      }
      return fs.mkdir(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (faults.initializationAck === String(args[0])) {
          const published = await fs.lstat(join(String(args[0]), 'async', 'phase.json')).then(() => true, () => false);
          if (published) { faults.initializationAck = ''; throw Object.assign(new Error('lost initialization acknowledgement'), {code:'EIO'}); }
        }
        return sync();
      };
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        const bytes = String(writeArgs[0]);
        if (faults.partial && bytes.includes(faults.partial)) {
          faults.partial = '';
          await write(bytes.slice(0, 17));
          throw Object.assign(new Error('interrupted immutable publication'), { code: 'ENOSPC' });
        }
        return write(...writeArgs);
      };
      return handle;
    },
  };
});
const roots: string[] = [];
afterEach(async () => { faults.partial = ''; faults.directory = false; faults.initializationAck = ''; await Promise.all(roots.splice(0).map(path => rm(path, {recursive:true,force:true}))); });
const target = 'fixture#105', namespace = 'publication';
const runId = '11111111-1111-4111-8111-111111111111';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const prompts = { systemPrompt: 'async system', userPrompt: 'async user' };
function planInput() {
  const findings: ConsensusFinding[] = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', title: `claim ${i}`, description: 'guard missing',
    consensus: { score: 1, total: 3, models: ['m1'], roles: ['general'], crossRole: false, crossModel: false, elevated: false, elevation: 'none', confidence: 0.5, confidenceLabel: 'Medium', tier: 'single' } }));
  const plan = planGating(findings, { minModels: 2, verificationModel: 'openai/verifier', verificationTimeoutMs: 100, verificationPassTimeoutMs: 600,
    diffFiles: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+guard();', language: 'ts' }] });
  return { runId, gatingPlanBytes: stableStringify(plan), model: plan.model, provider: 'openai', batches: plan.batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })),
    startedAtMs: 200, expiresAtMs: 800, verificationTimeoutMs: plan.verificationTimeoutMs, verificationPassTimeoutMs: plan.verificationPassTimeoutMs, maxPhysicalCalls: 2 };
}

async function asyncFixture(cap = 3, systemPrompt = prompts.systemPrompt) {
 const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'async-phase-'))); roots.push(commonDir);
 const configBytes = '{}', toolsBytes = stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } });
 const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: sha256Hex('[]'), configSha256: sha256Hex(configBytes), specSha256: sha256Hex(''), contextSha256: sha256Hex('[]'), toolsSha256: sha256Hex(toolsBytes), parser: { name: 'findings-json', version: 1 }, roster: ['a','b'].map(seat => ({seat, model: seat, role: 'general', route: 'fake'})), chunks: [{index:0,total:1,digest:sha256Hex('chunk')}], prompts: ['a','b'].map(seat=>({seat,chunk:0,systemSha256:sha256Hex('s'),userSha256:sha256Hex('u')})) });
 const role = { name:'general',systemPrompt:'s',focus:[],description:'d',isSpecialized:false };
 const captured = captureReviewerInputs({ plan, policy:{version:1,fraction:2/3},patchBytes:'[]',configBytes,specBytes:'',contextBytes:'[]',toolsBytes,chunkBytes:['chunk'],assignments:plan.cells.map(c=>({model:c.model,provider:c.route,role})),prompts:plan.cells.map(()=>({systemPrompt:'s',userPrompt:'u'})), async: { timeoutMs: 1000, maxPhysicalCalls: cap, maxAttemptsPerCall: 2, calls: ['assignment-a','assignment-b'].map(assignmentId=>({assignmentId,chunk:0,assignment:{model:'async-model',provider:'fake',role},prompt:{...prompts,systemPrompt}})) } });
 const now = Date.now(); const launch = createOriginalLaunch({runId,target,planDigest:plan.digest,capturedInputsSha256:captured.digest,originalNativeClaim:{attempt:3,round:2},startedAtMs:now-10,expiresAtMs:now+60_000,maxPhysicalCalls:2,maxAttemptsPerCell:1});
 let journal!: CheckpointJournal;
 await withNativeTarget(commonDir,target,async ownership=>{journal=await CheckpointJournal.create({commonDir,namespace:runId,plan,ownership});await journal.bind('captured-inputs',captured.bytes,ownership);await journal.bind('launch',encodeOriginalLaunch(launch),ownership);});
 const calls = ['assignment-a','assignment-b'].map(assignment=>({id:`${assignment}:0`,assignment,chunk:0,chunkSha256:plan.chunks[0]!.digest,model:'async-model',role:'general',provider:'fake',systemPromptSha256:sha256Hex(systemPrompt),userPromptSha256:sha256Hex(prompts.userPrompt)}));
 const input = {commonDir,namespace:runId,plan,calls,maxPhysicalCalls:cap,maxAttemptsPerCall:2,expiresAtMs:launch.expiresAtMs};
 return {commonDir,plan,journal,launch,captured,input,path:checkpointPath(commonDir,target,runId)};
}
const intent = {batchIndex:0,attemptId:'verifier-0',startedAtMs:210};
const answer = JSON.stringify({model:'openai/verifier',provider:'openai',status:'success',text:'[]',durationMs:1});
const outcome = {batchIndex:0,attemptId:'verifier-0',finishedAtMs:300,answerBytes:answer};
const review = (status='success') => JSON.stringify({model:'openai/reviewer',role:'general',provider:'openai',status,durationMs:1,findings:[]});
function basicInput() {
  return {target,headSha:'a'.repeat(40),mergeBaseSha:'b'.repeat(40),patchSha256:'c'.repeat(64),configSha256:'d'.repeat(64),specSha256:'e'.repeat(64),contextSha256:'3'.repeat(64),toolsSha256:'4'.repeat(64),parser:{name:'findings-json',version:1},roster:[{seat:'general',model:'openai/reviewer',role:'general',route:'openai'}],chunks:[{index:0,total:1,digest:hash('chunk')}],prompts:[{seat:'general',chunk:0,systemSha256:hash('system'),userSha256:hash('user')}]};
}
async function fixture(sealed=true) {
  const commonDir=await realpath(await mkdtemp(join(tmpdir(),'rcl-publication-')));roots.push(commonDir);
  const captured=minimalCheckpointCapture(basicInput()),plan=captured.plan,launch=createOriginalLaunch({runId,target,planDigest:plan.digest,capturedInputsSha256:captured.digest,originalNativeClaim:{round:1,attempt:1},startedAtMs:100,expiresAtMs:1000,maxPhysicalCalls:2,maxAttemptsPerCell:2});let journal!:CheckpointJournal;
  await withNativeTarget(commonDir,target,async ownership=>{
    journal=await CheckpointJournal.create({commonDir,namespace,plan,ownership});
    await journal.bind('captured-inputs',captured.bytes,ownership);await journal.bind('launch',encodeOriginalLaunch(launch),ownership);
    await journal.recordIntent('general:0',{id:'reviewer-0',kind:'unknown'},ownership);
    if(sealed)await journal.finalize(ownership);
  });
  return {commonDir,plan,journal,path:checkpointPath(commonDir,target,namespace)};
}
const owned = <T>(f:{commonDir:string},work:Parameters<typeof withNativeTarget<T>>[2])=>withNativeTarget(f.commonDir,target,work);

async function interruptLinkedChild(f:Pick<Awaited<ReturnType<typeof fixture>>, 'commonDir' | 'plan'>,late:boolean,initialPlan=false) {
  const script=join(f.commonDir,'interrupt.mjs'),input=join(f.commonDir,'input.json');
  const checkpoint=fileURLToPath(new URL('../../src/dispatch/checkpoint.ts',import.meta.url));
  const ownership=fileURLToPath(new URL('../../src/converge/target-ownership.ts',import.meta.url));
  const loader=fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url));
  await writeFile(input,JSON.stringify({commonDir:f.commonDir,plan:f.plan,namespace,planInput:planInput(),outcome,late,initialPlan}),{mode:0o600});
  await writeFile(script,`
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {CheckpointJournal} from ${JSON.stringify(checkpoint)};
import {withNativeTarget} from ${JSON.stringify(ownership)};
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const link=fs.link;
fs.link=async(from,to)=>{await link(from,to);if(input.initialPlan?String(to).endsWith('/plan.json'):String(to).includes(input.late?'verification-late-audit/events':'verification/events')){process.send({event:'linked',pid:process.pid,from,to});await new Promise(()=>{});}};
syncBuiltinESMExports();
await withNativeTarget(input.commonDir,input.plan.target,async owner=>{if(input.initialPlan){await CheckpointJournal.create({...input,ownership:owner});return;}const journal=await CheckpointJournal.openWrite({...input,ownership:owner});if(input.late)await journal.recordLateVerificationResult(input.outcome,owner);else await journal.beginVerification(input.planInput,owner);});
`,{mode:0o600});
  const child=fork(script,[input],{execArgv:['--import',loader],env:{PATH:process.env.PATH!,LANG:'en_US.UTF-8'},stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
  const exit=once(child,'exit');
  try {
    const message=await Promise.race([once(child,'message'),exit.then(result=>{throw new Error(`child exited before link: ${JSON.stringify(result)} ${stderr}`);}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('child link timeout')),15_000).unref())]);
    const linked=message[0] as {event:string;pid:number;from:string;to:string};expect(linked.event).toBe('linked');
    expect((await lstat(linked.to)).nlink).toBe(2);
    child.kill('SIGKILL');const terminal=await exit;expect(terminal).toEqual([null,'SIGKILL']);
    // The retained test log records the actual child handle and observed terminal.
    console.info(JSON.stringify({publicationChild:linked.pid,exitCode:terminal[0],signal:terminal[1],late}));
    return linked;
  } finally { if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;} }
}

describe('checkpoint interruption recovery',()=>{
  it.each([false,true])('recovers a killed publisher only under ownership (late verifier=%s)',async late=>{
    const f=await fixture();
    if(late)await owned(f,async o=>{await f.journal.beginVerification(planInput(),o);await f.journal.recordVerificationIntent(intent,o);await f.journal.finalizeVerification({status:'failed',finishedAtMs:800,reason:'lost outcome'},o);});
    const main=await f.journal.exportProof(),linked=await interruptLinkedChild(f,late),bytes=await readFile(linked.to);
    const read=()=>late?f.journal.readLateVerificationAudit():f.journal.readVerification();
    await expect(read()).rejects.toThrow('checkpoint_symlink');expect((await lstat(linked.to)).nlink).toBe(2);
    await owned(f,async o=>{const writer=await CheckpointJournal.openWrite({...f,namespace,ownership:o});if(late)await writer.recordLateVerificationResult(outcome,o);else await writer.beginVerification(planInput(),o);});
    expect(await readFile(linked.to)).toEqual(bytes);expect((await lstat(linked.to)).nlink).toBe(1);await expect(lstat(linked.from)).rejects.toMatchObject({code:'ENOENT'});
    if(late)expect(await f.journal.readLateVerificationAudit()).toHaveLength(1);else expect((await f.journal.readVerification())!.records).toHaveLength(1);
    expect(await f.journal.exportProof()).toEqual(main);
  },25_000);
  it('refuses a changed interrupted publication without deleting its staging evidence',async()=>{
    const f=await fixture(),linked=await interruptLinkedChild(f,false);
    const bytes=await readFile(linked.to,'utf8');await writeFile(linked.to,bytes.replace('openai/verifier','openai/tampered'));
    await expect(owned(f,o=>f.journal.beginVerification(planInput(),o))).rejects.toThrow('checkpoint_symlink');
    expect((await lstat(linked.from)).nlink).toBe(2);expect(await readFile(linked.to,'utf8')).toContain('openai/tampered');
  },25_000);
  it('continues to refuse an unrelated verifier hardlink without deleting it',async()=>{
    const f=await fixture();await owned(f,o=>f.journal.beginVerification(planInput(),o));
    const event=join(f.path,'verification','events','00000001.json'),alias=join(f.commonDir,'foreign-link');await link(event,alias);
    await expect(owned(f,o=>f.journal.beginVerification(planInput(),o))).rejects.toThrow('checkpoint_symlink');expect((await lstat(alias)).nlink).toBe(2);
  });
  it('does not expose a partial plan and permits identical creation after a failed write',async()=>{
    const commonDir=await realpath(await mkdtemp(join(tmpdir(),'rcl-plan-publication-')));roots.push(commonDir);
    const plan=freezeCheckpointPlan(basicInput()),path=checkpointPath(commonDir,target,namespace);faults.partial='"headSha"';
    const create=()=>withNativeTarget(commonDir,target,ownership=>CheckpointJournal.create({commonDir,namespace,plan,ownership}));
    await expect(create()).rejects.toMatchObject({code:'ENOSPC'});await expect(lstat(join(path,'plan.json'))).rejects.toMatchObject({code:'ENOENT'});
    const writer=await create();expect(await (await CheckpointJournal.openRead(path,plan)).read()).toEqual(await writer.read());
  });
  it('reopens a plan published before interruption without changing its bytes',async()=>{
    const commonDir=await realpath(await mkdtemp(join(tmpdir(),'rcl-plan-link-')));roots.push(commonDir);
    const plan=freezeCheckpointPlan(basicInput()),path=checkpointPath(commonDir,target,namespace);
    const linked=await interruptLinkedChild({commonDir,plan},false,true),bytes=await readFile(linked.to);
    const reader=await CheckpointJournal.openRead(path,plan);expect((await reader.read()).records).toEqual([]);
    expect((await lstat(linked.to)).nlink).toBe(2);
    const writer=await withNativeTarget(commonDir,target,ownership=>CheckpointJournal.openWrite({commonDir,namespace,plan,ownership}));
    expect((await writer.read()).records).toEqual([]);expect(await readFile(linked.to)).toEqual(bytes);
    expect((await lstat(linked.to)).nlink).toBe(1);await expect(lstat(linked.from)).rejects.toMatchObject({code:'ENOENT'});
  },25_000);
  it('refuses a pre-existing partial plan without replacing its evidence',async()=>{
    const f=await fixture(false),path=join(f.path,'plan.json');await writeFile(path,'{');
    await expect(owned(f,ownership=>CheckpointJournal.create({...f,namespace,ownership}))).rejects.toMatchObject({code:'EEXIST'});
    await expect(owned(f,ownership=>CheckpointJournal.openWrite({...f,namespace,ownership}))).rejects.toThrow('checkpoint_invalid_plan');
    expect(await readFile(path,'utf8')).toBe('{');
  });
  it('does not expose a partial binding and retries without changing retained bytes',async()=>{
    const commonDir=await realpath(await mkdtemp(join(tmpdir(),'rcl-binding-publication-')));roots.push(commonDir);
    const plan=freezeCheckpointPlan(basicInput());let journal!:CheckpointJournal;
    await withNativeTarget(commonDir,target,async ownership=>{journal=await CheckpointJournal.create({commonDir,namespace,plan,ownership});});
    const bytes='exact binding payload with retained provenance';faults.partial=bytes;
    const bind=()=>withNativeTarget(commonDir,target,ownership=>journal.bind('source',bytes,ownership));
    await expect(bind()).rejects.toMatchObject({code:'ENOSPC'});expect(await journal.readBindings()).toEqual({});
    await bind();await bind();expect(await journal.readBindings()).toEqual({source:bytes});expect((await journal.read()).records).toHaveLength(1);
  });
  it('does not strand a paid intent on partial result publication',async()=>{
    const f=await fixture(false),attempt={id:'reviewer-0',kind:'unknown' as const},bytes=review('error');faults.partial=bytes;
    const write=()=>owned(f,o=>f.journal.recordResult('general:0',attempt,{kind:'failure',chunk:0,reviewBytes:bytes,possiblyBilled:true},o));
    await expect(write()).rejects.toMatchObject({code:'ENOSPC'});expect((await f.journal.read()).uncertain).toEqual([{cell:'general:0',paidAttempt:attempt}]);
    expect(await readdir(join(f.path,'results'))).toEqual([]);
    await write();await write();const state=await f.journal.read();expect(state.uncertain).toEqual([]);expect(state.outcomes).toHaveLength(1);expect(state.outcomes[0]!.result.reviewBytes).toBe(bytes);
  });
  it('does not publish a partial reviewer late-audit record and retries exact bytes',async()=>{
    const f=await fixture(),proof=await f.journal.exportProof();faults.partial='"type":"late-result"';
    const write=()=>owned(f,o=>f.journal.recordLateResult('general:0',{id:'reviewer-0',kind:'unknown'},review(),o));
    await expect(write()).rejects.toMatchObject({code:'ENOSPC'});expect(await f.journal.readLateAudit()).toEqual([]);
    await write();await write();expect((await f.journal.readLateAudit()).map(r=>r.reviewBytes)).toEqual([review()]);expect(await f.journal.exportProof()).toEqual(proof);
  });
  it.each(['report','artifact','manifest'])('does not expose partial terminal %s bytes',async part=>{
    const f=await fixture(),proof=await f.journal.exportProof(),payload={reportBytes:'report bytes that must stay exact',reviewerArtifactBytes:'artifact bytes that must stay exact'};
    faults.partial=part==='report'?payload.reportBytes:part==='artifact'?payload.reviewerArtifactBytes:'"reportByteLength"';
    const write=()=>owned(f,o=>f.journal.retainTerminalReport(payload,o));await expect(write()).rejects.toMatchObject({code:'ENOSPC'});
    const paths=await readdir(join(f.path,'terminal-report'));expect(paths).not.toContain(part==='report'?'report.json':part==='artifact'?'reviewer-artifact.json':'manifest.json');
    await write();await write();expect(await f.journal.readTerminalReport()).toMatchObject(payload);expect(await f.journal.exportProof()).toEqual(proof);
  });
  it.each(['empty','nonempty','symlink','malformed'])('does not replace a pre-existing %s async path',async kind=>{
    const f=await asyncFixture(),path=join(f.path,'async');
    if(kind==='symlink')await symlink(f.commonDir,path);
    else {await mkdir(path,{mode:0o700});if(kind!=='empty')await writeFile(join(path,kind==='malformed'?'phase.json':'retained'),'{',{mode:0o600});}
    const before=await lstat(path);
    await expect(owned(f,o=>initializeAsyncPhase({...f.input,ownership:o}))).rejects.toThrow('checkpoint_async_already_initialized');
    const after=await lstat(path);expect(after.ino).toBe(before.ino);expect(after.isSymbolicLink()).toBe(before.isSymbolicLink());
    if(kind!=='symlink')expect(await readdir(path)).toEqual(kind==='empty'?[]:[kind==='malformed'?'phase.json':'retained']);
  });
  it('never reissues grants after complete async publication loses its acknowledgement',async()=>{
    const f=await asyncFixture();faults.initializationAck=f.path;
    await expect(owned(f,o=>initializeAsyncPhase({...f.input,ownership:o}))).rejects.toMatchObject({code:'EIO'});
    const metadata=await readFile(join(f.path,'async','phase.json'));
    await expect(owned(f,o=>initializeAsyncPhase({...f.input,ownership:o}))).rejects.toThrow('checkpoint_async_already_initialized');
    await owned(f,o=>f.journal.finalize(o));expect((await f.journal.read()).finalized).toBe(true);
    expect(await readFile(join(f.path,'async','phase.json'))).toEqual(metadata);expect((await readAsyncPhase(f.input)).state.intents).toEqual([]);
  });
  it('keeps interrupted async preparation unpublished so retry and main finalization work',async()=>{
    const f=await asyncFixture();faults.directory=true;
    await expect(owned(f,o=>initializeAsyncPhase({...f.input,ownership:o}))).rejects.toMatchObject({code:'ENOSPC'});
    expect(await readdir(f.path)).not.toContain('async');
    const opened=await owned(f,o=>initializeAsyncPhase({...f.input,ownership:o}));expect(opened.delegates).toHaveLength(2);
    await expect(owned(f,o=>initializeAsyncPhase({...f.input,ownership:o}))).rejects.toThrow('already_initialized');
    await owned(f,o=>f.journal.finalize(o));expect((await f.journal.read()).finalized).toBe(true);expect((await readAsyncPhase(f.input)).state.intents).toEqual([]);
  });
});
describe('checkpoint immutable input and replay boundaries',()=>{
  it.each(['parser','roster','chunks','prompts'] as const)('rejects unknown nested %s fields before persistence',field=>{
    const input=basicInput();const nested=field==='parser'?input.parser:input[field][0]!;Object.assign(nested,{unknown:true});
    expect(()=>freezeCheckpointPlan(input)).toThrow('checkpoint_invalid_plan');
  });
  it('replays exact failure A after success B without admitting changes or new work',async()=>{
    const f=await fixture(false),a={id:'reviewer-0',kind:'unknown' as const},b={id:'reviewer-1',kind:'paid' as const},failure={kind:'failure' as const,chunk:0,reviewBytes:review('error'),possiblyBilled:true};
    await owned(f,async o=>{await f.journal.recordResult('general:0',a,failure,o);await f.journal.recordIntent('general:0',b,o);await f.journal.recordResult('general:0',b,{kind:'success',chunk:0,reviewBytes:review()},o);});
    const before=await f.journal.read();
    await owned(f,async o=>{const writer=await CheckpointJournal.openWrite({...f,namespace,ownership:o});await writer.recordResult('general:0',a,failure,o);});expect(await f.journal.read()).toEqual(before);
    await expect(owned(f,o=>f.journal.recordResult('general:0',a,{...failure,possiblyBilled:false},o))).rejects.toThrow('checkpoint_terminal_result_exists');
    await expect(owned(f,o=>f.journal.recordResult('general:0',b,{kind:'success',chunk:0,reviewBytes:review().replace('\"durationMs\":1','\"durationMs\":2')},o))).rejects.toThrow('checkpoint_terminal_result_exists');
    await expect(owned(f,o=>f.journal.recordIntent('general:0',{id:'new',kind:'paid'},o))).rejects.toThrow('checkpoint_success_immutable');
    expect(await f.journal.read()).toEqual(before);
  });
});
