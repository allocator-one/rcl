import type { ModelReview } from '../consensus/types.js';
import type { CheckpointCell } from './checkpoint.js';
import { hasSuccessfulQuorum, resolveQuorumPolicy, type QuorumPolicy } from './quorum.js';

export type RecoveryCell = Pick<CheckpointCell, 'id' | 'seat' | 'model' | 'role' | 'route'>;

/** An owned, durably recorded call intent; no outcome means possibly billed. */
export interface RecoveryAttempt {
  id: string;
  cell: string;
  outcome?: ModelReview;
}

/** Persisted spend and the remaining monotonic deadline, never renewed by preview. */
export interface RecoveryLimits {
  maxAttemptsPerCell: number;
  maxAdditionalCalls: number;
  additionalCallsUsed: number;
  remainingMs: number;
}

export type RecoveryReason = 'retained_success' | 'unstarted' | 'transient_failure' |
  'parse_failure' | 'canceled' | 'permanent_failure' | 'unclassified_failure' |
  'uncertain_outcome' | 'attempt_limit' | 'setup_failure';

export interface RecoveryPreview {
  policy: QuorumPolicy;
  successfulSeats: number;
  successesNeeded: number;
  potentialSuccessfulSeats: number;
  retainedCallIndices: number[];
  /** Original matrix indices ordered by the fewest missing chunks per seat. */
  eligibleCallIndices: number[];
  blockedCells: Array<{ cell: string; reason: RecoveryReason }>;
  recordedAttempts: number;
  additionalCallsUsed: number;
  remainingCalls: number;
  nextAction: 'build_report' | 'retry_missing_assignments' | 'inspect_blocked_assignments' |
    'call_limit' | 'time_limit';
}

/**
 * Conservative eligibility for a terminal unsuccessful call. Unknown adapter
 * errors require a diagnosis; repeated unchanged authentication, quota or input
 * failures never spend another call automatically. This does not authorize a
 * launch or change a native attempt cap.
 */
export function classifyMissingReview(review?: ModelReview): { eligible: boolean; reason: RecoveryReason } {
  if (!review) return { eligible: true, reason: 'unstarted' };
  if (review.status === 'success') return { eligible: false, reason: 'retained_success' };
  const error = review.error ?? '';
  if (/\b(?:400|401|403|404|413)\b|invalid[ _-]?(?:api[ _-]?)?key|api[ _-]?key.*(?:missing|not set)|authentication|unauthori[sz]ed|forbidden|insufficient[_ -]quota|quota.*(?:exceed|exhaust)|(?:exceed|exhaust).*quota|billing[_ -]hard[_ -]limit|credits?.*(?:exhaust|insufficient)|(?:unknown|unsupported|not found).*model|model.*(?:not found|unsupported)|context.{0,20}(?:length|window|exceed)|prompt too (?:long|large)|invalid request/i.test(error)) {
    return { eligible: false, reason: 'permanent_failure' };
  }
  if (review.status === 'parse_failed') return { eligible: true, reason: 'parse_failure' };
  if (review.status === 'canceled') return { eligible: true, reason: 'canceled' };
  if (review.status === 'timeout' || /\b(?:429|5\d\d)\b|rate.?limit|temporar|overload|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection|network|socket|fetch failed/i.test(error)) {
    return { eligible: true, reason: 'transient_failure' };
  }
  return { eligible: false, reason: 'unclassified_failure' };
}

/**
 * Plan missing calls from a validated, frozen checkpoint. This pure read leaves
 * all original outcomes intact. The executor must recheck limits and persist an
 * intent under target ownership before EVERY provider call; the eligible list
 * is not a reservation and does not bypass the guarded launch budget.
 */
