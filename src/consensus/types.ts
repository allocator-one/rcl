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

/**
 * Token usage one reviewer call consumed, as the provider SDK reported it
 * (evidence ledger, IO-12475 section 5.2). Reasoning tokens are present only
 * for providers that account them separately (OpenAI, Google); Anthropic
 * folds thinking into output tokens. Cost is computed server-side from a
 * price table — never here.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface ModelReview {
  model: string;
  role: string;
  provider: string;
  findings: Finding[];
  durationMs: number;
  /** Token usage where the SDK exposes it; absent otherwise. */
  usage?: TokenUsage;
  /**
   * `parse_failed` is distinct from `error`: the model answered, but its
   * output could not be turned into findings. Both are excluded from
   * consensus and from `successfulReviews` — a reviewer whose output was
   * lost must never read as "reviewed and found nothing" — but keeping them
   * apart tells an operator whether to look at the network or the prompt.
   * `canceled` means the round closed at quorum before this call returned;
   * the reviewer was healthy but slower than the round (RCL-26).
   */
  status: 'success' | 'timeout' | 'error' | 'parse_failed' | 'canceled';
  error?: string;
  /**
   * Findings the parser discarded as malformed. Present (and non-zero) on a
   * partially-salvaged review too, so degraded coverage is visible in the
   * report rather than only in stdout.
   */
  droppedFindings?: number;
  /** Parser warnings, carried into the report instead of only console.warn. */
  warnings?: string[];
  /**
   * Review came from the async (non-blocking) lane: fired with an earlier
   * round, never awaited, merged into this round's dedup on arrival. Its
   * findings reference the code as of the round that launched it.
   */
  async?: boolean;
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
  /**
   * Precision-weighted vote mass of the supporting models (RCL-27): sum of
   * each supporting model's trailing-precision weight. Present only when
   * weighting is active; all-neutral weights make it equal the model count.
   */
  weightedScore?: number;
  /** The weight each supporting model contributed, for report transparency. */
  modelWeights?: Record<string, number>;
}

export interface ConsensusFinding extends Finding {
  consensus: ConsensusInfo;
  /**
   * Stable cross-round identity — the converge `stableFindingKey` (file,
   * category, line bucket) computed at review time, so identity exists in
   * the report itself and not only inside the converge state (IO-12475
   * section 8.2). Always set on findings rcl ≥ 3.0 produces; optional in the
   * type so pre-3.0 reports still load.
   */
  identity?: string;
  /**
   * Why this finding does (or does not) block convergence — see
   * `consensus/gating.ts` (RCL-23). Absent in `all-findings` fallback mode,
   * where severity alone decides.
   */
  gating?: import('./gating.js').GatingInfo;
}

export interface DeduplicatedGroup {
  representative: Finding;
  members: Array<{ finding: Finding; model: string; role: string }>;
}

export interface ReviewResult {
  /**
   * Self-describing run header (rcl ≥ 3.0): what was reviewed (exact head
   * and base SHA, diff digest), by which roster and settings, when, by whom.
   * Optional so every reader of pre-3.0 reports keeps working.
   */
  run?: import('../report/run-header.js').RunHeader;
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
    /** Async-lane calls fired with this round (not awaited, not in totalReviews). */
    asyncLaunched?: number;
    /** Async-lane reviews (from earlier rounds) merged into this round's dedup. */
    asyncMerged?: number;
    /**
     * Calls canceled by quorum round closure, with how long each had been
     * running — persistent stragglers stay visible per round (RCL-26).
     */
    canceledCalls?: Array<{ model: string; role: string; elapsedMs: number }>;
    /** Outcome of the single-model finding verification pass (RCL-23). */
    verification?: import('./gating.js').VerificationStats;
    /** Trailing-precision weight applied to each of this run's models (RCL-27). */
    modelWeights?: Record<string, number>;
  };
}
