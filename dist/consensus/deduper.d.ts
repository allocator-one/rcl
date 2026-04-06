import type { ModelReview, DeduplicatedGroup } from './types.js';
/**
 * Compute Jaccard similarity between two strings (word-level tokenization)
 */
export declare function jaccardSimilarity(a: string, b: string): number;
export declare function deduplicateFindings(reviews: ModelReview[], jaccardThreshold?: number, lineWindow?: number): DeduplicatedGroup[];
