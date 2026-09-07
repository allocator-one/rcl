import { createHash } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { ResolvedGatingConfig } from '../consensus/gating.js';
import type { Diff, FileChange } from '../resolver/types.js';
import type { ReviewAssignment } from '../roles/types.js';
import { detectProvider } from '../roles/dispatcher.js';
import { uuidv7 } from './uuid.js';

/**
 * The self-describing report header (evidence ledger, epic IO-12475
 * section 5.1). Written INSIDE the report JSON as `ReviewResult.run`, so a
 * report on disk says which commit it reviewed, with which roster and
 * settings, without any network behavior. Field names are the wire contract
 * Harness ingests, hence snake_case here while the rest of the report keeps
 * its camelCase history.
 *
 * Every field is allow-listed by construction: the builder receives exactly
 * the values it records and never sees `process.env` or a config object it
 * would echo verbatim (the config becomes a digest; the GitHub token is
 * excluded from even that).
 */

export type TargetKind = 'pr' | 'patch' | 'staged' | 'working_tree' | 'plan';
export type RosterLane = 'blocking' | 'secondary' | 'async' | 'verification';
export type RunnerKind = 'agent' | 'ci' | 'human';
export type SpecSource = 'flag' | 'repo_file' | `harness_issue:${string}`;

export interface RosterEntry {
  model: string;
  role: string;
  provider: string;
  lane: RosterLane;
}

export interface RunTarget {
  kind: TargetKind;
  repo?: string;
  pr_number?: number;
  url?: string;
  head_sha?: string;
  base_sha?: string;
  head_ref?: string;
  base_ref?: string;
  /** SHA-256 over the canonical file/patch serialization (see diffDigest). */
  diff_sha256: string;
  files: number;
  additions: number;
  deletions: number;
}

export interface RunnerClaim {
  kind: RunnerKind;
  agent?: string;
  ci_run_id?: string;
  host?: string;
}

export interface ConvergeContext {
  target: string;
  round?: number;
  attempt?: number;
}

export interface RunHeader {
  /** Client UUIDv7 — the idempotency key for delivery retries. */
  id: string;
  rcl_version: string;
  command: 'review' | 'review-plan';
  target: RunTarget;
  roster: RosterEntry[];
  config_sha256: string;
  thresholds: {
    min_consensus_score: number;
    min_confidence: number;
    dedupe_line_window: number;
    jaccard_threshold: number;
  };
  gating: {
    mode: ResolvedGatingConfig['mode'];
    min_models: number;
    verification_model?: string;
    verification_timeout_ms: number;
  };
  spec?: { source: SpecSource; sha256: string };
  context_files: Array<{ path: string; sha256: string }>;
  /** review-plan only: the effective focus mode, which shapes the prompts. */
  plan?: { focus: string };
  /** Best-effort environment claim; the credential's user is the authority. */
  runner: RunnerClaim;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  /** Computed even without --ci so the gate verdict is recorded uniformly. */
  ci_exit_code: number;
  converge?: ConvergeContext;
}

export interface ResolvedThresholds {
  minConsensusScore: number;
  minConfidence: number;
  dedupeLineWindow: number;
  jaccardThreshold: number;
}

