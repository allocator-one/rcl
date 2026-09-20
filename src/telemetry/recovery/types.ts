import type { RunTarget } from '../../report/run-header.js';

export interface RecoveryFinding {
  ref: string;
  identity: string | null;
  model: string | null;
  note: string | null;
}

export interface RepositoryProof {
  worktree: string;
  repo: string;
  reference_path?: string;
  reference_sha256?: string;
}

export interface RecoverySource {
  sha256: string;
  bytes: number;
  paths: string[];
  mtime: string;
  format: 'modern' | 'legacy' | 'unknown';
  run_id: string | null;
  repo: string | null;
  target: RunTarget | null;
  repository_proofs: RepositoryProof[];
  state: 'ready' | 'no_refutations' | 'synthetic' | 'unbound' | 'unsafe' | 'conflict' | 'unsupported';
  reason?: string;
  refutations: RecoveryFinding[];
}

export interface DiscoveryIssue {
  path: string;
  reason: string;
}

export interface RecoveryInventory {
  kind: 'rcl-refutation-inventory';
  version: 1;
  created_at: string;
  coverage: {
    roots: string[];
    worktrees: RepositoryProof[];
    git_common_dirs: string[];
    references: string[];
    issues: DiscoveryIssue[];
    excluded_sha256: string[];
    outbox: Array<{ path: string; sha256: string; run_id: string | null; report_sha256: string | null; report_path: string }>;
  };
  reports: RecoverySource[];
}

export interface DiscoveryOptions {
  roots?: string[];
  excludeSha256?: string[];
  progress?: (message: string) => void;
}

export interface RecoveryPlan {
  sha256: string;
  run_id: string | null;
  action: 'import_history' | 'upload_and_recover' | 'recover' | 'already_present' | 'skip' | 'conflict' | 'unavailable';
  reason?: string;
  delivery?: { report_sha256: string; report_bytes: number };
  server?: { exists: boolean; provenance: 'live' | 'backfill' | null; artifact_stored: boolean; report_sha256: string | null; report_bytes: number | null };
  findings: Array<RecoveryFinding & { state: 'missing' | 'already_present' | 'original_note_absent' | 'conflict' }>;
}

export interface RecoveryManifest {
  kind: 'rcl-refutation-recovery';
  version: 1;
  created_at: string;
  destination: { base_url: string; org_id: string };
  inventory: RecoveryInventory;
  plans: RecoveryPlan[];
}

export interface RecoveryOutcome {
  kind: 'rcl-refutation-recovery-outcome';
  version: 1;
  created_at: string;
  destination: RecoveryManifest['destination'];
  writes: { runs: number; artifacts: number };
  server_recovery_run_ids: string[];
  reports: RecoveryPlan[];
}
