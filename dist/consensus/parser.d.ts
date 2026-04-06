import type { Finding } from './types.js';
export interface ParseResult {
    findings: Finding[];
    warnings: string[];
}
export declare function parseReviewOutput(rawOutput: string, model: string, role: string): ParseResult;