export interface RunHeaderInput {
  id?: string;
  rclVersion: string;
  command: RunHeader['command'];
  target: {
    kind: TargetKind;
    repo?: string;
    prNumber?: number;
    url?: string;
    headSha?: string;
    baseSha?: string;
    headRef?: string;
    baseRef?: string;
  };
  diff: Diff;
  roster: RosterEntry[];
  config: Config;
  thresholds: ResolvedThresholds;
  gating: ResolvedGatingConfig;
  spec?: { source: SpecSource; sha256: string };
  contextFiles?: Array<{ path: string; sha256: string }>;
  plan?: { focus: string };
  runner: RunnerClaim;
  startedAt: Date;
  finishedAt: Date;
  ciExitCode: number;
  converge?: ConvergeContext;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * JSON with object keys sorted at every level, so digests ignore key order.
 * Values JSON cannot express (undefined, functions, symbols) serialize as
 * `null` — the same as `JSON.stringify` does for them inside arrays — so the
 * result is always a string and never the bare `undefined` JSON.stringify
 * returns for a top-level non-value.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  const encoded: string | undefined = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

/**
 * Digest of what the council actually read: every file's name, status,
 * previous name and patch, sorted by filename so the value is independent of
 * listing order. The serialization is JSON — every field delimited and
 * escaped — so two distinct diffs cannot collide by sharing a separator
 * character in a filename or patch line. Uniform across PR, patch, git and
 * plan modes (PR mode has no raw diff).
 */
export function diffDigest(files: readonly FileChange[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
    .map((f) => ({
      filename: f.filename,
      status: f.status,
      previousFilename: f.previousFilename ?? null,
      patch: f.patch,
    }));
  return sha256Hex(stableStringify(canonical));
}

/**
 * The config fields the digest covers — an explicit allow-list, so a future
 * credential field is excluded until someone deliberately adds it here. Every
 * non-secret key of `ConfigSchema` is listed; `githubToken` is not.
 */
const DIGESTED_CONFIG_FIELDS = [
  'models',
  'secondaryModels',
  'asyncModels',
  'roles',
  'reviewers',
  'customRoles',
  'thresholds',
  'gating',
  'output',
  'timeout',
  'asyncTimeout',
  'quorumFraction',
  'maxRetries',
  'concurrency',
  'reasoningEffort',
  'context',
  'spec',
  'focus',
] as const satisfies ReadonlyArray<Exclude<keyof Config, 'githubToken'>>;

/** Digest of the allow-listed, resolved config fields (never a credential). */
export function configDigest(config: Config): string {
  const projection: Record<string, unknown> = {};
  for (const key of DIGESTED_CONFIG_FIELDS) {
    if (config[key] !== undefined) projection[key] = config[key];
  }
  return sha256Hex(stableStringify(projection));
}

export function buildRoster(input: {
  assignments: readonly ReviewAssignment[];
  asyncAssignments: readonly ReviewAssignment[];
  /** The blocking council's own models (`config.models`); others are secondary. */
  coreModels: readonly string[];
  /** Explicit --reviewer pairs are exact manual control: all blocking. */
  explicit?: boolean;
  gating: ResolvedGatingConfig;
}): RosterEntry[] {
  const core = new Set(input.coreModels);
  const roster: RosterEntry[] = input.assignments.map((a) => ({
    model: a.model,
    role: a.role.name,
    provider: a.provider,
    lane: input.explicit || core.has(a.model) ? 'blocking' : 'secondary',
  }));
  for (const a of input.asyncAssignments) {
    roster.push({ model: a.model, role: a.role.name, provider: a.provider, lane: 'async' });
  }
  if (input.gating.mode === 'verified-consensus' && input.gating.verificationModel) {
    roster.push({
      model: input.gating.verificationModel,
      role: 'verification',
      provider: detectProvider(input.gating.verificationModel),
      lane: 'verification',
    });
  }
  return roster;
}

const MAX_HOST_CHARS = 64;

/** Environment markers → agent name. Only these variables are ever read. */
const AGENT_MARKERS: ReadonlyArray<[envVar: string, agent: string]> = [
  ['CLAUDECODE', 'claude-code'],
  ['CLAUDE_CODE_ENTRYPOINT', 'claude-code'],
  ['CODEX_SANDBOX', 'codex'],
  ['CODEX_CI', 'codex'],
  ['CURSOR_AGENT', 'cursor'],
  ['GEMINI_CLI', 'gemini-cli'],
  ['AIDER_MODEL', 'aider'],
];

/**
 * Who appears to be driving this run. Recorded as a CLAIM: the server's
 * authoritative actor is the credential's user (and, for attested runs, the
 * OIDC claims). Pure: reads only the allow-listed variables of the `env`
 * it is handed.
 */
export function detectRunner(
  env: Readonly<Record<string, string | undefined>>,
  hostname: string
): RunnerClaim {
  const host = hostname.slice(0, MAX_HOST_CHARS);
  const isSet = (name: string): boolean => (env[name] ?? '').trim() !== '';
  if (isSet('GITHUB_ACTIONS')) {
    const runId = env['GITHUB_RUN_ID']?.trim();
    return { kind: 'ci', ...(runId ? { ci_run_id: runId } : {}), host };
  }
  for (const [envVar, agent] of AGENT_MARKERS) {
    if (isSet(envVar)) return { kind: 'agent', agent, host };
  }
  return { kind: 'human', host };
}

const HARNESS_ISSUE_SOURCE = /^harness_issue:[A-Z][A-Z0-9]*-\d+$/;

export function parseSpecSource(value: string): SpecSource {
  if (value === 'flag' || value === 'repo_file') return value;
  if (HARNESS_ISSUE_SOURCE.test(value)) return value as SpecSource;
  throw new Error(
    `Invalid --spec-source "${value}". Use flag, repo_file, or harness_issue:<ID> (e.g. harness_issue:IO-1234).`
  );
}

/** A full Git object id: SHA-1 (40 hex) or SHA-256 repositories (64 hex). */
export const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Exact-head binding needs the full object id; abbreviations are ambiguous. */
export function validateSha(value: string, flag: string): string {
  const sha = value.trim().toLowerCase();
  if (!FULL_OBJECT_ID.test(sha)) {
    throw new Error(
      `${flag} must be a full 40- or 64-character hex commit SHA, got "${value}".`
    );
  }
  return sha;
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${flag} must be a positive integer, got "${value}".`);
  }
  return n;
}

/**
 * The converge loop's context for this round. Flags win over the
 * `RCL_CONVERGE_*` environment the rcl-converge skill exports; without a
 * target there is no converge context at all.
 */
export function resolveConvergeContext(
  flags: { convergeTarget?: string; round?: string; attempt?: string },
  env: Readonly<Record<string, string | undefined>>
): ConvergeContext | undefined {
  const target = (flags.convergeTarget ?? env['RCL_CONVERGE_TARGET'] ?? '').trim();
  // Validate before deciding whether a context exists at all: a bad --round
  // must fail fast even when the target is missing, and a round or attempt
  // without a target is a mistake, not something to drop silently.
  const round = positiveInt(flags.round ?? env['RCL_CONVERGE_ROUND'], '--round');
  const attempt = positiveInt(flags.attempt ?? env['RCL_CONVERGE_ATTEMPT'], '--attempt');
  if (target === '') {
    if (round !== undefined || attempt !== undefined) {
      throw new Error(
        '--round / --attempt (or RCL_CONVERGE_ROUND / RCL_CONVERGE_ATTEMPT) need a converge target: pass --converge-target <key> or RCL_CONVERGE_TARGET.'
      );
    }
    return undefined;
  }
  return {
    target,
    ...(round !== undefined ? { round } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
  };
}

/** One human-readable phrase for status lines and the Markdown header. */
export function describeRunTarget(target: RunTarget): string {
  const where =
    target.kind === 'pr'
      ? `${target.repo ?? '?'}#${target.pr_number ?? '?'}`
      : target.kind === 'working_tree'
        ? 'working tree'
        : target.kind;
  const head = target.head_sha ? ` @ ${target.head_sha.slice(0, 12)}` : '';
  return `${where}${head} (diff ${target.diff_sha256.slice(0, 12)})`;
}

export function buildRunHeader(input: RunHeaderInput): RunHeader {
  const { target, diff } = input;
  return {
    id: input.id ?? uuidv7(),
    rcl_version: input.rclVersion,
    command: input.command,
    target: {
      kind: target.kind,
      ...(target.repo !== undefined ? { repo: target.repo } : {}),
      ...(target.prNumber !== undefined ? { pr_number: target.prNumber } : {}),
      ...(target.url !== undefined ? { url: target.url } : {}),
      ...(target.headSha !== undefined ? { head_sha: target.headSha } : {}),
      ...(target.baseSha !== undefined ? { base_sha: target.baseSha } : {}),
      ...(target.headRef !== undefined ? { head_ref: target.headRef } : {}),
      ...(target.baseRef !== undefined ? { base_ref: target.baseRef } : {}),
      diff_sha256: diffDigest(diff.files),
      files: diff.files.length,
      additions: diff.files.reduce((sum, f) => sum + f.additions, 0),
      deletions: diff.files.reduce((sum, f) => sum + f.deletions, 0),
    },
    roster: input.roster.map((r) => ({ ...r })),
    config_sha256: configDigest(input.config),
    thresholds: {
      min_consensus_score: input.thresholds.minConsensusScore,
      min_confidence: input.thresholds.minConfidence,
      dedupe_line_window: input.thresholds.dedupeLineWindow,
      jaccard_threshold: input.thresholds.jaccardThreshold,
    },
    gating: {
      mode: input.gating.mode,
      min_models: input.gating.minModels,
      ...(input.gating.verificationModel !== undefined
        ? { verification_model: input.gating.verificationModel }
        : {}),
      verification_timeout_ms: input.gating.verificationTimeoutMs,
    },
    ...(input.spec ? { spec: { source: input.spec.source, sha256: input.spec.sha256 } } : {}),
    context_files: (input.contextFiles ?? []).map((c) => ({ path: c.path, sha256: c.sha256 })),
    ...(input.plan ? { plan: { focus: input.plan.focus } } : {}),
    runner: { ...input.runner },
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    duration_ms: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    ci_exit_code: input.ciExitCode,
    ...(input.converge ? { converge: { ...input.converge } } : {}),
  };
}
