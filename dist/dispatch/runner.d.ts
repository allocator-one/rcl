import type { ModelReview } from '../consensus/types.js';
import type { ReviewAssignment } from '../roles/types.js';
import type { BuiltPrompt } from '../prepare/prompt-builder.js';
export interface RunnerOptions {
    timeoutMs: number;
    maxRetries: number;
    concurrency: number;
    onReviewComplete?: (review: ModelReview) => void;
}
export declare function runReviews(assignments: ReviewAssignment[], prompts: BuiltPrompt[], options: RunnerOptions): Promise<ModelReview[]>;
