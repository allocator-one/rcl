import type { ModelReview, ConsensusFinding, DeduplicatedGroup } from './types.js';
import type { Role } from '../roles/types.js';
export declare function computeConsensus(groups: DeduplicatedGroup[], reviews: ModelReview[], roleMap: Map<string, Role>): ConsensusFinding[];
