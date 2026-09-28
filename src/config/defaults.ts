/**
 * Primary council — general reviewers; specialists also use secondary models.
 * Direct-API models only: the RCL-21 audit (922 rounds, 15,268 calls) found
 * the OpenRouter wing at p50 7–9.5 min per call with 19–39% dead calls,
 * last-finisher in 97.6% of rounds; the audited direct trio answered in
 * 45–70 s with ~0% dead calls. Replaying the corpus with that direct-provider
 * topology drops the median round from 14.4 to 2.0 min while 91% of
 * multi-model findings still surface.
 */
export const DEFAULT_MODELS = [
  'anthropic/claude-opus-5-5',
  'openai/gpt-6-sol',
] as const;

/**
 * Async bonus reviewers — fired with the round but never awaited; whatever
 * has arrived by the NEXT round's dedup is merged then, marked async in the
 * report. kimi-k3 keeps a seat here because it has the council's best
 * corroboration rate (62%) but is ~6× slower than the core trio.
 */
export const DEFAULT_ASYNC_MODELS = ['openrouter/moonshotai/kimi-k3'] as const;

/** Gemini contributes specialist reviews without adding a general-review seat. */
export const DEFAULT_SECONDARY_MODELS = ['google/gemini-3.8-flash'] as const;

export const DEFAULT_THRESHOLDS = {
  minConsensusScore: 0.4,
  minConfidence: 0.2,
  dedupeLineWindow: 5,
  /**
   * Threshold for the weighted title+description similarity
   * (0.6 * title + 0.4 * description). Calibrated against the fixture
   * corpus: genuine cross-model duplicates score 0.29-0.55 (descriptions
   * diverge heavily across models), so higher thresholds split real
   * duplicates. The strictness gain over the old max(title, desc) check
   * comes from the formula: a title-only match now needs 0.5+ title
   * overlap to merge instead of 0.3.
   */
  jaccardThreshold: 0.3,
} as const;

/**
 * Blocking-path per-call timeout. The RCL-21 corpus put every direct-API
 * model's p90 under 260 s, but the 2.0.0 rollout (RCL-29) showed heavier
 * reasoning defaults pushing real calls past 300 s; losing a reviewer costs
 * more than waiting, so the blocking path now gets 540 s. Slow-by-design
 * models still belong in the async lane, which has its own cap below.
 */
export const DEFAULT_TIMEOUT_MS = 540_000;

/**
 * Quorum round closure (RCL-26): a round closes once this fraction of its
 * planned calls has completed; outstanding non-core calls are canceled and
 * recorded. ⅔ matches the converge reviewer-health threshold, so a round
 * closed exactly at quorum can still be conclusive. Corpus replay: −51%
 * total review wall even with the pre-RCL-25 roster. Set to 1 to disable.
 */
export const DEFAULT_QUORUM_FRACTION = 2 / 3;

/**
 * Per-call timeout for the async (non-blocking) lane. Async reviewers are
 * slow by definition — kimi-k3's p50 is 7–9.5 min — and nothing waits on
 * them, so they get more headroom than the blocking council.
 */
export const DEFAULT_ASYNC_TIMEOUT_MS = 900_000;
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Reasoning budget for OpenRouter-hosted models. Unbounded, they spend the
 * whole completion budget (and many minutes) thinking before emitting any
 * findings. Kimi K3, the default async model, supports low/high/max, not
 * medium. Use the supported low level while retaining the output/time caps;
 * explicit configuration can still select another effort for other models.
 */
export const DEFAULT_REASONING_EFFORT = 'low';
export const DEFAULT_CONCURRENCY = 9;
/**
 * Provider admission limits inside the blocking runner. The default prevents
 * the observed five-seat high-effort Anthropic burst while preserving the
 * existing per-call deadline. Providers absent from this map remain bounded
 * only by the global concurrency limit.
 */
export const DEFAULT_PROVIDER_CONCURRENCY = { anthropic: 2 } as const;

export const DEFAULT_SEVERITY_ORDER = [
  'critical',
  'important',
  'minor',
  'nitpick',
] as const;

export const CONFIDENCE_THRESHOLDS = {
  veryHigh: 0.8,
  high: 0.6,
  medium: 0.4,
  low: 0.2,
} as const;
