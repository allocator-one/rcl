import type { ReviewResult } from '../consensus/types.js';
export declare function toJson(result: ReviewResult, pretty?: boolean): string;
export declare function writeJsonOutput(result: ReviewResult, path: string): Promise<void>;
