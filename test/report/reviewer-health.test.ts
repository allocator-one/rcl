import { describe, expect, it } from 'vitest';
import type { ModelReview } from '../../src/consensus/types.js';
import {
  assertReviewerHealth,
  deriveReviewerHealth,
  type ReviewerHealthPlan,
  type SelectedReviewerResult,
} from '../../src/report/reviewer-health.js';

const policy = { version: 1 as const, fraction: 2 / 3 };

function fixture(seats = 3, chunkCount = 2) {
  const roster = Array.from({ length: seats }, (_, index) => ({
    seat: `seat-${index}`, model: 'same-model', role: 'general', route: 'provider',
  }));
  const chunks = Array.from({ length: chunkCount }, (_, index) => ({
    index, total: chunkCount, digest: String(index).repeat(64),
  }));
  const cells = roster.flatMap(seat => chunks.map(chunk => ({
    id: `${seat.seat}:${chunk.index}`, ...seat, chunk: chunk.index, chunkDigest: chunk.digest,
  })));
  const plan: ReviewerHealthPlan = { version: 1, roster, chunks, cells };
  const selected: SelectedReviewerResult[] = cells.map(cell => ({
    cell: cell.id,
    review: {
      model: cell.model, role: cell.role, provider: cell.route,
      status: 'success', findings: [], durationMs: 1,
    },
  }));
  return { plan, selected };
}

describe('reviewer health from the frozen blocking matrix', () => {
  it('counts only seats with every original chunk successful, without shrinking the denominator', () => {
    const { plan, selected } = fixture(17);
    // Eleven complete seats and only one chunk of the twelfth are not 12/17.
    const partial = deriveReviewerHealth(plan, selected.slice(0, 23), policy);
    expect(partial.policy).toEqual({ version: 1, fraction: 2 / 3, seatCount: 17, minimumSuccessful: 12 });
    expect(partial.successfulSeats).toHaveLength(11);
    expect(partial.incompleteSeats).toHaveLength(6);
    expect(partial.conclusive).toBe(false);
    const complete = deriveReviewerHealth(plan, selected.slice(0, 24), policy);
    expect(complete.successfulSeats).toHaveLength(12);
    expect(complete.conclusive).toBe(true);
  });

  it.each(['timeout', 'error', 'parse_failed', 'canceled'] as const)(
    'does not count a seat containing a %s chunk as successful', status => {
      const { plan, selected } = fixture();
      selected[1]!.review.status = status;
      selected[3]!.review.status = status;
      const health = deriveReviewerHealth(plan, selected, policy);
      expect(health.successfulSeats).toEqual(['seat-2']);
      expect(health.conclusive).toBe(false);
    },
  );

  it('keeps identical model/role assignments distinct only by their original seat IDs', () => {
    const { plan, selected } = fixture();
    expect(deriveReviewerHealth(plan, selected.slice(0, 4), policy).successfulSeats).toEqual(['seat-0', 'seat-1']);
    expect(() => deriveReviewerHealth(plan, [selected[0]!, selected[0]!], policy)).toThrow(/duplicate/i);
  });

  it('honors an explicitly stricter versioned policy and does not treat one seat as conclusive', () => {
    const { plan, selected } = fixture();
    const health = deriveReviewerHealth(plan, selected.slice(0, 4), { version: 1, fraction: 1 });
    expect(health.policy.minimumSuccessful).toBe(3);
    expect(health.conclusive).toBe(false);
    const one = fixture(1);
    expect(deriveReviewerHealth(one.plan, one.selected, policy).conclusive).toBe(false);
    expect(() => deriveReviewerHealth(plan, selected, { version: 2, fraction: 2 / 3 } as never)).toThrow(/policy/i);
    expect(() => deriveReviewerHealth(plan, selected, { version: 1, fraction: 0.5 })).toThrow(/fraction/i);
  });

  it.each([
    ['missing chunk', (plan: ReviewerHealthPlan) => { plan.chunks.pop(); }],
    ['duplicate chunk', (plan: ReviewerHealthPlan) => { plan.chunks[1] = plan.chunks[0]!; }],
    ['missing cell', (plan: ReviewerHealthPlan) => { plan.cells.pop(); }],
    ['duplicate cell ID', (plan: ReviewerHealthPlan) => { plan.cells[1]!.id = plan.cells[0]!.id; }],
    ['duplicate seat/chunk pair', (plan: ReviewerHealthPlan) => { plan.cells[1]!.chunk = 0; plan.cells[1]!.chunkDigest = plan.chunks[0]!.digest; }],
    ['duplicate roster seat', (plan: ReviewerHealthPlan) => { plan.roster[1]!.seat = plan.roster[0]!.seat; }],
    ['foreign seat', (plan: ReviewerHealthPlan) => { plan.cells[0]!.seat = 'foreign'; }],
    ['wrong route', (plan: ReviewerHealthPlan) => { plan.cells[0]!.route = 'foreign'; }],
    ['wrong chunk digest', (plan: ReviewerHealthPlan) => { plan.cells[0]!.chunkDigest = 'f'.repeat(64); }],
  ])('refuses an invalid frozen matrix: %s', (_name, mutate) => {
    const { plan, selected } = fixture();
    mutate(plan);
    expect(() => deriveReviewerHealth(plan, selected, policy)).toThrow();
  });

  it.each([
    ['async success', (row: SelectedReviewerResult) => { row.review.async = true; }],
    ['foreign cell', (row: SelectedReviewerResult) => { row.cell = 'foreign'; }],
    ['foreign model', (row: SelectedReviewerResult) => { row.review.model = 'foreign'; }],
    ['foreign role', (row: SelectedReviewerResult) => { row.review.role = 'foreign'; }],
    ['foreign provider', (row: SelectedReviewerResult) => { row.review.provider = 'foreign'; }],
    ['invalid status', (row: SelectedReviewerResult) => { row.review.status = 'completed' as ModelReview['status']; }],
    ['missing findings', (row: SelectedReviewerResult) => { delete (row.review as Partial<ModelReview>).findings; }],
  ])('refuses invalid selected proof: %s', (_name, mutate) => {
    const { plan, selected } = fixture();
    mutate(selected[0]!);
    expect(() => deriveReviewerHealth(plan, selected, policy)).toThrow();
  });

  it('does not mutate retained findings, results, or the original frozen matrix', () => {
    const { plan, selected } = fixture();
    selected[0]!.review.findings.push({
      id: 'original-finding', file: 'a.ts', startLine: 1, endLine: 1,
      severity: 'important', category: 'correctness', title: 'Original title', description: 'Original claim',
    });
    const bytes = JSON.stringify({ plan, selected });
    const health = deriveReviewerHealth(plan, selected, policy);
    expect(JSON.stringify({ plan, selected })).toBe(bytes);
    selected[0]!.review.status = 'error';
    expect(health.successfulSeats).toEqual(['seat-0', 'seat-1', 'seat-2']);
    expect(Object.isFrozen(health)).toBe(true);
    expect(Object.isFrozen(health.policy)).toBe(true);
    expect(Object.isFrozen(health.successfulSeats)).toBe(true);
    expect(() => assertReviewerHealth(health)).not.toThrow();
    expect(() => assertReviewerHealth({ ...health, policy: { ...health.policy, minimumSuccessful: 1 } })).toThrow(/validated/i);
  });
});
