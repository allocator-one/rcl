import { z } from 'zod';
import type { ReviewResult } from '../../consensus/types.js';
import { stableFindingKey } from '../../consensus/finding-identity.js';
import { parseRepoName } from '../../resolver/github.js';
import { normalizeVerificationEvidence } from '../verification.js';
import { scrubDeep, scrubIdentifier, scrubSecrets } from '../scrub.js';
import type { RecoveryFinding } from './types.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[0-9a-f]{64}$/;
const FALLBACK_VERSIONS = new Set(['3.0.0', '3.1.0', '3.2.0', '3.3.0', '3.3.1', '3.4.0', '3.5.0', '3.6.0']);
const string = z.string().refine((value) => !value.includes('\0'));
const nonblank = string.refine((value) => value.trim().length > 0);
const integer = z.number().int().nonnegative().safe();
const number = z.number().nonnegative();
const timestamp = string.refine((value) => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)));
const hash = string.regex(SHA256);
const objectId = string.regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const verification = z.object({ verdict: nonblank.max(32), model: string.optional(), note: string.optional() });
const finding = z.object({
  id: string, file: nonblank, startLine: integer, endLine: integer,
  severity: z.enum(['critical', 'important', 'minor', 'nitpick']),
  category: nonblank, title: nonblank, description: string,
  suggestedFix: string.optional(), identity: nonblank.max(64).optional(),
  consensus: z.object({
    score: number, total: number, models: z.array(string), roles: z.array(string),
    crossRole: z.boolean(), crossModel: z.boolean(), elevated: z.boolean(),
  }).passthrough(),
  gating: z.object({ reason: z.enum(['consensus', 'critical', 'verified', 'none']), verification: verification.optional() }).optional(),
}).refine((value) => value.endLine >= value.startLine);
const review = z.object({
  model: nonblank, role: nonblank, provider: nonblank, findings: z.array(z.unknown()),
  durationMs: number, status: z.enum(['success', 'timeout', 'error', 'parse_failed', 'canceled']),
  error: string.optional(), droppedFindings: integer.optional(), warnings: z.array(string).optional(), async: z.boolean().optional(),
  usage: z.object({ inputTokens: integer.optional(), outputTokens: integer.optional(), reasoningTokens: integer.optional() }).optional(),
});
const target = z.object({
  kind: z.enum(['pr', 'patch', 'staged', 'working_tree', 'plan']),
  repo: nonblank.refine((value) => parseRepoName(value) !== null && value === value.trim()).optional(),
  pr_number: integer.positive().optional(), url: string.optional(), head_sha: objectId.optional(), base_sha: objectId.optional(),
  head_ref: string.optional(), base_ref: string.optional(), diff_sha256: hash, files: integer, additions: integer, deletions: integer,
}).refine((value) => value.kind !== 'pr' || (value.repo !== undefined && value.pr_number !== undefined));
const header = z.object({
  id: string.regex(UUID), rcl_version: nonblank.max(64), command: z.enum(['review', 'review-plan']), target,
  roster: z.array(z.object({ model: nonblank, role: nonblank, provider: nonblank, lane: z.enum(['blocking', 'secondary', 'async', 'verification']) })).max(200),
  config_sha256: hash,
  thresholds: z.object({ min_consensus_score: number, min_confidence: number, dedupe_line_window: integer, jaccard_threshold: number }),
  gating: z.object({ mode: z.enum(['all-findings', 'verified-consensus']), min_models: integer, verification_model: string.optional(), verification_timeout_ms: integer }),
  spec: z.object({ source: nonblank, sha256: hash }).optional(),
  context_files: z.array(z.object({ path: nonblank, sha256: hash })).max(200),
  plan: z.object({ focus: nonblank }).optional(),
  runner: z.object({ kind: z.enum(['agent', 'ci', 'human']), agent: string.optional(), ci_run_id: string.optional(), host: string.optional() }),
  started_at: timestamp, finished_at: timestamp, duration_ms: integer, ci_exit_code: integer,
  converge: z.object({ target: nonblank, round: integer.positive().optional(), attempt: integer.positive().optional() }).optional(),
  provenance: z.enum(['live', 'backfill']).optional(),
}).refine((value) => Date.parse(value.finished_at) >= Date.parse(value.started_at));
const modern = z.object({
  run: header, reviews: z.array(review).max(500), findings: z.array(finding).max(2000),
  belowThresholdFindings: z.array(finding).max(2000).optional(),
  stats: z.object({ totalReviews: integer, successfulReviews: integer, totalRawFindings: integer, totalDeduped: integer, belowThreshold: integer, durationMs: number }).passthrough(),
}).refine((value) => value.findings.length + (value.belowThresholdFindings?.length ?? 0) <= 2000);
const legacy = z.object({
  reviews: z.array(z.object({ model: nonblank }).passthrough()).max(500),
  findings: z.array(finding).max(2000), belowThresholdFindings: z.array(finding).max(2000).optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
}).refine((value) => value.findings.length + (value.belowThresholdFindings?.length ?? 0) <= 2000);

