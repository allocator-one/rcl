export interface Finding {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: 'critical' | 'important' | 'minor' | 'nitpick';
  category: 'security' | 'correctness' | 'best-practices' | 'tests' | 'api-design';
  title: string;
  description: string;
  suggestedFix?: string;
}

export interface ModelReview {
  model: string;
  role: string;
  provider: string;
  findings: Finding[];
  durationMs: number;
  status: 'success' | 'timeout' | 'error';
  error?: string;
}

/**
 * How broadly the fleet agrees on a finding, measured over distinct models
 * (roles share a model's blind spots, so model count is the evidence axis):
 * unanimous = every successful model, majority = at least half,
 * minority = 2+ but under half, single = exactly one model.
 */
export type AgreementTier = 'unanimous' | 'majority' | 'minority' | 'single';

/** One reviewer's stance on a disputed finding. */
export interface DisputePosition {
  model: string;
  role: string;
  severity: Finding['severity'];
  title: string;
  excerpt: string;
}

export interface ConsensusInfo {
  score: number;
  total: number;
  models: string[];
  roles: string[];
  crossRole: boolean;
  crossModel: boolean;
  elevated: boolean;
  original_severity?: string;
  elevation: 'none' | 'cross-role' | 'cross-model' | 'strong-consensus';
  confidence: number;
  confidenceLabel: 'Very High' | 'High' | 'Medium' | 'Low' | 'Minimal';
  tier: AgreementTier;
  disputed?: boolean;
  disputeDetails?: string;
  /** Per-reviewer stances, populated only for disputed findings. */
  positions?: DisputePosition[];
}

export interface ConsensusFinding extends Finding {
  consensus: ConsensusInfo;
}

export interface DeduplicatedGroup {
  representative: Finding;
  members: Array<{ finding: Finding; model: string; role: string }>;
}

export interface ReviewResult {
  reviews: ModelReview[];
  findings: ConsensusFinding[];
  /**
   * Findings dropped by report thresholds, kept for the demoted
   * "worth checking" appendix. Never counted in severity totals or CI
   * gating. Absent when the appendix is disabled or nothing was dropped.
   */
  belowThresholdFindings?: ConsensusFinding[];
  stats: {
    totalReviews: number;
    successfulReviews: number;
    totalRawFindings: number;
    totalDeduped: number;
    belowThreshold: number;
    durationMs: number;
  };
}
