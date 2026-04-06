export declare const DEFAULT_MODELS: readonly ["claude-opus-4-6", "gpt-4o", "gemini-1.5-pro"];
export declare const DEFAULT_THRESHOLDS: {
    readonly minConsensusScore: 0.4;
    readonly minConfidence: 0.2;
    readonly dedupeLineWindow: 5;
    readonly jaccardThreshold: 0.3;
};
export declare const DEFAULT_TIMEOUT_MS = 120000;
export declare const DEFAULT_MAX_RETRIES = 3;
export declare const DEFAULT_CONCURRENCY = 6;
export declare const DEFAULT_SEVERITY_ORDER: readonly ["critical", "important", "minor", "nitpick"];
export declare const CONFIDENCE_THRESHOLDS: {
    readonly veryHigh: 0.8;
    readonly high: 0.6;
    readonly medium: 0.4;
    readonly low: 0.2;
};