export function previewReviewerRecovery(
  cells: readonly RecoveryCell[],
  attempts: readonly RecoveryAttempt[],
  policy: QuorumPolicy,
  limits: RecoveryLimits,
  unavailableCells: readonly string[] = [],
): RecoveryPreview {
  if (![limits.maxAttemptsPerCell, limits.maxAdditionalCalls, limits.additionalCallsUsed]
    .every(value => Number.isSafeInteger(value) && value >= 0) || limits.maxAttemptsPerCell < 1 ||
    !Number.isFinite(limits.remainingMs)) throw new Error('recovery_invalid_limits');
  const byId = new Map<string, { cell: RecoveryCell; index: number; attempts: RecoveryAttempt[] }>();
  const seats = new Map<string, number[]>();
  for (const [index, cell] of cells.entries()) {
    if (!cell.id || !cell.seat || byId.has(cell.id)) throw new Error('recovery_invalid_matrix');
    byId.set(cell.id, { cell, index, attempts: [] });
    const indices = seats.get(cell.seat) ?? [];
    const first = indices.length ? cells[indices[0]!] : undefined;
    if (first && (first.model !== cell.model || first.route !== cell.route || first.role !== cell.role)) {
      throw new Error('recovery_invalid_matrix');
    }
    indices.push(index);
    seats.set(cell.seat, indices);
  }
  if (seats.size !== policy.seatCount) throw new Error('recovery_roster_mismatch');
  const resolved = resolveQuorumPolicy(seats.size, policy.fraction);
  if (policy.version !== resolved.version || policy.minimumSuccessful !== resolved.minimumSuccessful) {
    throw new Error('recovery_policy_mismatch');
  }
  const seenAttempts = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt.id || seenAttempts.has(attempt.id)) throw new Error('recovery_duplicate_attempt');
    seenAttempts.add(attempt.id);
    const entry = byId.get(attempt.cell);
    if (!entry) throw new Error('recovery_unknown_cell');
    if (entry.attempts.some(previous => previous.outcome?.status === 'success')) throw new Error('recovery_successful_cell_retried');
    if (entry.attempts.some(previous => previous.outcome === undefined)) throw new Error('recovery_uncertain_cell_retried');
    if (attempt.outcome) {
      const { outcome } = attempt;
      if (outcome.model !== entry.cell.model || outcome.role !== entry.cell.role || outcome.provider !== entry.cell.route) {
        throw new Error('recovery_result_identity');
      }
      if (outcome.async === true) throw new Error('recovery_async_result');
      if (!['success', 'error', 'timeout', 'parse_failed', 'canceled'].includes(outcome.status)) {
        throw new Error('recovery_invalid_outcome');
      }
    }
    entry.attempts.push(attempt);
  }

  const retainedCallIndices: number[] = [];
  const eligible = new Set<number>();
  const blockedCells: RecoveryPreview['blockedCells'] = [];
  const unavailable = new Set(unavailableCells);
  if (unavailable.size !== unavailableCells.length || unavailableCells.some(cell => !byId.has(cell))) {
    throw new Error('recovery_invalid_unavailable_cells');
  }
  for (const entry of byId.values()) {
    const last = entry.attempts.at(-1);
    if (last?.outcome?.status === 'success') { retainedCallIndices.push(entry.index); continue; }
    let decision: ReturnType<typeof classifyMissingReview>;
    if (unavailable.has(entry.cell.id)) decision = { eligible: false, reason: 'setup_failure' };
    else if (last && !last.outcome) decision = { eligible: false, reason: 'uncertain_outcome' };
    else if (entry.attempts.length >= limits.maxAttemptsPerCell) decision = { eligible: false, reason: 'attempt_limit' };
    else decision = classifyMissingReview(last?.outcome);
    if (decision.eligible) eligible.add(entry.index);
    else blockedCells.push({ cell: entry.cell.id, reason: decision.reason });
  }
  const retained = new Set(retainedCallIndices);
  let successfulSeats = 0;
  const recoverable: number[][] = [];
  for (const indices of seats.values()) {
    const missing = indices.filter(index => !retained.has(index));
    if (!missing.length) successfulSeats++;
    else if (missing.every(index => eligible.has(index))) recoverable.push(missing);
  }
  recoverable.sort((left, right) => left.length - right.length || left[0]! - right[0]!);
  const remainingCalls = Math.max(0, limits.maxAdditionalCalls - limits.additionalCallsUsed);
  const potentialSuccessfulSeats = successfulSeats + recoverable.length;
  const conclusive = hasSuccessfulQuorum(resolved, successfulSeats);
  const nextAction: RecoveryPreview['nextAction'] = conclusive ? 'build_report'
    : limits.remainingMs <= 0 ? 'time_limit'
    : remainingCalls === 0 ? 'call_limit'
    : potentialSuccessfulSeats < resolved.minimumSuccessful ? 'inspect_blocked_assignments'
    : 'retry_missing_assignments';
  return {
    policy: resolved, successfulSeats, successesNeeded: Math.max(0, resolved.minimumSuccessful - successfulSeats),
    potentialSuccessfulSeats, retainedCallIndices,
    eligibleCallIndices: nextAction === 'retry_missing_assignments' ? recoverable.flat() : [],
    blockedCells, recordedAttempts: attempts.length, additionalCallsUsed: limits.additionalCallsUsed,
    remainingCalls, nextAction,
  };
}
