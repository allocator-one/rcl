import { evaluateCiGate } from '../ci.js';
import { DEFAULT_THRESHOLDS } from '../config/defaults.js';
import type { DedupeOrdering } from '../consensus/deduper.js';
import type { Config } from '../config/schema.js';
import { applyGatingWithFallback, type GatingOptions, type ResolvedGatingConfig } from '../consensus/gating.js';
import type { ConsensusFinding, ModelReview, ReviewResult } from '../consensus/types.js';
import { mergeChunkReviews } from '../dispatch/merge.js';
import type { Diff } from '../resolver/types.js';
import type { Role } from '../roles/types.js';
import { buildRunHeader, type RunHeader, type RunHeaderInput } from './run-header.js';
import { uuidv7 } from './uuid.js';
import { assertReviewerHealth, type ReviewerHealth } from './reviewer-health.js';
import { deriveConsensusAssembly, type ConsensusAssembly, type ConsensusAssemblyContribution } from './consensus-assembly.js';

export interface CompletedReviewInput {
  chunkReviews: ModelReview[];
  arrivedAsync: ModelReview[];
  asyncLaunched: number;
  startTime: number;
  roleMap: Map<string, Role>;
  config: Config;
  diff: Diff;
  gatingConfig: ResolvedGatingConfig;
  modelWeights?: Map<string, number>;
  dedupeOrdering?: DedupeOrdering;
  /** Validated original-seat health for proof-bearing reports; never deserialized counts. */
  reviewerHealth?: ReviewerHealth;
  run: Omit<RunHeaderInput, 'config' | 'diff' | 'gating' | 'thresholds' | 'finishedAt' | 'ciExitCode'>;
}

export interface AssemblyDependencies extends Pick<GatingOptions, 'ask' | 'monotonicNow' | 'onVerificationProgress'> {
  onStage?: (stage: string) => void;
  onVerificationStart?: () => void;
  onWarning?: (warning: string) => void;
  /** Indices refer to the merged voting reviews in the returned report. */
  onFindingContributions?: (groups: ConsensusAssemblyContribution[]) => void;
}

/** Internal replay projection; the checkpoint adapter derives it from validated retained evidence. */
export interface CompletedReviewProjection {
  consensus: ConsensusAssembly;
  findings: ConsensusFinding[];
  appendix: ConsensusFinding[];
  verification?: ReviewResult['stats']['verification'];
}

