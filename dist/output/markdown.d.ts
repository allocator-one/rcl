import type { ReviewResult } from '../consensus/types.js';
export declare function toMarkdown(result: ReviewResult): string;
export declare function writeMarkdownOutput(result: ReviewResult, path: string): Promise<void>;
