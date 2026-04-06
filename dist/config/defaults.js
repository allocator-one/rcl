export const DEFAULT_MODELS = [
    'claude-opus-4-6',
    'gpt-4o',
    'gemini-1.5-pro',
];
export const DEFAULT_THRESHOLDS = {
    minConsensusScore: 0.4,
    minConfidence: 0.2,
    dedupeLineWindow: 5,
    jaccardThreshold: 0.3,
};
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_SEVERITY_ORDER = [
    'critical',
    'important',
    'minor',
    'nitpick',
];
export const CONFIDENCE_THRESHOLDS = {
    veryHigh: 0.8,
    high: 0.6,
    medium: 0.4,
    low: 0.2,
};
//# sourceMappingURL=defaults.js.map