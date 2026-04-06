import type { Role, ReviewAssignment } from './types.js';
import type { ReviewerPair } from '../config/schema.js';
export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'openai-compat';
export declare function detectProvider(model: string): ModelProvider;
/**
 * Build assignments from explicit reviewer pairs (--reviewer model:role)
 */
export declare function buildExplicitAssignments(reviewerPairs: ReviewerPair[], roleMap: Map<string, Role>): ReviewAssignment[];
/**
 * Build assignments using the dispatch algorithm:
 * - general role: runs on ALL models
 * - specialized roles: spread across models via shuffled round-robin
 */
export declare function buildRoleAssignments(models: string[], roles: Role[]): ReviewAssignment[];
/**
 * Main dispatch builder — handles explicit pairs or role-based assignment
 */
export declare function buildAssignments(opts: {
    models: string[];
    roles: Role[];
    explicitReviewers?: ReviewerPair[];
    roleMap: Map<string, Role>;
}): ReviewAssignment[];
