/** SOTA models — run the general role + participate in specialized round-robin */
export const DEFAULT_MODELS = [
  'anthropic/claude-fable-5',
  'openai/gpt-5.5',
  'google/gemini-3.5-flash',
] as const;

/** Previous-gen models — specialized round-robin only, no general role */
export const DEFAULT_SECONDARY_MODELS = [
  'anthropic/claude-opus-4-8',
  'openai/gpt-5.4',
  'google/gemini-2.5-pro',
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
