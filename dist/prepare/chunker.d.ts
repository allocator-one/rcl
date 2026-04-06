import type { FileChange } from '../resolver/types.js';
export interface Chunk {
    files: FileChange[];
    totalLines: number;
    index: number;
    total: number;
}
export declare function chunkDiff(files: FileChange[]): Chunk[];
export declare function formatChunkForPrompt(chunk: Chunk): string;
