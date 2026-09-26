import type { Finding, ModelReview } from '../consensus/types.js';
import { decodeCapturedInputs } from '../dispatch/captured-inputs.js';
import { mergeChunkReviewsWithContributions } from '../dispatch/merge.js';
import type { Role } from '../roles/types.js';
import { isCapturedAggregationInputs } from './aggregation-inputs.js';
import { assembleCompletedReview, type AssemblyDependencies, type CompletedReviewInput } from './assembly.js';
import { isCheckpointReportProjection, type CheckpointContribution, type CheckpointReportProjection } from './checkpoint-projection.js';
import { assertReviewerRunBindings } from './reviewer-evidence.js';
import { deriveConsensusAssembly, type ConsensusAssembly, type ConsensusAssemblyContribution } from './consensus-assembly.js';
import { buildRunHeader, diffDigest, stableStringify } from './run-header.js';
import { isSupplementalAsync, type SupplementalAsync } from './supplemental-async.js';

export interface CheckpointAssemblyInput extends Pick<CompletedReviewInput, 'diff' | 'startTime' | 'run'> {
  projection: CheckpointReportProjection;
  supplementalAsync: SupplementalAsync;
}

export type CheckpointFindingOrigin = { kind: 'checkpoint' } & Omit<CheckpointContribution, 'finding' | 'eligibility'>;
export interface AsyncFindingOrigin {
  kind: 'async';
  snapshotSha256: string;
  reviewIndex: number;
  findingIndex: number;
}
export type AssemblyFindingOrigin = CheckpointFindingOrigin | AsyncFindingOrigin;
export interface CheckpointAssemblyContribution {
  reportIdentity: string;
  disposition: 'kept' | 'below_threshold';
  origins: AssemblyFindingOrigin[];
}
export interface CheckpointAssemblyObservation {
  origin: AssemblyFindingOrigin;
  finding: Finding;
  reason: 'incomplete_seat' | 'unsuccessful_attempt' | 'async_shadowed_by_blocking' | 'unsuccessful_async';
}
export interface CheckpointAssemblyResult {
  report: Awaited<ReturnType<typeof assembleCompletedReview>>;
  contributions: CheckpointAssemblyContribution[];
  observations: CheckpointAssemblyObservation[];
  /** Raw lineage and successor-only physical attempts; merged reviews are not a billing ledger. */
  projection: CheckpointReportProjection;
}
export interface CheckpointConsensusResult extends Pick<CheckpointAssemblyResult, 'contributions' | 'observations' | 'projection'> {
  /** Deterministic pre-verification bodies; no gate approval is inferred. */
  consensus: ConsensusAssembly;
}

interface ReviewWithOrigins {
  review: ModelReview;
  origins: AssemblyFindingOrigin[][];
}

function reviewerKey(review: Pick<ModelReview, 'model' | 'role'>): string {
  return `${review.model}::${review.role}`;
}

function checkpointOrigin(contribution: CheckpointContribution): CheckpointFindingOrigin {
  const { finding: _finding, eligibility: _eligibility, ...origin } = contribution;
  return { kind: 'checkpoint', ...origin };
}

/** Compose the existing merge's positional map; never reconstruct attribution from finding text or IDs. */
function mergeWithOrigins(inputs: ReviewWithOrigins[]): ReviewWithOrigins[] {
  const merged = mergeChunkReviewsWithContributions(inputs.map(input => input.review));
  return merged.reviews.map((review, reviewIndex) => ({ review,
    origins: merged.contributions[reviewIndex]!.map(references => references.flatMap(reference => {
      const origins = inputs[reference.reviewIndex]?.origins[reference.findingIndex];
      if (!origins?.length) throw new Error('checkpoint_assembly_invalid_merge_reference');
      return origins;
    })),
  }));
}

