import { randomUUID } from 'node:crypto';
import type { ModelReview } from '../consensus/types.js';
import type { BuiltPrompt } from '../prepare/prompt-builder.js';
import type { ReviewAssignment } from '../roles/types.js';
import type { NativeTargetOwnership } from '../converge/target-ownership.js';
import { normalizeGeneratedText } from '../telemetry/scrub.js';
import { blockingCheckpointReviewSchema, type CheckpointJournal, type CheckpointState, type PaidAttempt } from './checkpoint.js';
import { hasSuccessfulQuorum, resolveQuorumPolicy } from './quorum.js';
import { reviewCallIdentity, runReviews, type RunnerOptions } from './runner.js';

/**
 * Ordinary guarded councils journal every call so an interrupted process can
 * resume without repeating paid work (RCL-80). A call in flight when its
 * process ended may already be billed: it is dispatched at most once more.
 * Each dispatch keeps the runner's bounded in-call retries, so one intent
 * covers one logical call, not one provider request.
 */
export const MAX_DISPATCHES_PER_CELL = 2;

const INTERRUPTED = 'Previous process ended without a recorded outcome; the call remains possibly billed.';
const EXHAUSTED = 'Interrupted twice without a recorded outcome; possibly billed and not dispatched again.';

export type JournaledRunnerOptions = Omit<RunnerOptions,
  'retainedReviews' | 'eligibleCallIndices' | 'beforeReview' | 'acceptReview' | 'seatIds'>;

export interface JournaledCouncilInput {
  journal: CheckpointJournal;
  ownership: NativeTargetOwnership;
  /** Chunk-major matrix in the journal plan's cell order. */
  assignments: ReviewAssignment[];
  prompts: BuiltPrompt[];
  runner: JournaledRunnerOptions;
}

export interface JournaledCouncilResult {
  reviews: ModelReview[];
  /** The signal stopped the council before quorum; the journal stays open for a resume. */
  interrupted: boolean;
  /** Successful calls reused from the journal instead of dispatched again. */
  retained: number;
  /** Calls dispatched by this invocation. */
  dispatched: number;
}

/**
 * The report normalizes reviewer prose before hashing; the journal keeps that
 * same normalized text, because its strict schema refuses raw control bytes.
 */
function journalable(review: ModelReview): ModelReview {
  return { ...review, findings: review.findings.map(finding => ({ ...finding, id: normalizeGeneratedText(finding.id),
    title: normalizeGeneratedText(finding.title), description: normalizeGeneratedText(finding.description),
    ...(finding.suggestedFix === undefined ? {} : { suggestedFix: normalizeGeneratedText(finding.suggestedFix) }) })) };
}

interface CellPlan {
  retained: Map<number, ModelReview>;
  recorded: Map<number, ModelReview>;
  exhausted: Set<number>;
  eligible: number[];
}

/** Pure selection over a validated journal; matrix order is kept as dispatch priority. */
export function planJournaledCouncil(cells: readonly { id: string }[], state: CheckpointState): CellPlan {
  const intents = new Map<string, PaidAttempt[]>();
  for (const record of state.records) {
    if (record.type !== 'intent') continue;
    intents.set(record.cell!, [...intents.get(record.cell!) ?? [], record.paidAttempt!]);
  }
  const outcomes = new Map(state.outcomes.map(outcome => [`${outcome.cell}\0${outcome.paidAttempt.id}`, outcome.result]));
  const plan: CellPlan = { retained: new Map(), recorded: new Map(), exhausted: new Set(), eligible: [] };
  cells.forEach((cell, index) => {
    const attempts = intents.get(cell.id) ?? [];
    const last = attempts.at(-1);
    const outcome = last && outcomes.get(`${cell.id}\0${last.id}`);
    if (outcome?.kind === 'success') plan.retained.set(index, JSON.parse(outcome.reviewBytes) as ModelReview);
    else if (outcome) plan.recorded.set(index, JSON.parse(outcome.reviewBytes) as ModelReview);
    else if (attempts.length >= MAX_DISPATCHES_PER_CELL) plan.exhausted.add(index);
    else plan.eligible.push(index);
  });
  return plan;
}

