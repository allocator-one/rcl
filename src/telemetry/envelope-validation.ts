import { z } from 'zod';
import type { ArtifactBytes } from './envelope.js';
import { declareArtifacts } from './envelope.js';

/** Limits of the compatible Harness evidence protocol; validation never rewrites an envelope. */
export const MAX_ENVELOPE_BYTES = 4_000_000;
/** Per-field retained diagnostic character cap; Zod strings retain code-unit semantics. */
export const MAX_RETAINED_DIAGNOSTIC_CHARS = 2_000_000;
export const MAX_ARTIFACT_BYTES = 25_000_000;
export const INT4_MAX = 2_147_483_647;

export interface EvidenceDiagnostic { path: string; message: string }

const integer = z.number().int().min(0).max(INT4_MAX);
const digest = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\s\S])/);
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i);
const text = (max: number, required = false) => z.string().max(max)
  .refine((v) => !v.includes('\0') && (!required || v.trim().length > 0), 'Invalid text');
const short = text(500, true);
const timestamp = z.iso.datetime({ offset: true });
const map = z.record(z.string(), z.unknown()).refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 64_000, 'Object exceeds 64000 bytes');
const lane = z.enum(['blocking', 'secondary', 'async', 'verification']);
const optional = <T extends z.ZodType>(schema: T) => schema.nullish();

const target = z.object({
  kind: z.enum(['pr', 'patch', 'staged', 'working_tree', 'plan']),
  repo: optional(text(500, true).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![\s\S])/)),
  pr_number: optional(integer.min(1)), head_sha: optional(objectId), base_sha: optional(objectId),
  url: optional(text(20_000)), head_ref: optional(text(500)), base_ref: optional(text(500)),
  diff_sha256: digest, files: optional(integer), additions: optional(integer), deletions: optional(integer),
}).passthrough().superRefine((v, ctx) => {
  if (v.kind === 'pr') for (const key of ['repo', 'pr_number', 'head_sha'] as const) {
    if (v[key] == null) ctx.addIssue({ code: 'custom', path: [key], message: 'Required for a PR target' });
  }
});

const run = z.object({
  id: uuid, rcl_version: text(64, true), command: z.enum(['review', 'review-plan']), target,
  config_sha256: digest,
  roster: z.array(z.object({ model: short, role: short, provider: short, lane })).max(200),
  thresholds: optional(map), gating: optional(map),
  spec: optional(z.object({ source: short, sha256: digest })),
  context_files: z.array(z.object({ path: text(20_000, true), sha256: digest })).max(200),
  plan: optional(z.object({ focus: short })),
  runner: z.object({ kind: z.enum(['agent', 'ci', 'human']), agent: optional(text(500)), host: optional(text(500)), ci_run_id: optional(text(500)) }),
  started_at: timestamp, finished_at: timestamp, duration_ms: integer, ci_exit_code: integer,
  converge: optional(z.object({ target: short, round: optional(integer.min(1)), attempt: optional(integer.min(1)) })),
  provenance: z.enum(['live', 'backfill']).optional(),
  historical_source: optional(z.object({ original_run_id: uuid, report_sha256: digest }).strict()),
}).passthrough().superRefine((v, ctx) => {
  if (Date.parse(v.finished_at) < Date.parse(v.started_at)) ctx.addIssue({ code: 'custom', path: ['finished_at'], message: 'Finish precedes start' });
  if (v.historical_source && v.provenance !== 'backfill') ctx.addIssue({ code: 'custom', path: ['historical_source'], message: 'Historical source requires backfill provenance' });
});

const provenance = z.object({
  version: z.literal(1), source: z.enum(['parser', 'report_projection']), reason: z.literal('reversed_range'),
  original_start_line: integer, original_end_line: integer,
  report_json_sha256: digest.optional(),
}).strict().refine(p => p.source === 'parser' ? p.report_json_sha256 === undefined : p.report_json_sha256 !== undefined);