function blockingReviews(projection: CheckpointReportProjection): ReviewWithOrigins[] {
  const plan = projection.proofs[0]!.proof.plan;
  const complete = new Set(projection.health.successfulSeats);
  const completeKeys = new Set(plan.roster.filter(seat => complete.has(seat.seat)).map(reviewerKey));
  const proofDigests = new Map(projection.proofs.map(item => [item.runId, item.proof.digest]));
  const placeholders = new Set<string>();
  const seats: ReviewWithOrigins[] = [];
  for (const seat of plan.roster) {
    if (complete.has(seat.seat)) {
      const parts = projection.selectedCells.filter(cell => cell.seat === seat.seat).map(cell => {
        if (!cell.review || cell.review.status !== 'success' || !cell.runId || !cell.attemptId || !cell.resultSha256) {
          throw new Error('checkpoint_assembly_incomplete_success');
        }
        const proofDigest = proofDigests.get(cell.runId);
        if (!proofDigest) throw new Error('checkpoint_assembly_missing_source');
        return { review: structuredClone(cell.review), origins: cell.review.findings.map((_, findingIndex) => [{
          kind: 'checkpoint' as const, runId: cell.runId!, proofDigest, cell: cell.cell, seat: cell.seat,
          attemptId: cell.attemptId!, resultSha256: cell.resultSha256!, findingIndex,
        }]) };
      });
      const merged = mergeWithOrigins(parts);
      if (merged.length !== 1) throw new Error('checkpoint_assembly_invalid_seat');
      seats.push(merged[0]!);
    } else if (!completeKeys.has(reviewerKey(seat)) && !placeholders.has(reviewerKey(seat))) {
      // Preserve legacy blocking/async precedence without letting an incomplete
      // duplicate assignment poison a complete model-role opinion.
      const incomplete = projection.seatReviews.find(item => item.seat === seat.seat)!;
      seats.push({ review: { ...structuredClone(incomplete.review), findings: [] }, origins: [] });
      placeholders.add(reviewerKey(seat));
    }
  }
  return mergeWithOrigins(seats);
}

/**
 * Assemble from validated checkpoint evidence and its frozen aggregation inputs.
 * Callers still establish complete source authority, async snapshot inheritance,
 * current native launch ownership and server admission outside this adapter.
 */
