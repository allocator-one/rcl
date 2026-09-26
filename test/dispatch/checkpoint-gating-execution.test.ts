import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckpointJournal, exportCheckpointProof, freezeCheckpointPlan, type CheckpointProof } from '../../src/dispatch/checkpoint.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { captureAggregationInputs, AGGREGATION_ALGORITHM } from '../../src/report/aggregation-inputs.js';
import { projectCheckpointReport } from '../../src/report/checkpoint-projection.js';
import { deriveCheckpointConsensus, type CheckpointAssemblyInput } from '../../src/report/checkpoint-assembly.js';
import { captureSupplementalAsync } from '../../src/report/supplemental-async.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { planGating } from '../../src/consensus/gating.js';
import { deriveCheckpointGating } from '../../src/report/checkpoint-gating.js';
import { executeCheckpointGating } from '../../src/dispatch/checkpoint-gating-execution.js';

const roots: string[] = []; afterEach(async () => { await Promise.all(roots.splice(0).map(x => rm(x,{recursive:true,force:true}))); });
const target='allocator-one/rcl#105', runId='11111111-1111-4111-8111-111111111111', hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const role={name:'general',systemPrompt:'s',description:'d',focus:[],isSpecialized:false};
const thresholds={minConsensusScore:0,minConfidence:0,dedupeLineWindow:5,jaccardThreshold:0.3};
function finding(file='a.ts'){return {id:'f',file,startLine:1,endLine:1,severity:'important' as const,category:'correctness',title:'guard missing',description:'guard missing'};}
async function fixture(opts:{mode?:'verified-consensus'|'all-findings'; both?:boolean; second?:boolean; file?:string; asyncLaunched?:number; id?:string; minScore?:number; unknownSecond?:boolean; seats?:number; minConfidence?:number}={}) {
 const fixtureRunId=opts.id??runId;
 const localThresholds={...thresholds,minConsensusScore:opts.minScore??thresholds.minConsensusScore,minConfidence:opts.minConfidence??thresholds.minConfidence};
 const seats=opts.seats??2;
 const dir=await realpath(await mkdtemp(join(tmpdir(),'cgating-')));roots.push(dir); const diff:any={source:'local',files:[{filename:'a.ts',status:'modified',patch:'@@ -1 +1 @@\n-x\n+y',additions:1,deletions:1,language:'ts'}]};
 const config:any={quorumFraction:1,thresholds:localThresholds,output:{belowThresholdAppendix:true}}; const tools=stableStringify({parser:{name:'findings-json',version:1},aggregation:AGGREGATION_ALGORITHM});
 const plan=freezeCheckpointPlan({target,headSha:'a'.repeat(40),mergeBaseSha:'b'.repeat(40),patchSha256:diffDigest(diff.files),configSha256:configDigest(config),specSha256:hash('spec'),contextSha256:hash('[]'),toolsSha256:hash(tools),parser:{name:'findings-json',version:1},roster:Array.from({length:seats},(_,i)=>({seat:`s${i}`,model:`m${i}`,role:'general',route:'openai'})),chunks:[{index:0,total:1,digest:hash('chunk')}],prompts:Array.from({length:seats},(_,i)=>({seat:`s${i}`,chunk:0,systemSha256:hash('s'),userSha256:hash('u')}))});
 const aggregation=captureAggregationInputs({algorithm:AGGREGATION_ALGORITHM,diffSha256:plan.patchSha256,roleMap:new Map([['general',role]]),thresholds:localThresholds,gating:{mode:opts.mode??'verified-consensus',minModels:2,verificationModel:'openai/verifier',verificationTimeoutMs:100,verificationPassTimeoutMs:500},modelWeights:new Map(Array.from({length:seats},(_,i)=>[`m${i}`,1])),belowThresholdAppendix:true});
 const captured=captureReviewerInputs({plan,policy:{version:1,fraction:1},patchBytes:stableStringify(diff.files.map((f:any)=>({filename:f.filename,status:f.status,previousFilename:null,patch:f.patch,additions:f.additions,deletions:f.deletions,blobSha:null}))),configBytes:stableStringify(config),specBytes:'spec',contextBytes:'[]',toolsBytes:tools,chunkBytes:['chunk'],assignments:plan.cells.map(c=>({model:c.model,provider:c.route,role})),prompts:plan.cells.map(()=>({systemPrompt:'s',userPrompt:'u'})),aggregation});
 let journal!:CheckpointJournal; let proof!:CheckpointProof;
 await withNativeTarget(dir,target,async owner=>{journal=await CheckpointJournal.create({commonDir:dir,namespace:'run',plan,ownership:owner}); await journal.bind('captured-inputs',captured.bytes,owner); await journal.bind('launch',encodeOriginalLaunch(createOriginalLaunch({runId:fixtureRunId,target,originalNativeClaim:{attempt:1,round:1},capturedInputsSha256:hash(captured.bytes),planDigest:plan.digest,startedAtMs:1,expiresAtMs:1000,maxPhysicalCalls:4,maxAttemptsPerCell:1})),owner); for(const i of Array.from({length:seats},(_,i)=>i)) {if(opts.second===false&&i===1) continue;const review={model:`m${i}`,role:'general',provider:'openai',status:'success' as const,durationMs:1,findings:i===0?[finding(opts.file),...(opts.both?[{...finding('b.ts'),id:'dropped',severity:'minor' as const,title:'other guard',description:'other guard',startLine:5,endLine:5}]:[])]:opts.both?[finding(opts.file),{...finding('b.ts'),id:'dropped',severity:'minor' as const,title:'other guard',description:'other guard',startLine:5,endLine:5}]:[]};const paidAttempt={id:`r${i}`,kind:(opts.unknownSecond&&i===1?'unknown':'paid')} as const;await journal.recordIntent(`s${i}:0`,paidAttempt,owner);if(!(opts.unknownSecond&&i===1))await journal.recordResult(`s${i}:0`,paidAttempt,{kind:'success',chunk:0,reviewBytes:JSON.stringify(review)},owner);} await journal.finalize(owner);proof=await exportCheckpointProof(journal);});
 const assembly:CheckpointAssemblyInput={projection:projectCheckpointReport({sources:[],successor:{runId:fixtureRunId,proof},policy:{version:1,fraction:1}}),supplementalAsync:captureSupplementalAsync([],opts.asyncLaunched??0),diff,startTime:1,run:{id:fixtureRunId,rclVersion:'x',command:'review',target:{kind:'pr',repo:'allocator-one/rcl',prNumber:105,headSha:plan.headSha},roster:plan.roster.map(s=>({model:s.model,role:s.role,provider:s.route,lane:'blocking' as const})),spec:{source:'flag',sha256:plan.specSha256},contextFiles:[],runner:{kind:'agent'},startedAt:new Date(1),converge:{target,attempt:1,round:1}}};
 return {dir,journal,assembly,plan,captured,proof};
}

