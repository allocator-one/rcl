import type { ModelReview } from '../consensus/types.js';
import { hasSuccessfulQuorum, resolveQuorumPolicy, type QuorumPolicy } from '../dispatch/quorum.js';

/** Structural view of the checkpoint's original blocking-only matrix. */
export interface ReviewerHealthPlan {
  version: 1;
  roster: Array<{ seat: string; model: string; role: string; route: string }>;
  chunks: Array<{ index: number; total: number; digest: string }>;
  cells: Array<{ id: string; seat: string; chunk: number; model: string; role: string; route: string; chunkDigest: string }>;
}

/** One selected, durably accepted outcome per original cell, retained or new. */
export interface SelectedReviewerResult {
  cell: string;
  review: ModelReview;
}

declare const validatedReviewerHealth: unique symbol;

/**
 * An immutable local projection, not a substitute for persisted source proof.
 * Readers of serialized reports must validate their proof and derive it again.
 */
export interface ReviewerHealth {
  readonly [validatedReviewerHealth]: true;
  readonly version: 1;
  readonly policy: QuorumPolicy;
  readonly successfulSeats: readonly string[];
  readonly incompleteSeats: readonly string[];
  readonly conclusive: boolean;
}

const validated = new WeakSet<object>();
const statuses = new Set<ModelReview['status']>(['success', 'timeout', 'error', 'parse_failed', 'canceled']);

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\0\r\n]/.test(value);
}

/** Refuse caller-invented counts, thresholds, and deserialized projections. */
export function assertReviewerHealth(value: unknown): asserts value is ReviewerHealth {
  if (value === null || typeof value !== 'object' || !validated.has(value)) {
    throw new Error('Reviewer health must be derived from a validated original matrix');
  }
}

/**
 * Derive health from complete original seat/chunk identities, never result count.
 * The caller first verifies checkpoint provenance, original plan identity and
 * selected outcome bytes. This pure projection checks matrix completeness and
 * outcome attribution; it cannot establish provider truth or source authority.
 * Async/verifier rows are outside this blocking-only plan and must not be passed.
 * Policy version/fraction are explicit; legacy waiting configuration is not used.
 */
export function deriveReviewerHealth(
  plan: ReviewerHealthPlan,
  selectedResults: readonly SelectedReviewerResult[],
  policy: Pick<QuorumPolicy, 'version' | 'fraction'>,
): ReviewerHealth {
  if (policy?.version !== 1 || typeof policy.fraction !== 'number') {
    throw new Error('Invalid reviewer health policy version or fraction');
  }
  if (plan?.version !== 1 || !Array.isArray(plan.roster) || !Array.isArray(plan.chunks) ||
    !Array.isArray(plan.cells) || !Array.isArray(selectedResults) || plan.chunks.length === 0) {
    throw new Error('Invalid frozen reviewer matrix');
  }

  const roster = new Map<string, ReviewerHealthPlan['roster'][number]>();
  for (const seat of plan.roster) {
    if (!seat || !text(seat.seat) || !text(seat.model) || !text(seat.role) || !text(seat.route)) {
      throw new Error('Invalid frozen reviewer seat');
    }
    if (roster.has(seat.seat)) throw new Error('Duplicate frozen reviewer seat');
    roster.set(seat.seat, seat);
  }
  const resolved = resolveQuorumPolicy(roster.size, policy.fraction);
  const chunks = new Map<number, string>();
  for (const chunk of plan.chunks) {
    if (!chunk || !Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= plan.chunks.length ||
      chunk.total !== plan.chunks.length || !/^[a-f0-9]{64}$/.test(chunk.digest) || chunks.has(chunk.index)) {
      throw new Error('Invalid or duplicate frozen reviewer chunk');
    }
    chunks.set(chunk.index, chunk.digest);
  }
  const expectedCount = roster.size * chunks.size;
  if (!Number.isSafeInteger(expectedCount) || plan.cells.length !== expectedCount) {
    throw new Error('Incomplete frozen reviewer matrix');
  }
  const cells = new Map<string, ReviewerHealthPlan['cells'][number]>();
  const pairs = new Set<string>();
  for (const cell of plan.cells) {
    const seat = cell && roster.get(cell.seat);
    if (!cell || !text(cell.id) || !seat || !chunks.has(cell.chunk) || cell.chunkDigest !== chunks.get(cell.chunk) ||
      cell.model !== seat.model || cell.role !== seat.role || cell.route !== seat.route) {
      throw new Error('Invalid frozen reviewer cell binding');
    }
    const pair = JSON.stringify([cell.seat, cell.chunk]);
    if (cells.has(cell.id) || pairs.has(pair)) throw new Error('Duplicate frozen reviewer cell');
    cells.set(cell.id, cell);
    pairs.add(pair);
  }

  const selected = new Set<string>();
  const successes = new Map<string, number>();
  for (const result of selectedResults) {
    const cell = result && cells.get(result.cell);
    const review = result?.review;
    if (!cell || !review || review.model !== cell.model || review.role !== cell.role || review.provider !== cell.route ||
      review.async !== undefined && review.async !== false || !statuses.has(review.status) ||
      !Array.isArray(review.findings) || !Number.isFinite(review.durationMs) || review.durationMs < 0) {
      throw new Error('Invalid selected reviewer result binding, lane or outcome');
    }
    if (selected.has(result.cell)) throw new Error('Duplicate selected reviewer cell');
    selected.add(result.cell);
    if (review.status === 'success') successes.set(cell.seat, (successes.get(cell.seat) ?? 0) + 1);
  }
  const successfulSeats: string[] = [];
  const incompleteSeats: string[] = [];
  for (const seat of roster.keys()) {
    (successes.get(seat) === chunks.size ? successfulSeats : incompleteSeats).push(seat);
  }
  const health = Object.freeze({
    version: 1 as const,
    policy: Object.freeze(resolved),
    successfulSeats: Object.freeze(successfulSeats),
    incompleteSeats: Object.freeze(incompleteSeats),
    conclusive: hasSuccessfulQuorum(resolved, successfulSeats.length),
  }) as ReviewerHealth;
  validated.add(health);
  return health;
}
