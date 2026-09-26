import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialConvergeRunState, loadConvergeRunState, writeState } from '../../src/converge/run-state.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { reconcileDeliveredRun, reconcileFlushedRun, shouldReconcileDeliveredRun } from '../../src/converge/delivery-reconciliation.js';
const runId = '019921a0-0000-7000-8000-000000000001', head = 'a'.repeat(40);
const digest = 'c'.repeat(64);

function matchingDetail(target: string) {
  return {
    id: runId,
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
      expect((await loadConvergeRunState(dir, target))!.lastLaunch).toMatchObject({ attempt: 4, round: 3, deliveryPending: false, hardFailure: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
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
    ['a launch without pending delivery', (state: Awaited<ReturnType<typeof loadConvergeRunState>>) => { state!.lastLaunch!.deliveryPending = false; }],
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
