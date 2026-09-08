/**
 * The read shapes Harness answers with (epic IO-12475, section 9): the gate
 * status of a pull request and one recorded run. Fields mirror the server's
 * serializer; anything rcl does not render is carried through untouched so
 * `--json` stays the API object.
 */

export const PROJECTION_STATUSES = [
  'none',
  'stale',
  'unverified',
  'inconclusive',
  'fixes_pending',
  'converged',
  'unresolved',
] as const;

export type ProjectionStatus = (typeof PROJECTION_STATUSES)[number];

export interface ActionableFinding {
  ref: string | null;
  identity_key: string | null;
  severity: string;
  gating_reason: string;
  file: string | null;
  start_line: number | null;
  end_line: number | null;
  title: string;
}

export interface ProjectionRound {
  id: string;
  url: string | null;
  tier: string;
  head_sha: string | null;
  converge_round: number | null;
  ordering_at: string | null;
  received_at: string | null;
}

export interface Projection {
  status: ProjectionStatus | string;
  head_sha: string | null;
  conclusive: boolean;
  run_id: string | null;
  run_url: string | null;
  actionable: ActionableFinding[];
  rounds: ProjectionRound[];
}

export interface PullRequestHead {
  sha: string | null;
  base_sha: string | null;
  source: string | null;
  updated_at: string | null;
  is_cross_repository: boolean;
  merged: boolean;
  reviewed_head_sha: string | null;
  merge_commit_sha: string | null;
  merged_at: string | null;
}

export interface GateDecision {
  decision: string;
  reviewed_head_sha: string | null;
  merge_commit_sha: string | null;
  merged_by_login: string | null;
  merged_at: string | null;
  source: string;
  decided_at: string | null;
  evidence: unknown;
}

export interface GateStatus {
  repo: string;
  pr_number: number;
  head: PullRequestHead | null;
  advisory: Projection;
  enforced: Projection;
  decision: GateDecision | null;
}

export interface RunFindingVerdict {
  verdict: string;
  reason?: string | null;
  round?: number | null;
}

export interface RunFinding {
  ref: string | null;
  identity_key: string | null;
  file: string | null;
  start_line: number | null;
  end_line: number | null;
  severity: string;
  category?: string | null;
  title: string;
  gating_reason: string | null;
  verification_verdict?: string | null;
  below_threshold?: boolean;
  /** Present once the server joins the triage verdict onto the finding (IO-12482). */
  verdict?: RunFindingVerdict | null;
}

export interface RunCall {
  model: string;
  role?: string | null;
  status: string;
  duration_ms?: number | null;
  error?: string | null;
}

export interface RunArtifact {
  kind: string;
  declared_sha256?: string | null;
  declared_bytes?: number | null;
  stored: boolean;
  url?: string | null;
}

export interface RunTarget {
  kind: string;
  repo?: string | null;
  pr_number?: number | null;
  url?: string | null;
  head_sha?: string | null;
  base_sha?: string | null;
  head_ref?: string | null;
  base_ref?: string | null;
  diff_sha256?: string | null;
  files?: number | null;
  additions?: number | null;
  deletions?: number | null;
}

export interface RunConverge {
  target: string;
  round?: number | null;
  attempt?: number | null;
}

export interface RunDetail {
  id: string;
  command?: string;
  url?: string | null;
  target: RunTarget;
  credential_kind?: string;
  tier?: string;
  head_verified?: string;
  repo_verified?: boolean;
  is_cross_repository?: boolean;
  provenance?: string;
  rcl_version?: string;
  runner?: Record<string, unknown> | null;
  converge?: RunConverge | null;
  ordering_at?: string | null;
  received_at?: string | null;
  roster?: unknown;
  stats?: Record<string, unknown> | null;
  artifacts?: RunArtifact[];
  findings: RunFinding[];
  calls: RunCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A projection as the server shapes it: a status string plus its rounds and actionable findings. */
export function isProjection(value: unknown): value is Projection {
  return isRecord(value) && typeof value['status'] === 'string' && Array.isArray(value['actionable']) && Array.isArray(value['rounds']);
}

/** A gate status naming the pull request that was asked for, with both projections. */
export function isGateStatus(value: unknown, number: number): value is GateStatus {
  return (
    isRecord(value) &&
    typeof value['repo'] === 'string' &&
    value['pr_number'] === number &&
    isProjection(value['advisory']) &&
    isProjection(value['enforced'])
  );
}

/** A run record naming the run that was asked for, with its findings and calls. */
export function isRunDetail(value: unknown, id: string): value is RunDetail {
  return (
    isRecord(value) &&
    value['id'] === id &&
    isRecord(value['target']) &&
    typeof value['target']['kind'] === 'string' &&
    Array.isArray(value['findings']) &&
    Array.isArray(value['calls'])
  );
}
