import { evaluateCiGate } from '../ci.js';
import { DEFAULT_THRESHOLDS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';
import { deduplicateFindings } from '../consensus/deduper.js';
import { deduplicateSemanticFindings } from '../consensus/semantic-deduper.js';
import { applyGatingWithFallback, type GatingOptions, type ResolvedGatingConfig } from '../consensus/gating.js';
import type { ModelReview, ReviewResult } from '../consensus/types.js';
import { computeConsensus, applyReportThresholds } from '../consensus/voter.js';
import { mergeChunkReviews } from '../dispatch/merge.js';
import { materializeRecoveredClaims, type RecoveredProduction } from '../converge/recovered-production.js';
import type { Diff } from '../resolver/types.js';
import type { Role } from '../roles/types.js';
import { buildRunHeader, type RunHeader, type RunHeaderInput } from './run-header.js';
import { uuidv7 } from './uuid.js';

interface CompletedReviewInput {
  chunkReviews: ModelReview[];
  arrivedAsync: ModelReview[];
  asyncLaunched: number;
  startTime: number;
  roleMap: Map<string, Role>;
  config: Config;
  diff: Diff;
  gatingConfig: ResolvedGatingConfig;
  modelWeights?: Map<string, number>;
  recoveredProduction?: RecoveredProduction;
  run: Omit<RunHeaderInput, 'config' | 'diff' | 'gating' | 'thresholds' | 'finishedAt' | 'ciExitCode'>;
}

interface AssemblyDependencies extends Pick<GatingOptions, 'ask' | 'monotonicNow' | 'onVerificationProgress'> {
  onStage?: (stage: string) => void;
  onVerificationStart?: () => void;
  onWarning?: (warning: string) => void;
}

/** Assemble retained reviewer outputs through consensus, bounded gating, and the run header. */
export async function assembleCompletedReview(
  input: CompletedReviewInput,
  dependencies: AssemblyDependencies = {}
): Promise<ReviewResult & { run: RunHeader }> {
  const { chunkReviews, arrivedAsync, asyncLaunched, startTime, roleMap, config, diff, gatingConfig, modelWeights } = input;
  const reviews = mergeChunkReviews([...chunkReviews, ...arrivedAsync]);

  dependencies.onStage?.('computing consensus');

  // Deduplicate and compute consensus
  const deduplicate = input.recoveredProduction ? deduplicateSemanticFindings : deduplicateFindings;
  const groups = deduplicate(
    reviews,
    config.thresholds?.jaccardThreshold ?? DEFAULT_THRESHOLDS.jaccardThreshold,
    config.thresholds?.dedupeLineWindow ?? DEFAULT_THRESHOLDS.dedupeLineWindow,
    config.thresholds?.minConsensusScore ?? DEFAULT_THRESHOLDS.minConsensusScore
  );

  const runId = input.run.id ?? uuidv7();
  const consensusFindings = materializeRecoveredClaims(computeConsensus(
    runId,
    groups,
    reviews,
    roleMap,
    {
      lineWindow: config.thresholds?.dedupeLineWindow,
      jaccardThreshold: config.thresholds?.jaccardThreshold,
    },
    modelWeights
  ), input.recoveredProduction);

  const { kept: reportFindings, dropped: droppedFindings } = applyReportThresholds(
    consensusFindings,
    {
      minConfidence: config.thresholds?.minConfidence,
      minConsensusScore: config.thresholds?.minConsensusScore,
    }
  );

  // Convergence gating (RCL-23): annotate every kept finding with why it
  // does or does not gate; single-model blocking findings get one batched
  // refutation call to a fast direct-API model.
  let finalFindings = reportFindings;
  let gatedAppendix = droppedFindings;
  let verificationStats: ReviewResult['stats']['verification'];
  if (gatingConfig.mode === 'verified-consensus') {
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
    ciExitCode: evaluateCiGate(body).exitCode,
  });
  return { run, ...body };
}
