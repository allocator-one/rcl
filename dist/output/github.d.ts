import type { ReviewResult } from '../consensus/types.js';
import type { PRMetadata } from '../resolver/types.js';
export declare function postGitHubReview(result: ReviewResult, metadata: PRMetadata, token?: string): Promise<void>;
