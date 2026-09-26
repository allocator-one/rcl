import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialConvergeRunState, loadConvergeRunState, writeState } from '../../src/converge/run-state.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { reconcileDeliveredRun } from '../../src/converge/delivery-reconciliation.js';
const runId = '019921a0-0000-7000-8000-000000000001', head = 'a'.repeat(40);
describe('reconcileDeliveredRun', () => {
  it('clears only a matching completed pending delivery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
    try {
      const state = initialConvergeRunState(target);
      state.lastLaunch = { status: 'completed', attempt: 4, round: 3, headSha: head, inputSha256: 'b'.repeat(64), startedAt: new Date().toISOString(), pid: process.pid, runId, reportJsonSha256: 'c'.repeat(64), successfulReviews: 1, totalReviews: 2, deliveryPending: true, hardFailure: true };
      await withNativeTarget(dir, target, owner => writeState(dir, state, owner));
      const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: { id: runId, converge: { target, round: 3, attempt: 4 }, target: { kind: 'pull_request', head_sha: head }, findings: [], calls: [] } });
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun })).resolves.toBe('reconciled');
      expect((await loadConvergeRunState(dir, target))!.lastLaunch).toMatchObject({ attempt: 4, round: 3, deliveryPending: false, hardFailure: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('does not mutate a mismatched receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-delivery-reconcile-')), target = 'fixture';
    try {
      const state = initialConvergeRunState(target);
      state.lastLaunch = { status: 'completed', attempt: 1, round: 1, headSha: head, inputSha256: 'b'.repeat(64), startedAt: new Date().toISOString(), pid: process.pid, runId, reportJsonSha256: 'c'.repeat(64), successfulReviews: 1, totalReviews: 2, deliveryPending: true };
      await withNativeTarget(dir, target, owner => writeState(dir, state, owner));
      const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: { id: runId, converge: { target, round: 1, attempt: 1 }, target: { kind: 'pull_request', head_sha: 'd'.repeat(40) }, findings: [], calls: [] } });
      await expect(reconcileDeliveredRun(runId, {} as never, { gitCommonDir: dir, getRun })).resolves.toBe('unchanged');
      expect((await loadConvergeRunState(dir, target))!.lastLaunch!.deliveryPending).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
