import type { Diff } from './types.js';
export interface GitHubTarget {
    owner: string;
    repo: string;
    number: number;
}
export declare function parseGitHubTarget(target: string): GitHubTarget;
export declare function fetchPRDiff(target: GitHubTarget, token?: string): Promise<Diff>;
