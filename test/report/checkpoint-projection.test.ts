import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Finding, ModelReview } from '../../src/consensus/types.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, exportCheckpointProof, freezeCheckpointPlan,
  type CheckpointProof, type CheckpointResult, type FrozenCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { isCheckpointReportProjection, projectCheckpointReport } from '../../src/report/checkpoint-projection.js';
import { assertReviewerHealth } from '../../src/report/reviewer-health.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const runId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const policy = { version: 1 as const, fraction: 2 / 3 };
let sequence = 0;
function plan(models = ['model-a', 'model-b', 'model-c'], chunks = 2): FrozenCheckpointPlan {
  return freezeCheckpointPlan({ target: 'rcl/projection#105', headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: hash('patch'), configSha256: hash('config'), specSha256: hash('spec'), contextSha256: hash('context'),
    toolsSha256: hash('tools'), parser: { name: 'findings-json', version: 1 },
    roster: models.map((model, index) => ({ seat: `s${index}`, model, role: 'general', route: 'fake' })),
    chunks: Array.from({ length: chunks }, (_, index) => ({ index, total: chunks, digest: hash(`chunk-${index}`) })),
    prompts: models.flatMap((_, index) => Array.from({ length: chunks }, (_, chunk) => ({ seat: `s${index}`, chunk,
      systemSha256: hash('system'), userSha256: hash(`prompt-${chunk}`) }))),
  });
}
const finding = (id: string): Finding => ({ id, file: 'a.ts', startLine: 1, endLine: 1, severity: 'critical',
  category: 'correctness', title: `Concern ${id}`, description: 'Keep this exact finding — including attribution.' });
function outcome(p: FrozenCheckpointPlan, cell: string, findings: Finding[] = [], status: ModelReview['status'] = 'success'): CheckpointResult {
  const c = p.cells.find(candidate => candidate.id === cell)!;
  const review: ModelReview = { model: c.model, role: c.role, provider: c.route, status, findings, durationMs: 4,
    usage: { inputTokens: 10, outputTokens: 2 }, ...(status === 'success' ? {} : { error: '503 temporarily unavailable' }) };
  const reviewBytes = JSON.stringify(review, null, 2);
  return status === 'success' ? { kind: 'success', chunk: c.chunk, reviewBytes }
    : { kind: 'failure', chunk: c.chunk, reviewBytes, possiblyBilled: true };
}
interface Row { cell: string; id: string; result?: CheckpointResult; kind?: 'paid' | 'unknown' }
async function proof(p: FrozenCheckpointPlan, rows: Row[]): Promise<CheckpointProof> {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-projection-'))); roots.push(commonDir);
  return withNativeTarget(commonDir, p.target, async ownership => {
    const journal = await CheckpointJournal.create({ commonDir, namespace: 'projection', plan: p, ownership });
    await journal.bind('operation', JSON.stringify({ fixture: ++sequence }), ownership);
    for (const row of rows) {
      const attempt = { id: row.id, kind: row.kind ?? 'paid' as const };
      await journal.recordIntent(row.cell, attempt, ownership);
      if (row.result) await journal.recordResult(row.cell, attempt, row.result, ownership);
    }
    await journal.finalize(ownership);
    return exportCheckpointProof(journal);
  });
}
function successes(p: FrozenCheckpointPlan, seats: string[], prefix: string): Row[] {
  return p.cells.filter(cell => seats.includes(cell.seat)).map(cell => ({ cell: cell.id, id: `${prefix}-${cell.id}`,
    result: outcome(p, cell.id, [finding(`${prefix}-${cell.id}`)]) }));
}

