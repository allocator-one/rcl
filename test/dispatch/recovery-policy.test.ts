import { describe, expect, it } from 'vitest';
import type { ModelReview } from '../../src/consensus/types.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';
import {
  classifyMissingReview, previewReviewerRecovery,
  type RecoveryAttempt, type RecoveryCell, type RecoveryLimits,
} from '../../src/dispatch/recovery-policy.js';

function cells(seats: number, chunks = 1): RecoveryCell[] {
  return Array.from({ length: chunks }, (_, chunk) =>
    Array.from({ length: seats }, (_, seat) => ({
      id: `s${seat}:${chunk}`, seat: `s${seat}`, model: `model-${seat}`,
      role: 'general', route: 'fake',
    }))).flat();
}
function review(cell: RecoveryCell, status: ModelReview['status'] = 'success', error?: string): ModelReview {
  return { model: cell.model, role: cell.role, provider: cell.route, status,
    findings: [], durationMs: 3, ...(error ? { error } : {}) };
}
function attempts(matrix: RecoveryCell[], successfulSeats: number): RecoveryAttempt[] {
  return matrix.filter(cell => Number(cell.seat.slice(1)) < successfulSeats)
    .map(cell => ({ id: `original-${cell.id}`, cell: cell.id, outcome: review(cell) }));
}
const limits: RecoveryLimits = { maxAttemptsPerCell: 3, maxAdditionalCalls: 20, additionalCallsUsed: 0, remainingMs: 1_000 };

