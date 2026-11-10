export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
  patch: string;
  language: string;
  previousFilename?: string;
  /**
   * Git blob id of the file after the change, when the source provides it
   * (GitHub does). It binds a patchless file — binary, or too large for a
   * patch — to its content in the diff digest.
   */
  blobSha?: string;
}

/**
 * Files whose patch was left out of the reviewed diff because the base
 * commit's `.gitattributes` marks them generated. The files themselves stay in
 * the diff, bound by blob id (see leaveOutGenerated).
 */
export interface LeftOutPaths {
  reason: 'linguist-generated';
  /** Commit whose root `.gitattributes` made the call (the PR's base tip). */
  ref: string;
  count: number;
  /** Sorted; at most the first 100, `count` carries the total. */
  paths: string[];
}

export interface PRMetadata {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  /**
   * Exact commit ids from `pulls.get` — the evidence ledger's head binding.
   * GitHub always returns both, so a PR is never bound without them.
   */
  headSha: string;
  baseSha: string;
  /** Actual comparison merge base; baseSha remains the target-branch tip. */
  mergeBaseSha?: string;
  mergeCommitSha?: string;
  url: string;
  labels: string[];
  draft: boolean;
  leftOut?: LeftOutPaths;
}

export interface Diff {
  files: FileChange[];
  metadata?: PRMetadata;
  source: 'github' | 'local';
  rawDiff?: string;
}