const finding = z.object({
  ref: text(32, true), identity_key: text(64, true), file: text(20_000, true),
  start_line: integer, end_line: integer, location_provenance: optional(provenance),
  severity: z.enum(['critical', 'important', 'minor', 'nitpick']), category: text(64, true),
  title: short, description: optional(text(20_000)), suggested_fix: optional(text(20_000)),
  consensus: optional(map), gating_reason: z.enum(['consensus', 'critical', 'verified', 'none']),
  verification_verdict: optional(text(32)), verification_model: optional(text(MAX_RETAINED_DIAGNOSTIC_CHARS)), verification_note: optional(text(MAX_RETAINED_DIAGNOSTIC_CHARS)),
  below_threshold: z.boolean(),
}).passthrough().superRefine((v, ctx) => {
  if (v.start_line > v.end_line) ctx.addIssue({ code: 'custom', path: ['end_line'], message: 'End precedes start' });
  const p = v.location_provenance;
  if (p && !(p.original_start_line > p.original_end_line && v.start_line === p.original_end_line && v.end_line === p.original_start_line)) {
    ctx.addIssue({ code: 'custom', path: ['location_provenance'], message: 'Provenance does not bind the normalized interval' });
  }
});

const call = z.object({
  model: short, role: short, provider: short, lane,
  chunk_index: optional(integer), status: z.enum(['success', 'timeout', 'error', 'parse_failed', 'canceled']),
  duration_ms: optional(integer), input_tokens: optional(integer), output_tokens: optional(integer), reasoning_tokens: optional(integer),
  dropped_findings: optional(integer), warnings: z.array(text(2_000)).max(50), error: optional(text(MAX_RETAINED_DIAGNOSTIC_CHARS)), async: z.boolean(),
}).passthrough();

const envelopeSchema = z.object({
  run, findings: z.array(finding).max(2_000), calls: z.array(call).max(500), stats: optional(map),
  artifacts_declared: z.array(z.object({ kind: z.enum(['report_json', 'report_md']), sha256: digest, bytes: integer.max(MAX_ARTIFACT_BYTES) })).min(1).max(2),
  delivery: z.object({ mode: z.enum(['direct', 'retried']), spooled_at: optional(text(500)) }),
}).passthrough().superRefine((v, ctx) => {
  if (new Set(v.findings.map((f) => f.ref)).size !== v.findings.length) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Duplicate finding reference' });
  const kinds = v.artifacts_declared.map((a) => a.kind);
  if (new Set(kinds).size !== kinds.length || !kinds.includes('report_json')) ctx.addIssue({ code: 'custom', path: ['artifacts_declared'], message: 'Require one report_json declaration and no duplicate kinds' });
  if (v.run.historical_source && v.run.historical_source.report_sha256 !== v.artifacts_declared.find((a) => a.kind === 'report_json')?.sha256) {
    ctx.addIssue({ code: 'custom', path: ['run', 'historical_source'], message: 'Historical source digest differs from the declared report' });
  }
  if (v.findings.some(f => f.location_provenance?.source === 'report_projection' && f.location_provenance.report_json_sha256 !== v.artifacts_declared.find(a => a.kind === 'report_json')?.sha256)) {
    ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Historical location projection must bind the original report digest' });
  }
});

/** Check actual serialized keys and values, including passthrough metadata. */
function hasUnpairedSurrogate(encoded: string): boolean {
  // The caller has already enforced the byte budget. Parsing avoids confusing
  // literal backslash-u text with JSON escapes and removes cycles/accessors.
  const pending: unknown[] = [JSON.parse(encoded)];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      // Unicode mode consumes valid pairs together, outside this code-unit range.
      if (/[\uD800-\uDFFF]/u.test(value)) return true;
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/[\uD800-\uDFFF]/u.test(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

/** Check the complete outgoing object and exact artifact declarations without coercion or row removal. */
export function validateRunEnvelope(envelope: unknown, artifacts?: ArtifactBytes): EvidenceDiagnostic[] {
  try {
    const encoded = JSON.stringify(envelope);
    if (encoded === undefined || Buffer.byteLength(encoded) > MAX_ENVELOPE_BYTES) return [{ path: 'envelope', message: 'Envelope exceeds 4000000 bytes or is not JSON' }];
    if (hasUnpairedSurrogate(encoded)) return [{ path: 'envelope', message: 'Envelope contains an unpaired UTF-16 surrogate' }];
    const result = envelopeSchema.safeParse(envelope);
    if (!result.success) return result.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join('.').slice(0, 200), message: issue.message.slice(0, 300),
    }));
    if (artifacts) {
      const expected = declareArtifacts(artifacts);
      if (expected.length !== result.data.artifacts_declared.length || expected.some((a) => !result.data.artifacts_declared.some((b) => a.kind === b.kind && a.sha256 === b.sha256 && a.bytes === b.bytes))) {
        return [{ path: 'artifacts_declared', message: 'Declarations do not match the exact retained artifact bytes' }];
      }
    }
    return [];
  } catch {
    return [{ path: 'envelope', message: 'Envelope cannot be represented as bounded JSON' }];
  }
}
