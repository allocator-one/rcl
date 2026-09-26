import { DEFAULT_THRESHOLDS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';
import { deduplicateFindings, type DedupeOrdering } from '../consensus/deduper.js';
import type { ConsensusFinding, ModelReview } from '../consensus/types.js';
import { applyReportThresholds, computeConsensus } from '../consensus/voter.js';
import { mergeChunkReviews } from '../dispatch/merge.js';
import type { Role } from '../roles/types.js';

export interface ConsensusAssemblyInput {
  runId: string;
  chunkReviews: readonly ModelReview[];
  arrivedAsync: readonly ModelReview[];
  roleMap: ReadonlyMap<string, Role>;
  thresholds?: Config['thresholds'];
  modelWeights?: ReadonlyMap<string, number>;
  collectContributions?: boolean;
  dedupeOrdering?: DedupeOrdering;
}

export interface ConsensusAssemblyContribution {
  reportIdentity: string;
  disposition: 'kept' | 'below_threshold';
  /** Positions in the returned merged reviews, before deduplication. */
  contributions: Array<{ reviewIndex: number; findingIndex: number }>;
}

export interface ConsensusAssembly {
  reviews: ModelReview[];
  consensusFindings: ConsensusFinding[];
  reportFindings: ConsensusFinding[];
  droppedFindings: ConsensusFinding[];
  contributions?: ConsensusAssemblyContribution[];
}

/**
 * Derive the existing pre-verification report projection without clocks, IO or
 * identity allocation. This is shared derivation, not proof/source admission.
 * Omitted dedupe thresholds use their existing defaults; omitted report filters
 * intentionally retain the voter's zero floor rather than those defaults.
 */
export function deriveConsensusAssembly(input: ConsensusAssemblyInput): ConsensusAssembly {
  const { thresholds } = input;
  const collectContributions = input.collectContributions === true;
  const reviews = mergeChunkReviews([...input.chunkReviews, ...input.arrivedAsync]);
  const groups = deduplicateFindings(
    reviews,
    thresholds?.jaccardThreshold ?? DEFAULT_THRESHOLDS.jaccardThreshold,
    thresholds?.dedupeLineWindow ?? DEFAULT_THRESHOLDS.dedupeLineWindow,
    thresholds?.minConsensusScore ?? DEFAULT_THRESHOLDS.minConsensusScore,
    collectContributions,
    input.dedupeOrdering,
  );
  const consensusFindings = computeConsensus(input.runId, groups, reviews, new Map(input.roleMap), {
    lineWindow: thresholds?.dedupeLineWindow,
    jaccardThreshold: thresholds?.jaccardThreshold,
  }, input.modelWeights === undefined ? undefined : new Map(input.modelWeights));
  const { kept: reportFindings, dropped: droppedFindings } = applyReportThresholds(consensusFindings, {
    minConfidence: thresholds?.minConfidence,
    minConsensusScore: thresholds?.minConsensusScore,
  });
  if (!collectContributions) return { reviews, consensusFindings, reportFindings, droppedFindings };
  const kept = new Set(reportFindings.map(finding => finding.identity));
  const contributions = consensusFindings.map((finding, index): ConsensusAssemblyContribution => ({
    reportIdentity: finding.identity!, disposition: kept.has(finding.identity) ? 'kept' : 'below_threshold',
    contributions: groups[index]!.contributions!.map(reference => ({ ...reference })),
  }));
  return { reviews, consensusFindings, reportFindings, droppedFindings, contributions };
}