async function execute(f: Awaited<ReturnType<typeof fixture>>, overrides: Record<string, unknown> = {}) {
  return withNativeTarget(f.dir, target, ownership => executeCheckpointGating({
    assembly: f.assembly, commonDir: f.dir, ownership, journal: f.journal,
    askFactory: () => async () => ({ model: 'openai/verifier', provider: 'openai', status: 'success' as const,
      text: '[{"id":"F1","verdict":"confirmed"}]', durationMs: 1 }),
    beforeLaunch: async () => {}, onLateAuditError: () => {}, nowMs: () => 10, monotonicNow: () => 0,
    ...overrides,
  }));
}
describe('retained checkpoint verifier integration', () => {
  it('journals a real verifier answer before report replay and resumes with zero calls', async () => {
    const f = await fixture();
    const ask = vi.fn(async () => {
      expect((await f.journal.readVerification())!.intents).toHaveLength(1);
      return {model:'openai/verifier',provider:'openai',status:'success' as const,text:'[{"id":"F1","verdict":"confirmed"}]',durationMs:1};
    });
    const first = await execute(f, {askFactory: () => ask});
    expect(first.projection.disposition).toBe('replayed');
    expect(first.projection.findings[0]!.gating?.reason).toBe('verified');
    expect(first.newPhysicalCalls).toBe(1);
    const factory = vi.fn(() => ask);
    const resumed = await execute(f, {askFactory:factory,nowMs:()=>99999});
    expect(resumed.verificationProof).toEqual(first.verificationProof);
    expect(resumed.newPhysicalCalls).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });
  it('seals strict fallback when the original lifetime has expired without constructing a provider', async () => {
    const f=await fixture(), factory=vi.fn();
    const result=await execute(f,{askFactory:factory,nowMs:()=>99999});
    expect(result.projection.disposition).toBe('strict_fallback');
    expect(result.projection.findings[0]!.gating).toBeUndefined();
    expect(result.newPhysicalCalls).toBe(0);expect(factory).not.toHaveBeenCalled();
    const phase=(await f.journal.readVerification())!;
    expect(phase.plan.expiresAtMs).toBe(1000);expect(phase.terminal!.status).toBe('failed');
  });
  it('keeps deterministic and plain paths provider-free and refuses the wrong journal', async () => {
    const plain=await fixture({mode:'all-findings'}), factory=vi.fn();
    expect((await execute(plain,{askFactory:factory})).projection.disposition).toBe('plain');
    const deterministic=await fixture({both:true});
    expect((await execute(deterministic,{askFactory:factory})).projection.disposition).toBe('deterministic');
    const other=await fixture({id:'22222222-2222-4222-8222-222222222222'});
    await expect(execute(plain,{journal:other.journal,askFactory:factory})).rejects.toThrow('checkpoint_gating_execution_journal_mismatch');
    expect(factory).not.toHaveBeenCalled();
  });
  it('seals zero-cap fallback before a provider when current reviewer and async calls fill the run budget',async()=>{
    const f=await fixture({asyncLaunched:498}),factory=vi.fn();
    const result=await execute(f,{askFactory:factory});
    expect(result.projection.disposition).toBe('strict_fallback');
    expect((await f.journal.readVerification())!.plan.maxPhysicalCalls).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });
  it('retains cancellation as a failed phase without inventing an answer',async()=>{
    const f=await fixture(),controller=new AbortController(),factory=vi.fn();controller.abort();
    const result=await execute(f,{askFactory:factory,signal:controller.signal});
    expect(result.projection.disposition).toBe('strict_fallback');
    expect((await f.journal.readVerification())!.outcomes).toEqual([]);expect(factory).not.toHaveBeenCalled();
  });
});
