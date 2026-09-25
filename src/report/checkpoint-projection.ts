import { createHash } from 'node:crypto';
import type { Finding, ModelReview } from '../consensus/types.js';
import { isCheckpointProof, type CheckpointProof } from '../dispatch/checkpoint.js';
import { mergeChunkReviews } from '../dispatch/merge.js';
import type { QuorumPolicy } from '../dispatch/quorum.js';
import { deriveReviewerHealth, type ReviewerHealth } from './reviewer-health.js';

export interface CheckpointRunProof {
  readonly runId: string;
  readonly proof: CheckpointProof;
}

export interface CheckpointProjectionInput {
  /** Chronological, already source-authorized ancestry; never an arbitrary bag of successes. */
  readonly sources: readonly CheckpointRunProof[];
  readonly successor: CheckpointRunProof;
  readonly policy: Pick<QuorumPolicy, 'version' | 'fraction'>;
}

export interface PhysicalCheckpointAttempt {
  readonly runId: string;
  readonly proofDigest: string;
  readonly attemptId: string;
  readonly kind: 'paid' | 'unknown';
  readonly cell: string;
  readonly seat: string;
  readonly chunk: number;
  readonly certainty: 'observed' | 'uncertain';
  readonly possiblyBilled: boolean;
  readonly review?: ModelReview;
  readonly reviewBytes?: string;
  readonly resultSha256?: string;
}

export interface SelectedCheckpointCell {
  readonly cell: string;
  readonly seat: string;
  readonly status: 'observed' | 'uncertain' | 'unstarted';
  readonly runId?: string;
  readonly attemptId?: string;
  readonly review?: ModelReview;
  readonly reviewBytes?: string;
  readonly resultSha256?: string;
}

export interface CheckpointContribution {
  readonly runId: string;
  readonly proofDigest: string;
  readonly cell: string;
  readonly seat: string;
  readonly attemptId: string;
  readonly resultSha256: string;
  readonly findingIndex: number;
  readonly finding: Finding;
  readonly eligibility: 'voting' | 'incomplete_seat' | 'unsuccessful_attempt';
}

export interface CheckpointReportProjection {
  readonly health: ReviewerHealth;
  readonly proofs: readonly CheckpointRunProof[];
  readonly selectedCells: readonly SelectedCheckpointCell[];
  readonly seatReviews: readonly { readonly seat: string; readonly complete: boolean; readonly review: ModelReview }[];
  /** Complete blocking seats collapsed to the existing distinct model-role opinion identity. */
  readonly votingReviews: readonly ModelReview[];
  readonly contributions: readonly CheckpointContribution[];
  readonly nonVotingObservations: readonly CheckpointContribution[];
  readonly allPhysicalAttempts: readonly PhysicalCheckpointAttempt[];
  /** Successor-owned intents, including interrupted/possibly billed ones; never source usage. */
  readonly newPhysicalAttempts: readonly PhysicalCheckpointAttempt[];
}

const projections = new WeakSet<object>();

