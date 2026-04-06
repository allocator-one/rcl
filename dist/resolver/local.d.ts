import type { Diff } from './types.js';
export declare function loadLocalDiff(filePath: string): Promise<Diff>;
export declare function parseDiffFromString(diffText: string): Diff;
