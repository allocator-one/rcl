import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convergeRunStatePath, initialConvergeRunState, loadConvergeRunState, writeState } from '../../src/converge/run-state.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { reconcileDeliveredRun, reconcileFlushedRun, shouldReconcileDeliveredRun } from '../../src/converge/delivery-reconciliation.js';
const runId = '019921a0-0000-7000-8000-000000000001', head = 'a'.repeat(40);
const digest = 'c'.repeat(64);

function matchingDetail(target: string) {
  return {
    id: runId,
    provenance: 'live',
    converge: { target, round: 3, attempt: 4 },
    target: { kind: 'pull_request', head_sha: head },
    artifacts: [{ kind: 'report_json', stored: true, declared_sha256: digest }],
    findings: [], calls: [],
  };
}

async function pendingState(dir: string, target: string) {
  const state = initialConvergeRunState(target);
  state.lastLaunch = { status: 'completed', attempt: 4, round: 3, headSha: head, inputSha256: 'b'.repeat(64), startedAt: new Date().toISOString(), pid: process.pid, runId, reportJsonSha256: digest, successfulReviews: 1, totalReviews: 2, deliveryPending: true, hardFailure: true };
  await withNativeTarget(dir, target, owner => writeState(dir, state, owner));
}

async function pendingCycleState(dir: string, target: string) {
  let active: {id:string;operation_id:string;previous_cycle_id:string|null;head_sha:string;inserted_at:string}|null = null;
  const cycleRemote = {repo:'owner/repo',prNumber:17,url:'https://harness.example',
    current:vi.fn(async()=>active),start:vi.fn(async request => {
      active={...request,id:'019921a0-0000-7000-8000-000000000099',inserted_at:new Date().toISOString()};
      return active;
    })};
  const run=vi.fn(async()=>({runId,reportJsonSha256:digest,successfulReviews:1,totalReviews:2,
    deliveryPending:true,hardFailure:true,exitCode:4}));
  await guardReviewLaunch({gitCommonDir:dir,target,headSha:head,inputSha256:'b'.repeat(64),startOver:true,cycleRemote,
    validate:vi.fn(async()=>{}),run});
  const state=(await loadConvergeRunState(dir,target))!;
  return {state,run,detail:{...matchingDetail(target),cycle_id:state.cycle!.id,
    converge:{target,round:state.lastLaunch!.round,attempt:state.lastLaunch!.attempt},
    target:{...matchingDetail(target).target,repo:'owner/repo',pr_number:17}}};
}

async function publishedMarkerState(dir: string, target: string) {
  const fixture=await pendingCycleState(dir,target),state=fixture.state;
  state.lastLaunch={...state.lastLaunch!,deliveryPending:false,deliveryReconciliation:{version:1,runId,
    reportJsonSha256:digest,headSha:head,attempt:state.lastLaunch!.attempt,round:state.lastLaunch!.round}};
  await withNativeTarget(dir,target,owner=>writeState(dir,state,owner));
  return fixture;
}

