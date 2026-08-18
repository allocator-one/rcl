/**
 * Core (blocking) council — every round waits for these and only these.
 * Direct-API models only: the RCL-21 audit (922 rounds, 15,268 calls) found
 * the OpenRouter wing at p50 7–9.5 min per call with 19–39% dead calls,
 * last-finisher in 97.6% of rounds; the direct trio answers in 45–70 s with
 * ~0% dead calls. Replaying the corpus with this trio alone drops the median
 * round from 14.4 to 2.0 min while 91% of multi-model findings still surface.
 */
export const DEFAULT_MODELS = [
  'anthropic/claude-fable-5',
  'openai/gpt-5.6-sol',
  'google/gemini-3.6-flash',
] as const;

/**
 * Async bonus reviewers — fired with the round but never awaited; whatever
 * has arrived by the NEXT round's dedup is merged then, marked async in the
 * report. kimi-k3 keeps a seat here because it has the council's best
 * corroboration rate (62%) but is ~6× slower than the core trio.
 */
export const DEFAULT_ASYNC_MODELS = ['openrouter/moonshotai/kimi-k3'] as const;

/**
 * Secondary models — specialized round-robin only, no general role.
 * Empty by default since RCL-25: qwen3.8-max, deepseek-v4-flash and grok-4.5
 * were removed after the audit (24–39% dead calls, worst finding-cost in the
 * council). Before any slow model earns a seat back, try it via its direct
 * provider API instead of OpenRouter and re-measure.
 */
export const DEFAULT_SECONDARY_MODELS = [] as const;

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
 * Reasoning-heavy models (kimi-k3, qwen3.8-max, deepseek-v4, grok-4.5)
 * routinely need several minutes to review a real diff: at 120s the entire
 * OpenRouter wing of the default fleet timed out, and at 300s most
 * specialist runs still did (successful calls measured 217–291s, with no
 * headroom). Dogfooded on this repo's own diffs.
 */
export const DEFAULT_TIMEOUT_MS = 600_000;

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
 * findings; 'medium' is calibrated against this repo's own diffs, where it
 * took the council from 10/17 to 17/17 completed reviews.
 */
export const DEFAULT_REASONING_EFFORT = 'medium';
export const DEFAULT_CONCURRENCY = 6;

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