function prepareCheckpointAssembly(input: CheckpointAssemblyInput) {
  if (!isCheckpointReportProjection(input?.projection)) throw new Error('checkpoint_assembly_unvalidated_projection');
  if (!isSupplementalAsync(input.supplementalAsync)) throw new Error('checkpoint_assembly_unvalidated_async');
  const { projection, supplementalAsync } = input;
  const successor = projection.proofs.at(-1)!;
  const captureBytes = successor.proof.bindings['captured-inputs'];
  if (captureBytes === undefined) throw new Error('checkpoint_assembly_missing_capture');
  for (const item of projection.proofs) {
    if (item.proof.bindings['captured-inputs'] !== captureBytes) throw new Error('checkpoint_assembly_capture_mismatch');
  }
  const captured = decodeCapturedInputs(captureBytes, successor.proof.plan);
  const aggregation = captured.aggregation;
  if (!isCapturedAggregationInputs(aggregation)) throw new Error('checkpoint_assembly_missing_aggregation');
  if (stableStringify(captured.policy) !== stableStringify(projection.health.policy)) throw new Error('checkpoint_assembly_policy_mismatch');
  if (input.run.id !== successor.runId) throw new Error('checkpoint_assembly_run_mismatch');
  // Do not hydrate defaults into config: that would change its captured digest.
  if (stableStringify(captured.config.thresholds) !== stableStringify(aggregation.thresholds) ||
    captured.config.output?.belowThresholdAppendix !== aggregation.belowThresholdAppendix) {
    throw new Error('checkpoint_assembly_static_config_mismatch');
  }
  const diff = structuredClone(input.diff), run = structuredClone(input.run);
  const config = structuredClone(captured.config);
  if (diffDigest(diff.files) !== successor.proof.plan.patchSha256 || aggregation.diffSha256 !== successor.proof.plan.patchSha256) {
    throw new Error('checkpoint_assembly_diff_mismatch');
  }
  const gatingConfig = { ...aggregation.gating }, thresholds = { ...aggregation.thresholds };
  const header = buildRunHeader({ ...run, config, diff, gating: gatingConfig, thresholds,
    finishedAt: run.startedAt, ciExitCode: 1 });
  assertReviewerRunBindings(header, successor.proof, captured);

  const blocking = blockingReviews(projection);
  const blockingKeys = new Set(blocking.map(item => reviewerKey(item.review)));
  const asyncInputs: ReviewWithOrigins[] = supplementalAsync.reviews.map((review, reviewIndex) => ({
    review: structuredClone(review) as ModelReview,
    origins: review.findings.map((_, findingIndex) => [{ kind: 'async', snapshotSha256: supplementalAsync.digest, reviewIndex, findingIndex }]),
  }));
  const merged = mergeWithOrigins([...blocking, ...asyncInputs]);
  const expected = new Map<string, AssemblyFindingOrigin>();
  const observations: CheckpointAssemblyObservation[] = [];
  for (const contribution of projection.contributions) {
    const origin = checkpointOrigin(contribution);
    if (contribution.eligibility === 'voting') expected.set(stableStringify(origin), origin);
    else observations.push({ origin, finding: structuredClone(contribution.finding), reason: contribution.eligibility });
  }
  for (const item of asyncInputs) {
    for (const [findingIndex, finding] of item.review.findings.entries()) {
      const origin = item.origins[findingIndex]![0]!;
      if (item.review.status !== 'success') observations.push({ origin, finding: structuredClone(finding), reason: 'unsuccessful_async' });
      else if (blockingKeys.has(reviewerKey(item.review))) {
        observations.push({ origin, finding: structuredClone(finding), reason: 'async_shadowed_by_blocking' });
      } else expected.set(stableStringify(origin), origin);
    }
  }
  // Check conservation before the verifier can run, then again after dedupe.
  function checkConservation(origins: AssemblyFindingOrigin[]): void {
    const seen = new Set<string>();
    for (const origin of origins) {
      const key = stableStringify(origin);
      if (!expected.has(key) || seen.has(key)) throw new Error('checkpoint_assembly_contribution_mismatch');
      seen.add(key);
    }
    if (seen.size !== expected.size) throw new Error('checkpoint_assembly_missing_contribution');
  }
  checkConservation(merged.filter(item => item.review.status === 'success').flatMap(item => item.origins.flat()));
  const completedInput: CompletedReviewInput = { chunkReviews: blocking.map(item => item.review),
    arrivedAsync: asyncInputs.map(item => item.review), asyncLaunched: supplementalAsync.asyncLaunched,
    startTime: input.startTime, roleMap: new Map(aggregation.roles.map(item => [item.name, structuredClone(item.role) as Role])),
    config, diff, gatingConfig, reviewerHealth: projection.health, run, dedupeOrdering: 'utf16',
    ...(aggregation.modelWeights === undefined ? {} : { modelWeights: new Map(aggregation.modelWeights.map(item => [item.model, item.weight])) }),
  };
  function mapContributions(groups: ConsensusAssemblyContribution[]): CheckpointAssemblyContribution[] {
    const contributions = groups.map(group => ({ reportIdentity: group.reportIdentity, disposition: group.disposition,
      origins: group.contributions.flatMap(reference => {
        const origins = merged[reference.reviewIndex]?.origins[reference.findingIndex];
        if (!origins?.length) throw new Error('checkpoint_assembly_invalid_dedupe_reference');
        return origins.map(origin => ({ ...origin }));
      }),
    }));
    checkConservation(contributions.flatMap(group => group.origins));
    return contributions;
  }
  return { completedInput, mapContributions, observations, projection };
}

/** Rebuild findings and attribution without any provider, clock, or admission side effect. */
export function deriveCheckpointConsensus(input: CheckpointAssemblyInput): CheckpointConsensusResult {
  const prepared = prepareCheckpointAssembly(input), completed = prepared.completedInput;
  const consensus = deriveConsensusAssembly({ runId: completed.run.id!, chunkReviews: completed.chunkReviews,
    arrivedAsync: completed.arrivedAsync, roleMap: completed.roleMap, thresholds: completed.config.thresholds,
    modelWeights: completed.modelWeights, collectContributions: true, dedupeOrdering: completed.dedupeOrdering });
  return { consensus, contributions: prepared.mapContributions(consensus.contributions!),
    observations: prepared.observations, projection: prepared.projection };
}

/** Assemble and gate using exactly the same retained finding projection as offline reconstruction. */
export async function assembleCheckpointReview(
  input: CheckpointAssemblyInput,
  dependencies: AssemblyDependencies = {},
): Promise<CheckpointAssemblyResult> {
  const { completedInput, mapContributions, observations, projection } = prepareCheckpointAssembly(input);
  let contributions: CheckpointAssemblyContribution[] | undefined;
  const report = await assembleCompletedReview(completedInput, { ...dependencies, onFindingContributions(groups) {
    contributions = mapContributions(groups);
    dependencies.onFindingContributions?.(structuredClone(groups));
  } });
  if (contributions === undefined) throw new Error('checkpoint_assembly_missing_projection');
  return { report, contributions, observations, projection };
}
