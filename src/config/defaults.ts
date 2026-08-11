/** SOTA models — run the general role + participate in specialized round-robin */
export const DEFAULT_MODELS = [
  'anthropic/claude-fable-5',
  'openai/gpt-5.6-sol',
  'google/gemini-3.6-flash',
  'openrouter/moonshotai/kimi-k3',
] as const;

/**
 * Secondary models — specialized round-robin only, no general role.
 * Chosen for training-lineage diversity: with the four SOTA models above,
 * every default voter comes from a different lab, so cross-model consensus
 * always reflects independent confirmation.
 */
export const DEFAULT_SECONDARY_MODELS = [
  'openrouter/qwen/qwen3.8-max',
  'openrouter/deepseek/deepseek-v4-flash-0731',
  'openrouter/x-ai/grok-4.5',
] as const;

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

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 3;
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
