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
  artifacts?: RunArtifact[] | null;
  findings: RunFinding[];
  calls: RunCall[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function nullableRecord(value: unknown): boolean {
  return value === null || value === undefined || isRecord(value);
}

function optional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === null || value === undefined || check(value);
}

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';

/** The pull request head: absent, or a record whose flags the renderer reads are booleans and whose shas are strings. */
function isHead(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (isRecord(value) &&
      optional(value['sha'], isString) &&
      optional(value['merge_commit_sha'], isString) &&
      optional(value['source'], isString) &&
      optional(value['merged'], isBoolean) &&
      optional(value['is_cross_repository'], isBoolean))
  );
}

/**
 * A projection as the server shapes it: status and conclusiveness, every
 * round a record with its id and tier, every actionable finding a record with
 * the fields the renderer prints. Checked to the depth the renderer
 * dereferences, so a malformed answer is refused (exit 3) and never thrown.
 */
export function isProjection(value: unknown): value is Projection {
  return (
    isRecord(value) &&
    isString(value['status']) &&
    typeof value['conclusive'] === 'boolean' &&
    isRecordArray(value['actionable']) &&
    value['actionable'].every((f) => isString(f['severity']) && isString(f['gating_reason']) && isString(f['title'])) &&
    isRecordArray(value['rounds']) &&
    value['rounds'].every((r) => isString(r['id']) && isString(r['tier']))
  );
}

/** A gate status about the pull request that was asked for — repository (case-insensitively) and number — with both projections. */
export function isGateStatus(value: unknown, repo: string, number: number): value is GateStatus {
  return (
    isRecord(value) &&
    isString(value['repo']) &&
    value['repo'].toLowerCase() === repo.toLowerCase() &&
    value['pr_number'] === number &&
    isHead(value['head']) &&
    nullableRecord(value['decision']) &&
    isProjection(value['advisory']) &&
    isProjection(value['enforced'])
  );
}

/** A run record about the run that was asked for (UUID text is case-insensitive), with a target, and findings, calls and artifacts shaped as the renderer reads them. */
export function isRunDetail(value: unknown, id: string): value is RunDetail {
  return (
    isRecord(value) &&
    isString(value['id']) &&
    value['id'].toLowerCase() === id.toLowerCase() &&
    isRecord(value['target']) &&
    isString(value['target']['kind']) &&
    nullableRecord(value['runner']) &&
    nullableRecord(value['stats']) &&
    (value['converge'] === null || value['converge'] === undefined || (isRecord(value['converge']) && isString(value['converge']['target']))) &&
    (value['artifacts'] === undefined ||
      value['artifacts'] === null ||
      (isRecordArray(value['artifacts']) &&
        value['artifacts'].every((a) => isString(a['kind']) && isBoolean(a['stored']) && optional(a['url'], isString)))) &&
    isRecordArray(value['findings']) &&
    value['findings'].every((f) => isString(f['severity']) && isString(f['title']) && nullableRecord(f['verdict'])) &&
    isRecordArray(value['calls']) &&
    value['calls'].every((c) => isString(c['model']) && isString(c['status']))
  );
}