describe('missing reviewer recovery policy', () => {
  it.each([[3, 2 / 3], [5, 2 / 3], [18, 2 / 3], [5, 0.8], [3, 1]])(
    'uses the shared %s-seat policy at fraction %s without retrying accepted seats', (count, fraction) => {
      const matrix = cells(count), policy = resolveQuorumPolicy(count, fraction);
      const history = attempts(matrix, policy.minimumSuccessful - 1);
      const pending = previewReviewerRecovery(matrix, history, policy, limits);
      expect(pending.successfulSeats).toBe(policy.minimumSuccessful - 1);
      expect(pending.successesNeeded).toBe(1);
      expect(pending.nextAction).toBe('retry_missing_assignments');
      expect(pending.eligibleCallIndices.every(index => Number(matrix[index]!.seat.slice(1)) >= policy.minimumSuccessful - 1)).toBe(true);
      const finalCell = matrix[pending.eligibleCallIndices[0]!]!;
      const final = previewReviewerRecovery(matrix,
        [...history, { id: 'one-new-paid-call', cell: finalCell.id, outcome: review(finalCell) }], policy,
        { ...limits, remainingMs: 0, additionalCallsUsed: 20 });
      expect(final.nextAction).toBe('build_report');
      expect(final.eligibleCallIndices).toEqual([]);
      expect(final.successfulSeats).toBe(policy.minimumSuccessful);
    });

  it('retries only missing chunks and prioritizes the seat closest to completion', () => {
    const matrix = cells(3, 3), history = attempts(matrix, 1);
    for (const index of [1, 4]) history.push({ id: `extra-${index}`, cell: matrix[index]!.id, outcome: review(matrix[index]!) });
    const plan = previewReviewerRecovery(matrix, history, resolveQuorumPolicy(3), limits);
    expect(plan.successfulSeats).toBe(1);
    expect(plan.eligibleCallIndices).toEqual([7, 2, 5, 8]);
    expect(plan.retainedCallIndices).toEqual([0, 1, 3, 4, 6]);
  });

  it('keeps known permanent and uncertain attempts out of dispatch, without counting either as success', () => {
    const matrix = cells(5), history = attempts(matrix, 2);
    history.push({ id: 'auth', cell: matrix[2]!.id, outcome: review(matrix[2]!, 'error', '401 invalid API key') });
    history.push({ id: 'uncertain', cell: matrix[3]!.id });
    const plan = previewReviewerRecovery(matrix, history, resolveQuorumPolicy(5), limits);
    expect(plan.successfulSeats).toBe(2);
    expect(plan.potentialSuccessfulSeats).toBe(3);
    expect(plan.nextAction).toBe('inspect_blocked_assignments');
    expect(plan.eligibleCallIndices).toEqual([]);
    expect(plan.blockedCells).toEqual(expect.arrayContaining([
      { cell: matrix[2]!.id, reason: 'permanent_failure' },
      { cell: matrix[3]!.id, reason: 'uncertain_outcome' },
    ]));
  });

  it('does not spend on a partially recoverable seat whose other chunk permanently failed', () => {
    const matrix = cells(3, 2), history = attempts(matrix, 1);
    history.push({ id: 'permanent', cell: matrix[1]!.id, outcome: review(matrix[1]!, 'error', '404 model not found') });
    const plan = previewReviewerRecovery(matrix, history, resolveQuorumPolicy(3), limits);
    expect(plan.eligibleCallIndices).toEqual([2, 5]);
    expect(plan.eligibleCallIndices).not.toContain(4);
  });

  it('excludes setup failures without inventing a paid attempt to block the cell', () => {
    const matrix = cells(3), history = attempts(matrix, 1);
    const plan = previewReviewerRecovery(matrix, history, resolveQuorumPolicy(3, 1), limits, [matrix[1]!.id]);
    expect(plan.recordedAttempts).toBe(1);
    expect(plan.potentialSuccessfulSeats).toBe(2);
    expect(plan.nextAction).toBe('inspect_blocked_assignments');
    expect(plan.eligibleCallIndices).toEqual([]);
    expect(plan.blockedCells).toContainEqual({ cell: matrix[1]!.id, reason: 'setup_failure' });
  });

  it('preserves spent calls and stops at call, time and per-cell attempt bounds', () => {
    const matrix = cells(3), history = attempts(matrix, 1);
    history.push({ id: 'timeout-1', cell: matrix[1]!.id, outcome: review(matrix[1]!, 'timeout') });
    history.push({ id: 'timeout-2', cell: matrix[1]!.id, outcome: review(matrix[1]!, 'timeout') });
    history.push({ id: 'timeout-3', cell: matrix[1]!.id, outcome: review(matrix[1]!, 'timeout') });
    const planned = previewReviewerRecovery(matrix, history, resolveQuorumPolicy(3), limits);
    expect(planned.eligibleCallIndices).toEqual([2]);
    expect(planned.blockedCells).toContainEqual({ cell: matrix[1]!.id, reason: 'attempt_limit' });
    expect(planned.recordedAttempts).toBe(4);
    expect(previewReviewerRecovery(matrix, history, resolveQuorumPolicy(3), { ...limits, additionalCallsUsed: 20 }).nextAction).toBe('call_limit');
    expect(previewReviewerRecovery(matrix, history, resolveQuorumPolicy(3), { ...limits, remainingMs: 0 }).nextAction).toBe('time_limit');
  });

  it('refuses duplicate attempts, rewritten successful history, wrong identities and a changed denominator', () => {
    const matrix = cells(3), history = attempts(matrix, 1), policy = resolveQuorumPolicy(3);
    expect(() => previewReviewerRecovery(matrix, [...history, history[0]!], policy, limits)).toThrow('duplicate_attempt');
    expect(() => previewReviewerRecovery(matrix, [...history, { ...history[0]!, id: 'resample' }], policy, limits)).toThrow('successful_cell_retried');
    expect(() => previewReviewerRecovery(matrix, [{ ...history[0]!, outcome: { ...history[0]!.outcome!, model: 'substitute' } }], policy, limits)).toThrow('result_identity');
    expect(() => previewReviewerRecovery(matrix, history, resolveQuorumPolicy(18), limits)).toThrow('roster_mismatch');
    expect(() => previewReviewerRecovery(matrix, history, { ...policy, minimumSuccessful: 1 }, limits)).toThrow('policy_mismatch');
    expect(() => previewReviewerRecovery(matrix, history, policy, { ...limits, maxAdditionalCalls: Infinity })).toThrow('invalid_limits');
  });

  it('cannot fill a blocking seat with an async result or retry an uncertain earlier attempt', () => {
    const matrix = cells(3), policy = resolveQuorumPolicy(3);
    expect(() => previewReviewerRecovery(matrix, [{ id: 'async', cell: matrix[0]!.id,
      outcome: { ...review(matrix[0]!), async: true } }], policy, limits)).toThrow('async_result');
    expect(() => previewReviewerRecovery(matrix, [{ id: 'unknown', cell: matrix[0]!.id },
      { id: 'replacement', cell: matrix[0]!.id, outcome: review(matrix[0]!) }], policy, limits)).toThrow('uncertain_cell_retried');
  });

  it.each([
    ['timeout', undefined, 'transient_failure'],
    ['parse_failed', 'Malformed output', 'parse_failure'],
    ['canceled', 'Canceled at quorum', 'canceled'],
    ['error', '503 service overloaded', 'transient_failure'],
    ['error', '429 rate limit', 'transient_failure'],
    ['error', '429 insufficient_quota', 'permanent_failure'],
    ['error', '400 context length exceeded', 'permanent_failure'],
    ['error', 'unknown adapter failure', 'unclassified_failure'],
  ] as const)('classifies %s (%s) conservatively as %s', (status, error, reason) => {
    expect(classifyMissingReview(review(cells(1)[0]!, status, error)).reason).toBe(reason);
  });
});