export type ParsedSource =
  | { format: 'modern'; report: ReviewResult & { run: NonNullable<ReviewResult['run']> }; refutations: RecoveryFinding[]; unsafe: boolean }
  | { format: 'legacy'; report: z.infer<typeof legacy>; refutations: RecoveryFinding[]; unsafe: boolean };

/** Validate original producer data before using its shape in a transport builder. */
export function parseSource(text: string): ParsedSource {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('invalid_or_incomplete_json'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not_report');
  if (!Array.isArray((raw as Record<string, unknown>)['reviews']) || !Array.isArray((raw as Record<string, unknown>)['findings'])) throw new Error('not_report');
  const hasHeader = Object.hasOwn(raw, 'run');
  const parsed = hasHeader ? modern.safeParse(raw) : legacy.safeParse(raw);
  if (!parsed.success) throw new Error('unsupported_report');
  const data = parsed.data;
  const version = 'run' in data ? data.run.rcl_version : undefined;
  const all = [...data.findings, ...(data.belowThresholdFindings ?? [])];
  if (hasHeader && all.some((f) => f.identity === undefined && !FALLBACK_VERSIONS.has(version!))) throw new Error('unsupported_identity_version');
  const refutations: RecoveryFinding[] = [];
  all.forEach((f, index) => {
    if (f.gating?.verification?.verdict !== 'refuted') return;
    const normalized = normalizeVerificationEvidence(f.gating.verification);
    refutations.push({
      ref: `f${String(index + 1).padStart(3, '0')}`,
      identity: hasHeader && f.identity !== undefined ? scrubIdentifier(f.identity, 64) : stableFindingKey(f),
      model: normalized.model ?? null, note: normalized.note ?? null,
    });
  });
  let unsafe = requiresArtifactRedaction(raw, []);
  if (!unsafe) {
    // JSON.parse discards duplicate keys. Walk every raw JSON string pair as
    // well, decoding escapes before applying the same path-sensitive policy.
    unsafe = rawArtifactNeedsRedaction(text);
  }
  // The transport builder consumes the validated fields above. Older report
  // versions may omit presentation-only consensus labels required by today's
  // ReviewResult type; recovery neither renders nor invents those labels.
  if (hasHeader) return { format: 'modern', report: data as unknown as ReviewResult & { run: NonNullable<ReviewResult['run']> }, refutations, unsafe };
  return { format: 'legacy', report: data as z.infer<typeof legacy>, refutations, unsafe };
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const RAW_PAIR = new RegExp(`(${JSON_STRING})\\s*:\\s*(${JSON_STRING})`, 'g');
const IDENTIFIER_KEY = /^(?:model|role|provider)$/;
const SENSITIVE_KEY = /api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|token|private[_-]?key/i;

/**
 * Inspect every raw JSON string assignment, including values JSON.parse drops
 * for duplicate keys. Identifier fields use the narrower identifier scrubber;
 * every other field is treated as free text.
 */
function rawArtifactNeedsRedaction(text: string): boolean {
  for (const match of text.matchAll(RAW_PAIR)) {
    let key: string;
    let value: string;
    try {
      key = JSON.parse(match[1]!);
      value = JSON.parse(match[2]!);
    } catch {
      return true;
    }
    if (scrubSecrets(key) !== key) return true;
    if (SENSITIVE_KEY.test(key) && scrubSecrets(JSON.stringify({ [key]: value })) !== JSON.stringify({ [key]: value })) return true;
    if ((IDENTIFIER_KEY.test(key) ? scrubIdentifier(value, Number.MAX_SAFE_INTEGER) : scrubSecrets(value)) !== value) return true;
  }
  return false;
}

/** Diagnostic evidence from an unsupported report is inventoried but never importable. */
export function unsupportedSourceDetails(text: string): Pick<import('./types.js').RecoverySource, 'run_id' | 'repo' | 'target' | 'refutations'> {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const run = raw['run'] && typeof raw['run'] === 'object' ? raw['run'] as Record<string, unknown> : {};
  const targetResult = target.safeParse(run['target']);
  const safeTarget = targetResult.success ? scrubDeep(targetResult.data) : null;
  const refutations: RecoveryFinding[] = [];
  if (Array.isArray(raw['findings']) && (raw['belowThresholdFindings'] === undefined || Array.isArray(raw['belowThresholdFindings']))) {
    const all = [...raw['findings'], ...((raw['belowThresholdFindings'] ?? []) as unknown[])];
    all.slice(0, 2000).forEach((rawFinding: unknown, i) => {
      if (!rawFinding || typeof rawFinding !== 'object') return;
      const f = rawFinding as Record<string, unknown>;
      const gate = f['gating'] && typeof f['gating'] === 'object' ? f['gating'] as Record<string, unknown> : {};
      const verified = gate['verification'] && typeof gate['verification'] === 'object' ? gate['verification'] as Record<string, unknown> : {};
      if (verified['verdict'] !== 'refuted') return;
      const normalized = normalizeVerificationEvidence(verified);
      refutations.push({ ref: `f${String(i + 1).padStart(3, '0')}`, identity: typeof f['identity'] === 'string' ? scrubIdentifier(f['identity'], 64) : null,
        model: normalized.model ?? null, note: normalized.note ?? null });
    });
  }
  return { run_id: typeof run['id'] === 'string' && UUID.test(run['id']) ? run['id'] : null, repo: safeTarget?.repo ?? null, target: safeTarget, refutations };
}

/** Inspect decoded values too: JSON escapes must not conceal a credential. */
function requiresArtifactRedaction(value: unknown, path: string[]): boolean {
  if (typeof value === 'string') {
    const location = path.join('.');
    const identifier = /^(?:run\.roster\.\d+|reviews\.\d+)\.(?:model|role|provider)$/.test(location) ||
      /^(?:findings|belowThresholdFindings)\.\d+\.gating\.verification\.model$/.test(location) || location === 'run.gating.verification_model';
    const changed = (identifier ? scrubIdentifier(value, Number.MAX_SAFE_INTEGER) : scrubSecrets(value)) !== value;
    return changed;
  }
  if (Array.isArray(value)) return value.some((item, i) => requiresArtifactRedaction(item, [...path, String(i)]));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => scrubSecrets(key) !== key ||
      // The existing scrubber recognizes sensitive JSON assignments, including
      // short values which are not independently token-shaped.
      (/api[_-]?key|token|secret|password|passwd|private[_-]?key/i.test(key) &&
        scrubSecrets(JSON.stringify({ [key]: item })) !== JSON.stringify({ [key]: item })) ||
      requiresArtifactRedaction(item, [...path, key]));
  }
  return false;
}