/** Assemble retained reviewer outputs through consensus, bounded gating, and the run header. */
export async function assembleCompletedReview(
  input: CompletedReviewInput,
  dependencies: AssemblyDependencies = {},
  retained?: CompletedReviewProjection,
): Promise<ReviewResult & { run: RunHeader }> {
  const { chunkReviews, arrivedAsync, asyncLaunched, startTime, roleMap, config, diff, gatingConfig, modelWeights } = input;
  if (input.reviewerHealth !== undefined) assertReviewerHealth(input.reviewerHealth);
  dependencies.onStage?.('computing consensus');
  const runId = input.run.id ?? uuidv7();
  const { reviews, consensusFindings, reportFindings, droppedFindings, contributions } = retained?.consensus ?? deriveConsensusAssembly({
    runId, chunkReviews, arrivedAsync, roleMap, thresholds: config.thresholds, modelWeights,
    collectContributions: dependencies.onFindingContributions !== undefined,
    dedupeOrdering: input.dedupeOrdering,
  });

  // Convergence gating (RCL-23): annotate every kept finding with why it
  // does or does not gate; single-model blocking findings get one batched
  // refutation call to a fast direct-API model.
  let finalFindings = retained?.findings ?? reportFindings;
  let gatedAppendix = retained?.appendix ?? droppedFindings;
  let verificationStats = retained?.verification;
  if (retained === undefined && gatingConfig.mode === 'verified-consensus' && (input.reviewerHealth === undefined || input.reviewerHealth.conclusive)) {
    dependencies.onVerificationStart?.();
    const gated = await applyGatingWithFallback(reportFindings, {
      minModels: gatingConfig.minModels,
      verificationModel: gatingConfig.verificationModel,
      verificationTimeoutMs: gatingConfig.verificationTimeoutMs,
      verificationPassTimeoutMs: gatingConfig.verificationPassTimeoutMs,
      ask: dependencies.ask,
      monotonicNow: dependencies.monotonicNow,
      onVerificationProgress: dependencies.onVerificationProgress,
      diffFiles: diff.files,
      ...(modelWeights ? { modelWeights } : {}),
    });
    finalFindings = gated.findings;
    verificationStats = gated.ok ? gated.verification : undefined;
    if (!gated.ok) {
      (dependencies.onWarning ?? console.warn)(
        `Gating pass failed (${String(gated.failure)}); falling back to severity gating for this round.`
      );
    } else {
      // Appendix findings never block convergence; mark them so the report
      // JSON carries a gating reason on every finding.
      gatedAppendix = droppedFindings.map((f) => ({ ...f, gating: { reason: 'none' as const } }));
    }
  }

  const keepAppendix = config.output?.belowThresholdAppendix ?? true;
  if (dependencies.onFindingContributions) {
    dependencies.onFindingContributions(contributions!);
  }
  const totalRawFindings = reviews.reduce((sum, r) => sum + r.findings.length, 0);
  const body: ReviewResult = {
    reviews,
    findings: finalFindings,
    ...(keepAppendix && gatedAppendix.length > 0
      ? { belowThresholdFindings: gatedAppendix }
      : {}),
    stats: {
      totalReviews: reviews.length,
      successfulReviews: reviews.filter((r) => r.status === 'success').length,
      totalRawFindings,
      totalDeduped: consensusFindings.length,
      belowThreshold: droppedFindings.length,
      durationMs: Date.now() - startTime,
      ...(asyncLaunched > 0 ? { asyncLaunched } : {}),
      ...(arrivedAsync.length > 0
        ? { asyncMerged: mergeChunkReviews(arrivedAsync).length }
        : {}),
      // Per-call (pre-merge) so a straggler canceled on one chunk stays
      // visible even when its other chunks succeeded.
      ...(chunkReviews.some((r) => r.status === 'canceled')
        ? {
            canceledCalls: chunkReviews
              .filter((r) => r.status === 'canceled')
              .map((r) => ({ model: r.model, role: r.role, elapsedMs: r.durationMs })),
          }
        : {}),
      ...(verificationStats ? { verification: verificationStats } : {}),
      // Applied weights for this run's models, so the report shows what
      // scaled the votes (RCL-27).
      ...(modelWeights
        ? {
            modelWeights: Object.fromEntries(
              [...new Set(reviews.map((r) => r.model))].map((m) => [
                m,
                modelWeights.get(m) ?? 1,
              ])
            ),
          }
        : {}),
    },
  };

  dependencies.onStage?.('assembling the terminal report');

  // Self-describing run header (IO-12475 section 5.1), built once the body
  // exists so the CI verdict is recorded uniformly — with or without --ci.
  const run = buildRunHeader({
    ...input.run,
    id: runId,
    config,
    diff,
    gating: gatingConfig,
    thresholds: {
      minConsensusScore: config.thresholds?.minConsensusScore ?? DEFAULT_THRESHOLDS.minConsensusScore,
      minConfidence: config.thresholds?.minConfidence ?? DEFAULT_THRESHOLDS.minConfidence,
      dedupeLineWindow: config.thresholds?.dedupeLineWindow ?? DEFAULT_THRESHOLDS.dedupeLineWindow,
      jaccardThreshold: config.thresholds?.jaccardThreshold ?? DEFAULT_THRESHOLDS.jaccardThreshold,
    },
    finishedAt: new Date(),
    ciExitCode: evaluateCiGate(body, input.reviewerHealth).exitCode,
  });
  return { run, ...body };
}