describe('checkpoint report projection', () => {
  it('keeps duplicate assignment instances separate for health without poisoning a complete opinion', async () => {
    const p = plan(['same-model', 'same-model', 'different-model']);
    const rows = [...successes(p, ['s0', 's2'], 'source'), { cell: 's1:0', id: 'partial', result: outcome(p, 's1:0', [finding('partial')]) }];
    const source = await proof(p, rows), successor = await proof(p, []);
    const projected = projectCheckpointReport({ sources: [{ runId: runId(1), proof: source }], successor: { runId: runId(2), proof: successor }, policy });
    expect(projected.health.successfulSeats).toEqual(['s0', 's2']);
    expect(projected.health.policy.seatCount).toBe(3);
    expect(projected.health.conclusive).toBe(true);
    expect(() => assertReviewerHealth(projected.health)).not.toThrow();
    expect(projected.seatReviews.map(item => [item.seat, item.complete])).toEqual([['s0', true], ['s1', false], ['s2', true]]);
    expect(projected.votingReviews.map(review => review.model)).toEqual(['same-model', 'different-model']);
    expect(projected.votingReviews.every(review => review.status === 'success')).toBe(true);
    expect(projected.votingReviews.flatMap(review => review.findings).some(item => item.id === 'partial')).toBe(false);
    expect(projected.nonVotingObservations).toEqual([expect.objectContaining({ cell: 's1:0', runId: runId(1), attemptId: 'partial', eligibility: 'incomplete_seat', finding: finding('partial') })]);
    const completed = projectCheckpointReport({ sources: [{ runId: runId(1), proof: source }], successor: { runId: runId(3), proof: await proof(p, [{ cell: 's1:1', id: 'completion', result: outcome(p, 's1:1') }]) }, policy });
    expect(completed.health.successfulSeats).toHaveLength(3);
    expect(completed.votingReviews).toHaveLength(2);
    expect(completed.votingReviews[0]!.findings.some(item => item.id === 'partial')).toBe(true);
  });

  it('retains every raw finding and exact original byte string even when a seat remains incomplete', async () => {
    const p = plan();
    const original = outcome(p, 's0:0', [finding('one'), finding('two')]);
    const failed = outcome(p, 's0:1', [finding('failed-observation')], 'error');
    const source = await proof(p, [{ cell: 's0:0', id: 'original', result: original }, { cell: 's0:1', id: 'failed', result: failed }]);
    const originalBytes = source.bytes;
    const projected = projectCheckpointReport({ sources: [{ runId: runId(1), proof: source }], successor: { runId: runId(2), proof: await proof(p, []) }, policy });
    expect(projected.contributions.map(item => [item.attemptId, item.findingIndex, item.eligibility])).toEqual([
      ['original', 0, 'incomplete_seat'], ['original', 1, 'incomplete_seat'], ['failed', 0, 'unsuccessful_attempt'],
    ]);
    expect(projected.contributions[0]).toMatchObject({ resultSha256: hash(original.reviewBytes), proofDigest: source.digest, runId: runId(1), cell: 's0:0' });
    expect(projected.selectedCells.find(item => item.cell === 's0:0')!.reviewBytes).toBe(original.reviewBytes);
    expect(projected.allPhysicalAttempts.find(item => item.attemptId === 'failed')!.reviewBytes).toBe(failed.reviewBytes);
    expect(projected.proofs[0]!.proof).toBe(source);
    expect(source.bytes).toBe(originalBytes);
    expect(projected.nonVotingObservations).toHaveLength(3);
    expect(projected.votingReviews).toEqual([]);
    expect(projected.health.conclusive).toBe(false);
  });

  it('counts only successor physical attempts, preserving failed retries and explicitly unknown cost', async () => {
    const p = plan(undefined, 1);
    const source = await proof(p, successes(p, ['s0'], 'old'));
    const successor = await proof(p, [
      { cell: 's1:0', id: 'new-failed', result: outcome(p, 's1:0', [], 'timeout') },
      { cell: 's1:0', id: 'new-success', result: outcome(p, 's1:0') },
      { cell: 's2:0', id: 'new-uncertain', kind: 'unknown' },
    ]);
    const input = { sources: [{ runId: runId(1), proof: source }], successor: { runId: runId(2), proof: successor }, policy };
    const projected = projectCheckpointReport(input);
    expect(projected.newPhysicalAttempts.map(item => item.attemptId)).toEqual(['new-failed', 'new-success', 'new-uncertain']);
    expect(projected.allPhysicalAttempts).toHaveLength(4);
    expect(projected.newPhysicalAttempts[2]).toMatchObject({ runId: runId(2), cell: 's2:0', certainty: 'uncertain', kind: 'unknown' });
    expect(projected.newPhysicalAttempts[2]!.review).toBeUndefined();
    expect(projected.newPhysicalAttempts.slice(0, 2).map(item => item.review!.usage!.inputTokens)).toEqual([10, 10]);
    expect(projected.health.successfulSeats).toEqual(['s0', 's1']);
    expect(projectCheckpointReport(input)).toEqual(projected);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.newPhysicalAttempts[0]!.review)).toBe(true);
  });

  it('does not turn many partial chunks or a stronger policy into conclusive health', async () => {
    const p = plan(undefined, 3), source = await proof(p, [...successes(p, ['s0'], 'one'),
      { cell: 's1:0', id: 'two-partial', result: outcome(p, 's1:0') },
      { cell: 's2:1', id: 'three-partial', result: outcome(p, 's2:1') }]);
    const projected = projectCheckpointReport({ sources: [{ runId: runId(1), proof: source }], successor: { runId: runId(2), proof: await proof(p, []) }, policy: { version: 1, fraction: 1 } });
    expect(projected.health.successfulSeats).toEqual(['s0']);
    expect(projected.health.policy.minimumSuccessful).toBe(3);
    expect(projected.health.conclusive).toBe(false);
    expect(projected.votingReviews).toHaveLength(1);
    expect(projected.seatReviews[1]!.review.status).not.toBe('success');
  });

  it('rejects copied proof objects, duplicate run/proof bindings, moved plans and invalid run IDs', async () => {
    const p = plan(), source = await proof(p, []), successor = await proof(p, []);
    const base = { sources: [{ runId: runId(1), proof: source }], successor: { runId: runId(2), proof: successor }, policy };
    expect(() => projectCheckpointReport({ ...base, successor: { ...base.successor, proof: JSON.parse(JSON.stringify(successor)) } })).toThrow('checkpoint_projection_unvalidated_proof');
    expect(() => projectCheckpointReport({ ...base, successor: { ...base.successor, runId: runId(1) } })).toThrow('checkpoint_projection_duplicate_run');
    expect(() => projectCheckpointReport({ ...base, successor: { ...base.successor, proof: source } })).toThrow('checkpoint_projection_duplicate_proof');
    const changed = await proof(freezeCheckpointPlan({ ...p, headSha: 'f'.repeat(40) }), []);
    expect(() => projectCheckpointReport({ ...base, successor: { ...base.successor, proof: changed } })).toThrow('checkpoint_projection_plan_mismatch');
    expect(() => projectCheckpointReport({ ...base, successor: { ...base.successor, runId: 'not-a-run' } })).toThrow('checkpoint_projection_invalid_run');
  });

  it('rejects repeated physical attempts and resampling a retained success across runs', async () => {
    const p = plan(undefined, 1), source = await proof(p, [{ cell: 's0:0', id: 'source-attempt', result: outcome(p, 's0:0') }]);
    const duplicate = await proof(p, [{ cell: 's1:0', id: 'source-attempt', result: outcome(p, 's1:0') }]);
    const resampled = await proof(p, [{ cell: 's0:0', id: 'resampled', result: outcome(p, 's0:0') }]);
    const base = { sources: [{ runId: runId(1), proof: source }], policy };
    expect(() => projectCheckpointReport({ ...base, successor: { runId: runId(2), proof: duplicate } })).toThrow('checkpoint_projection_duplicate_attempt');
    expect(() => projectCheckpointReport({ ...base, successor: { runId: runId(2), proof: resampled } })).toThrow('checkpoint_projection_success_resampled');
  });

  it('preserves an ordered failed-source chain and refuses to resample unknown outcomes', async () => {
    const p = plan(undefined, 1), a = await proof(p, [{ cell: 's0:0', id: 'failed-first', result: outcome(p, 's0:0', [], 'error') }]);
    const b = await proof(p, [{ cell: 's0:0', id: 'success-second', result: outcome(p, 's0:0') }]);
    const projected = projectCheckpointReport({ sources: [{ runId: runId(1), proof: a }, { runId: runId(2), proof: b }], successor: { runId: runId(3), proof: await proof(p, successes(p, ['s1'], 'new')) }, policy });
    expect(projected.allPhysicalAttempts.map(item => item.attemptId)).toEqual(['failed-first', 'success-second', 'new-s1:0']);
    expect(projected.newPhysicalAttempts).toHaveLength(1);
    const unknown = await proof(p, [{ cell: 's2:0', id: 'unknown' }]);
    const retried = await proof(p, [{ cell: 's2:0', id: 'retried', result: outcome(p, 's2:0') }]);
    expect(() => projectCheckpointReport({ sources: [{ runId: runId(1), proof: unknown }], successor: { runId: runId(2), proof: retried }, policy })).toThrow('checkpoint_projection_uncertain_resampled');
  });
});

it('brands only the immutable locally derived projection, never a serialized clone', async () => {
  const p = plan(undefined, 1);
  const projected = projectCheckpointReport({ sources: [], successor: { runId: runId(1), proof: await proof(p, successes(p, ['s0', 's1'], 'original')) }, policy });
  expect(isCheckpointReportProjection(JSON.parse(JSON.stringify(projected)))).toBe(false);
  expect(isCheckpointReportProjection({ health: projected.health })).toBe(false);
  expect(isCheckpointReportProjection(projected)).toBe(true);
});
