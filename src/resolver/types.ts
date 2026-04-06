export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
  language: string;
  previousFilename?: string;
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