/** Recognizes local derivation only; serialized evidence must be validated and projected again. */
export function isCheckpointReportProjection(value: unknown): value is CheckpointReportProjection {
  return value !== null && typeof value === 'object' && projections.has(value);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Project a validated checkpoint lineage without changing its opaque result bytes.
 * The caller establishes source/run authority and complete ancestry. This pure
 * view validates local conservation and accounting; it is not server admission.
 * Supplemental async voting remains the existing assembly's responsibility.
 */
export function projectCheckpointReport(input: CheckpointProjectionInput): CheckpointReportProjection {
  if (!input || !Array.isArray(input.sources) || !input.successor) throw new Error('checkpoint_projection_invalid_lineage');
  const proofs: CheckpointRunProof[] = [...input.sources, input.successor].map(item => ({ runId: item?.runId, proof: item?.proof }));
  const runs = new Set<string>(), digests = new Set<string>();
  for (const item of proofs) {
    if (typeof item.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.runId)) {
      throw new Error('checkpoint_projection_invalid_run');
    }
    if (runs.has(item.runId.toLowerCase())) throw new Error('checkpoint_projection_duplicate_run');
    runs.add(item.runId.toLowerCase());
    if (!isCheckpointProof(item.proof)) throw new Error('checkpoint_projection_unvalidated_proof');
    if (digests.has(item.proof.digest)) throw new Error('checkpoint_projection_duplicate_proof');
    digests.add(item.proof.digest);
  }
  const plan = proofs[0]!.proof.plan;
  if (proofs.some(item => item.proof.plan.digest !== plan.digest || JSON.stringify(item.proof.plan) !== JSON.stringify(plan))) {
    throw new Error('checkpoint_projection_plan_mismatch');
  }
  const cells = new Map(plan.cells.map(cell => [cell.id, cell]));
  const attempts = new Set<string>(), successful = new Set<string>(), pending = new Map<string, string>();
  const last = new Map<string, PhysicalCheckpointAttempt>();
  const allPhysicalAttempts: PhysicalCheckpointAttempt[] = [];
  for (const item of proofs) {
    const outcomes = new Map(item.proof.state.outcomes.map(outcome => [outcome.paidAttempt.id, outcome]));
    for (const record of item.proof.state.records) {
      if (record.type === 'intent') {
        const cell = cells.get(record.cell!)!, attempt = record.paidAttempt!;
        if (attempts.has(attempt.id)) throw new Error('checkpoint_projection_duplicate_attempt');
        if (successful.has(cell.id)) throw new Error('checkpoint_projection_success_resampled');
        if (pending.has(cell.id)) throw new Error('checkpoint_projection_uncertain_resampled');
        attempts.add(attempt.id);
        pending.set(cell.id, attempt.id);
        const result = outcomes.get(attempt.id)?.result;
        const projected: PhysicalCheckpointAttempt = {
          runId: item.runId, proofDigest: item.proof.digest, attemptId: attempt.id,
          kind: attempt.kind, cell: cell.id, seat: cell.seat, chunk: cell.chunk,
          certainty: result ? 'observed' : 'uncertain',
          possiblyBilled: !result || result.kind === 'success' || result.possiblyBilled,
          ...(result ? { review: JSON.parse(result.reviewBytes) as ModelReview, reviewBytes: result.reviewBytes,
            resultSha256: createHash('sha256').update(result.reviewBytes).digest('hex') } : {}),
        };
        allPhysicalAttempts.push(projected);
        last.set(cell.id, projected);
      } else if (record.type === 'result') {
        pending.delete(record.cell!);
        if (record.result!.kind === 'success') successful.add(record.cell!);
      }
    }
  }
  const selectedCells: SelectedCheckpointCell[] = plan.cells.map(cell => {
    const attempt = last.get(cell.id);
    return attempt ? { cell: cell.id, seat: cell.seat, status: attempt.certainty,
      runId: attempt.runId, attemptId: attempt.attemptId,
      ...(attempt.review ? { review: attempt.review, reviewBytes: attempt.reviewBytes!, resultSha256: attempt.resultSha256! } : {}),
    } : { cell: cell.id, seat: cell.seat, status: 'unstarted' };
  });
  const health = deriveReviewerHealth({ version: plan.version,
    roster: plan.roster.map(seat => ({ ...seat })), chunks: plan.chunks.map(chunk => ({ ...chunk })),
    cells: plan.cells.map(cell => ({ ...cell })),
  }, selectedCells.flatMap(cell => cell.review ? [{ cell: cell.cell, review: cell.review }] : []), input.policy);
  const complete = new Set(health.successfulSeats);
  const seatReviews = plan.roster.map(seat => {
    const selected = selectedCells.filter(cell => cell.seat === seat.seat);
    const parts = selected.map(cell => cell.review ?? { model: seat.model, role: seat.role, provider: seat.route,
      findings: [], durationMs: 0, status: 'canceled' as const,
      error: cell.status === 'uncertain' ? 'Provider outcome is uncertain and possibly billed.' : 'Original cell has not been started.',
    });
    if (complete.has(seat.seat)) return { seat: seat.seat, complete: true, review: mergeChunkReviews(parts)[0]! };
    const succeeded = parts.filter(part => part.status === 'success');
    const failed = parts.find(part => part.status !== 'success')!;
    return { seat: seat.seat, complete: false, review: { model: seat.model, role: seat.role, provider: seat.route,
      status: failed.status, durationMs: parts.reduce((sum, part) => sum + part.durationMs, 0),
      findings: succeeded.flatMap(part => part.findings),
      error: `Incomplete chunk coverage: ${succeeded.length}/${parts.length} required cells succeeded.`,
    } };
  });
  const votingReviews = mergeChunkReviews(seatReviews.filter(seat => seat.complete).map(seat => seat.review));
  const contributions: CheckpointContribution[] = allPhysicalAttempts.flatMap(attempt => (attempt.review?.findings ?? []).map((finding, findingIndex): CheckpointContribution => ({
    runId: attempt.runId, proofDigest: attempt.proofDigest, cell: attempt.cell, seat: attempt.seat,
    attemptId: attempt.attemptId, resultSha256: attempt.resultSha256!, findingIndex, finding,
    eligibility: attempt.review!.status !== 'success' ? 'unsuccessful_attempt' : complete.has(attempt.seat) ? 'voting' : 'incomplete_seat',
  })));
  const projection = freeze({ health, proofs, selectedCells, seatReviews, votingReviews, contributions,
    nonVotingObservations: contributions.filter(item => item.eligibility !== 'voting'), allPhysicalAttempts,
    newPhysicalAttempts: allPhysicalAttempts.filter(attempt => attempt.runId === input.successor.runId),
  });
  projections.add(projection);
  return projection;
}