async function expectUnchanged(mutator: (detail: ReturnType<typeof matchingDetail>) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
  try {
    await pendingState(dir, target);
    const detail = matchingDetail(target);
    mutator(detail);
    const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: detail });
    await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun })).resolves.toBe('unchanged');
    expect((await loadConvergeRunState(dir, target))!.lastLaunch).toMatchObject({ deliveryPending: true, attempt: 4, round: 3, hardFailure: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
describe('reconcileDeliveredRun', () => {
  it('clears only a matching completed pending delivery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
    try {
      await pendingState(dir, target);
      const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: matchingDetail(target) });
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun })).resolves.toBe('reconciled');
      expect((await loadConvergeRunState(dir, target))!.lastLaunch).toMatchObject({ attempt: 4, round: 3,
        deliveryPending: false, hardFailure: true, deliveryReconciliation: { version: 2, runId,
          reportJsonSha256: digest, headSha: head, inputSha256: 'b'.repeat(64), attempt: 4, round: 3,
          claimPid: process.pid, cycleId: null } });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('authentically upgrades an exact legacy reconciliation without reopening delivery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
    try {
      await pendingState(dir, target);
      const state = (await loadConvergeRunState(dir, target))!;
      state.lastLaunch!.deliveryPending = false; state.lastLaunch!.exitCode = 4;
      await withNativeTarget(dir, target, owner => writeState(dir, state, owner));
      const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: matchingDetail(target) });
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun })).resolves.toBe('reconciled');
      expect((await loadConvergeRunState(dir, target))!.lastLaunch).toMatchObject({ deliveryPending: false,
        hardFailure: true, deliveryReconciliation: { runId, reportJsonSha256: digest, attempt: 4, round: 3 } });
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun })).resolves.toBe('unchanged');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('leaves markerless legacy reconciliation unchanged when the server binding differs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
    try {
      await pendingState(dir,target);
      const state = (await loadConvergeRunState(dir,target))!;
      state.lastLaunch!.deliveryPending = false; state.lastLaunch!.exitCode = 4;
      await withNativeTarget(dir,target,owner => writeState(dir,state,owner));
      const detail = matchingDetail(target); detail.target.head_sha = 'd'.repeat(40);
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:detail})})).resolves.toBe('unchanged');
      expect((await loadConvergeRunState(dir,target))!.lastLaunch).not.toHaveProperty('deliveryReconciliation');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it.each([undefined,0,1])('does not upgrade a markerless legacy launch with exit code %s', async exitCode => {
    const dir = await mkdtemp(join(tmpdir(),'rcl-delivery-reconcile-')),target='fixture';
    try {
      await pendingState(dir,target); const state=(await loadConvergeRunState(dir,target))!;
      state.lastLaunch!.deliveryPending=false; state.lastLaunch!.exitCode=exitCode;
      await withNativeTarget(dir,target,owner=>writeState(dir,state,owner));
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:matchingDetail(target)})})).resolves.toBe('unchanged');
      expect((await loadConvergeRunState(dir,target))!.lastLaunch).not.toHaveProperty('deliveryReconciliation');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it.each([undefined,'019921a0-0000-7000-8000-000000000098'])('does not upgrade a cycle-bound legacy launch with server cycle %s', async cycleId => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-delivery-reconcile-')),target='fixture';
    try {
      await pendingState(dir,target); const state=(await loadConvergeRunState(dir,target))!;
      state.version=2; state.cycle={id:'019921a0-0000-7000-8000-000000000099',operationId:'019921a0-0000-7000-8000-000000000097',
        previousCycleId:null,repo:'owner/repo',prNumber:17,url:'https://github.com/owner/repo/pull/17',
        archivePath:'archive.json',archiveSha256:'e'.repeat(64),history:{attempts:0,rounds:0}};
      state.lastLaunch!.deliveryPending=false; state.lastLaunch!.exitCode=4;
      await writeFile(convergeRunStatePath(dir,target),JSON.stringify(state));
      const detail={...matchingDetail(target),cycle_id:cycleId,target:{...matchingDetail(target).target,repo:'owner/repo',pr_number:17}};
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:detail})})).resolves.toBe('unchanged');
      expect((await loadConvergeRunState(dir,target))!.lastLaunch).not.toHaveProperty('deliveryReconciliation');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it.each([
    ['missing live provenance', (detail: ReturnType<typeof matchingDetail>) => { delete detail.provenance; }],
    ['backfill provenance', (detail: ReturnType<typeof matchingDetail>) => { detail.provenance = 'backfill'; }],
    ['missing cycle', (detail: ReturnType<typeof matchingDetail>) => { detail.cycle_id = undefined; }],
    ['mismatched cycle', (detail: ReturnType<typeof matchingDetail>) => {
      detail.cycle_id = '019921a0-0000-7000-8000-000000000098';
    }],
    ['mismatched repository', (detail: ReturnType<typeof matchingDetail>) => { detail.target.repo = 'other/repo'; }],
    ['mismatched pull request', (detail: ReturnType<typeof matchingDetail>) => { detail.target.pr_number = 18; }],
  ])('does not reconcile a pending hard failure with %s', async (_label, mutate) => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-delivery-reconcile-')),target='fixture';
    try {
      const {detail}=await pendingCycleState(dir,target);
      mutate(detail);
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:detail})})).resolves.toBe('unchanged');
      expect((await loadConvergeRunState(dir,target))!.lastLaunch).toMatchObject({deliveryPending:true});
      expect((await loadConvergeRunState(dir,target))!.lastLaunch).not.toHaveProperty('deliveryReconciliation');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('reconciles a pending hard failure with exact live cycle and pull-request authority', async () => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-delivery-reconcile-')),target='fixture';
    try {
      const {state,detail}=await pendingCycleState(dir,target);
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:detail})})).resolves.toBe('reconciled');
      expect((await loadConvergeRunState(dir,target))!.lastLaunch).toMatchObject({deliveryPending:false,
        deliveryReconciliation:{cycleId:state.cycle!.id,runId,reportJsonSha256:digest}});
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('upgrades an exact published 4.5.2 marker without changing accounting or provider calls', async () => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-delivery-reconcile-')),target='fixture';
    try {
      const {state,detail,run}=await publishedMarkerState(dir,target);
      const before=(await loadConvergeRunState(dir,target))!,beforeRounds=structuredClone(before.rounds);
      const beforeFindings=structuredClone(before.findings);
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:detail})})).resolves.toBe('reconciled');
      const after=(await loadConvergeRunState(dir,target))!;
      expect(after.lastLaunch!.deliveryReconciliation).toMatchObject({version:2,runId,reportJsonSha256:digest,
        headSha:head,inputSha256:'b'.repeat(64),claimPid:before.lastLaunch!.pid,cycleId:state.cycle!.id});
      expect(after.rounds).toEqual(beforeRounds); expect(after.findings).toEqual(beforeFindings);
      expect(run).toHaveBeenCalledOnce();
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it.each([
    ['missing live provenance', (detail: ReturnType<typeof matchingDetail>) => { delete detail.provenance; }],
    ['backfill provenance', (detail: ReturnType<typeof matchingDetail>) => { detail.provenance='backfill'; }],
    ['missing cycle', (detail: ReturnType<typeof matchingDetail>) => { detail.cycle_id=undefined; }],
    ['mismatched cycle', (detail: ReturnType<typeof matchingDetail>) => {
      detail.cycle_id='019921a0-0000-7000-8000-000000000098';
    }],
    ['mismatched repository', (detail: ReturnType<typeof matchingDetail>) => { detail.target.repo='other/repo'; }],
    ['mismatched pull request', (detail: ReturnType<typeof matchingDetail>) => { detail.target.pr_number=18; }],
  ])('does not upgrade a published marker with %s', async (_label,mutate) => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-delivery-reconcile-')),target='fixture';
    try {
      const {detail}=await publishedMarkerState(dir,target); mutate(detail);
      const path=convergeRunStatePath(dir,target),before=await readFile(path);
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:detail})})).resolves.toBe('unchanged');
      expect(await readFile(path)).toEqual(before);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it.each([
    ['a missing input digest', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => {
      state!.lastLaunch!.inputSha256=undefined as never;
    }],
    ['an invalid input digest', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => {
      state!.lastLaunch!.inputSha256='invalid';
    }],
    ['a missing claim PID', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => {
      state!.lastLaunch!.pid=undefined as never;
    }],
    ['an invalid claim PID', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => {
      state!.lastLaunch!.pid=0;
    }],
  ])('does not mint a hard-failure marker from %s', async (_label, mutate) => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-delivery-reconcile-')),target='fixture';
    try {
      await pendingState(dir,target); const state=(await loadConvergeRunState(dir,target))!;
      mutate(state); await withNativeTarget(dir,target,owner=>writeState(dir,state,owner));
      const statePath=convergeRunStatePath(dir,target),before=await readFile(statePath);
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:matchingDetail(target)})})).resolves.toBe('unchanged');
      expect(await readFile(statePath)).toEqual(before);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it.each(['matching','conflicting','unstored'] as const)('rejects duplicate report_json server artifacts: %s', async kind => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-delivery-reconcile-')),target='fixture';
    try {
      await pendingState(dir,target); const detail=matchingDetail(target);
      detail.artifacts.push({kind:'report_json',stored:kind!=='unstored',declared_sha256:kind==='conflicting'?'d'.repeat(64):digest});
      await expect(reconcileDeliveredRun(runId,{} as never,{gitCommonDir:dir,
        getRun:vi.fn().mockResolvedValue({kind:'ok',value:detail})})).resolves.toBe('unchanged');
      expect((await loadConvergeRunState(dir,target))!.lastLaunch!.deliveryPending).toBe(true);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it.each([
    ['a mismatched head', (detail: ReturnType<typeof matchingDetail>) => { detail.target.head_sha = 'd'.repeat(40); }],
    ['a non-canonical target', (detail: ReturnType<typeof matchingDetail>) => { detail.converge.target = 'fixture/other'; }],
    ['a dot target', (detail: ReturnType<typeof matchingDetail>) => { detail.converge.target = '..'; }],
    ['a mismatched round', (detail: ReturnType<typeof matchingDetail>) => { detail.converge.round = 2; }],
    ['a mismatched attempt', (detail: ReturnType<typeof matchingDetail>) => { detail.converge.attempt = 5; }],
    ['a mismatched report digest', (detail: ReturnType<typeof matchingDetail>) => { detail.artifacts[0].declared_sha256 = 'd'.repeat(64); }],
    ['a missing report digest', (detail: ReturnType<typeof matchingDetail>) => { detail.artifacts[0].declared_sha256 = undefined as never; }],
    ['an unstored report artifact', (detail: ReturnType<typeof matchingDetail>) => { detail.artifacts[0].stored = false; }],
    ['a mismatched run id', (detail: ReturnType<typeof matchingDetail>) => { detail.id = '019921a0-0000-7000-8000-000000000002'; }],
  ])('does not mutate %s', async (_name, mutator) => {
    await expectUnchanged(mutator);
  });

  it('leaves state intact when the run cannot be read or the caller is outside a repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
    try {
      await pendingState(dir, target);
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun: vi.fn().mockResolvedValue({ kind: 'unavailable' }) })).resolves.toBe('unchanged');
      await expect(reconcileDeliveredRun(runId, {} as never, { cwd: dir, getRun: vi.fn().mockResolvedValue({ kind: 'ok', value: matchingDetail(target) }) })).resolves.toBe('unchanged');
      expect((await loadConvergeRunState(dir, target))!.lastLaunch!.deliveryPending).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each([
    ['a non-completed launch', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => { state!.lastLaunch!.status = 'failed'; }],
    ['a successful launch without pending delivery', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => {
      state!.lastLaunch!.deliveryPending = false; state!.lastLaunch!.hardFailure = false;
    }],
    ['a launch for another run', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => { state!.lastLaunch!.runId = '019921a0-0000-7000-8000-000000000002'; }],
    ['a launch without a report digest', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => { state!.lastLaunch!.reportJsonSha256 = undefined as never; }],
    ['a launch without a head or round', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => { state!.lastLaunch!.headSha = undefined as never; state!.lastLaunch!.round = undefined as never; }],
  ])('does not mutate %s', async (_name, mutate) => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
    try {
      await pendingState(dir, target);
      const state = (await loadConvergeRunState(dir, target))!;
      mutate(state);
      await withNativeTarget(dir, target, owner => writeState(dir, state, owner));
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun: vi.fn().mockResolvedValue({ kind: 'ok', value: matchingDetail(target) }) })).resolves.toBe('unchanged');
      expect(await loadConvergeRunState(dir, target)).toEqual(state);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('is idempotent and does not create state for an unrecognized target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
    try {
      await pendingState(dir, target);
      const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: matchingDetail(target) });
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun })).resolves.toBe('reconciled');
      const reconciled = await loadConvergeRunState(dir, target);
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun })).resolves.toBe('unchanged');
      expect(await loadConvergeRunState(dir, target)).toEqual(reconciled);

      const noStateRun = { ...matchingDetail('other'), converge: { target: 'other', round: 3, attempt: 4 } };
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun: vi.fn().mockResolvedValue({ kind: 'ok', value: noStateRun }) })).resolves.toBe('unchanged');
      expect(await loadConvergeRunState(dir, 'other')).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('only reconciles clean single-run flushes and preserves flush success on an unexpected failure', async () => {
    const clean = { remaining: [], failed: [], dropped: [] };
    expect(shouldReconcileDeliveredRun(runId, clean)).toBe(true);
    expect(shouldReconcileDeliveredRun(undefined, clean)).toBe(false);
    expect(shouldReconcileDeliveredRun(runId, { ...clean, remaining: [runId] })).toBe(false);
    expect(shouldReconcileDeliveredRun(runId, { ...clean, failed: [{ id: runId }] })).toBe(false);
    expect(shouldReconcileDeliveredRun(runId, { ...clean, dropped: [{ id: runId }] })).toBe(false);

    const reconcile = vi.fn().mockRejectedValue(new Error('write denied'));
    const errors: unknown[] = [];
    await expect(reconcileFlushedRun(runId, clean, {} as never, { reconcile, onError: error => errors.push(error) })).resolves.toBe('unchanged');
    expect(reconcile).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    await expect(reconcileFlushedRun(undefined, clean, {} as never, { reconcile })).resolves.toBe('unchanged');
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
