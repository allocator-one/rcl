export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
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
  mergeCommitSha?: string;
  url: string;
  labels: string[];
  draft: boolean;
}

export interface Diff {
  files: FileChange[];
  metadata?: PRMetadata;
  source: 'github' | 'local';
  rawDiff?: string;
}