function blockingQuorum(assignments: readonly ReviewAssignment[], reviews: readonly ModelReview[],
  quorum: RunnerOptions['quorum']): boolean {
  if (!quorum) return reviews.every(review => review.status === 'success');
  const expected = new Map<string, number>(), succeeded = new Map<string, number>();
  assignments.forEach((assignment, index) => {
    if (quorum.blocking && !quorum.blocking[index]) return;
    const seat = JSON.stringify([assignment.provider, assignment.model, assignment.role.name]);
    expected.set(seat, (expected.get(seat) ?? 0) + 1);
    if (reviews[index]?.status === 'success') succeeded.set(seat, (succeeded.get(seat) ?? 0) + 1);
  });
  const complete = [...expected].filter(([seat, count]) => succeeded.get(seat) === count).length;
  const policy = resolveQuorumPolicy(expected.size, quorum.fraction);
  return policy.fraction < 1 ? hasSuccessfulQuorum(policy, complete) : complete === expected.size;
}

/**
 * Run the ordinary council over its journal: reuse recorded successes, keep
 * recorded failures, give an interrupted call one more dispatch, and run the
 * rest with the unchanged ordinary scheduling, provider caps and quorum.
 * The caller holds target ownership and binds the journal to its launch.
 */
export async function runJournaledCouncil(input: JournaledCouncilInput): Promise<JournaledCouncilResult> {
  const { journal, ownership, assignments, prompts } = input;
  const cells = journal.getPlan().cells;
  if (assignments.length !== cells.length || prompts.length !== cells.length) throw new Error('journaled_council_matrix_mismatch');
  assignments.forEach((assignment, index) => {
    const cell = cells[index]!;
    if (assignment.model !== cell.model || assignment.provider !== cell.route || assignment.role.name !== cell.role) {
      throw new Error('journaled_council_matrix_mismatch');
    }
  });
  let state = await journal.read();
  if (!state.finalized) {
    for (const pending of state.uncertain) {
      if (!state.records.some(record => record.type === 'uncertain' && record.cell === pending.cell &&
        record.paidAttempt?.id === pending.paidAttempt.id)) {
        await journal.recordUncertain(pending.cell, pending.paidAttempt, INTERRUPTED, ownership);
      }
    }
    state = await journal.read();
  }
  const plan = planJournaledCouncil(cells, state);
  const placeholder = (index: number, error: string): ModelReview => ({ model: assignments[index]!.model,
    role: assignments[index]!.role.name, provider: assignments[index]!.provider, status: 'canceled',
    findings: [], durationMs: 0, error });
  const merge = (reviews: ModelReview[]): ModelReview[] => reviews.map((review, index) =>
    plan.recorded.get(index) ?? (plan.exhausted.has(index) ? placeholder(index, EXHAUSTED) : review));
  if (state.finalized) {
    const reviews = cells.map((_, index) => plan.retained.get(index) ?? plan.recorded.get(index) ??
      placeholder(index, plan.exhausted.has(index) ? EXHAUSTED : INTERRUPTED));
    return { reviews, interrupted: false, retained: plan.retained.size, dispatched: 0 };
  }
  const attempts = new Map<number, PaidAttempt>();
  const reviews = merge(await runReviews(assignments, prompts, {
    ...input.runner,
    retainedReviews: [...plan.retained].map(([callIndex, review]) => ({ callIndex, review,
      callIdentity: reviewCallIdentity(assignments[callIndex]!, prompts[callIndex]!, callIndex) })),
    eligibleCallIndices: plan.eligible,
    beforeReview: async (index, signal) => {
      if (signal.aborted) return false;
      const attempt: PaidAttempt = { id: randomUUID(), kind: 'paid' };
      await journal.recordIntent(cells[index]!.id, attempt, ownership);
      attempts.set(index, attempt);
    },
    acceptReview: async (review, index) => {
      const attempt = attempts.get(index), cell = cells[index]!;
      if (!attempt) throw new Error('journaled_council_missing_intent');
      if (review.status === 'canceled') {
        await journal.recordUncertain(cell.id, attempt, review.error ?? 'Canceled with an unknown provider outcome.', ownership);
        return;
      }
      const stored = journalable(review);
      if (!blockingCheckpointReviewSchema.safeParse(stored).success) {
        // This run still reports the result; only a resume would dispatch it again.
        await journal.recordUncertain(cell.id, attempt, 'Reviewer result could not be journaled; a resume treats it as interrupted.', ownership);
        return;
      }
      await journal.recordResult(cell.id, attempt, stored.status === 'success'
        ? { kind: 'success', chunk: cell.chunk, reviewBytes: JSON.stringify(stored) }
        : { kind: 'failure', chunk: cell.chunk, reviewBytes: JSON.stringify(stored), possiblyBilled: true }, ownership);
    },
  }));
  const interrupted = input.runner.signal?.aborted === true && !blockingQuorum(assignments, reviews, input.runner.quorum);
  if (!interrupted) await journal.finalize(ownership);
  return { reviews, interrupted, retained: plan.retained.size, dispatched: attempts.size };
}
