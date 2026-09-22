import { isDeepStrictEqual } from 'node:util';
import { stableStringify } from '../../report/run-header.js';
import { HarnessSink, type SinkOutcome } from '../../telemetry/sink.js';
import { sha256 } from '../../telemetry/recovery/files.js';
import type { PreparedOriginal } from './source.js';
import { uuidSchema } from './source.js';
export interface Destination { base_url: string; org_id: string }
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export const missing = (r: SinkOutcome<unknown>) => r.kind === 'rejected' && r.httpStatus === 404 && r.error === 'not_found';
export function requireOk<T>(result: SinkOutcome<T>, label: string): T {
  if (result.kind !== 'ok') throw new Error(`${label}_${result.kind}`);
  return result.value;
}
export async function destination(sink: HarnessSink): Promise<Destination> {
  if (sink.credentialSource === 'attest') throw new Error('unsupported_attested_recovery');
  const outcome = await sink.getJson('/api/v1/reviews/runs?page_size=1', (data, meta) => {
    if (!Array.isArray(data) || !object(meta) || !uuidSchema.safeParse(meta.org_id).success || meta.original_report_recovery_version !== 1 || meta.evidence_protocol_version !== 2) return null;
    return { base_url: sink.baseUrl, org_id: meta.org_id as string };
  });
  return requireOk(outcome, 'recovery_capability_or_destination');
}
/** Backend timestamps retain microseconds, unlike Date's millisecond comparison. */
export function instant(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_receipt_timestamp');
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) throw new Error('invalid_receipt_timestamp');
  const seconds = Date.parse(match[1]! + match[3]!);
  if (!Number.isFinite(seconds)) throw new Error('invalid_receipt_timestamp');
  return (BigInt(seconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'))).toString();
}
const pick = (x: Record<string, unknown>, keys: string[], defaults: Record<string, unknown> = {}) => Object.fromEntries(keys.map(k => [k, x[k] === undefined ? defaults[k] ?? null : x[k]]));
const required = (x: Record<string, unknown>, keys: string[]) => keys.every(k => Object.hasOwn(x, k));
const targetKeys = ['kind','repo','pr_number','url','head_sha','base_sha','head_ref','base_ref','diff_sha256','files','additions','deletions'];
const headerKeys = ['id','command','rcl_version','config_sha256','roster','thresholds','gating','spec','context_files','plan','runner','duration_ms','ci_exit_code','provenance','historical_source'];
const findingKeys = ['ref','identity_key','file','start_line','end_line','location_provenance','claim_descriptor','severity','category','title','description','suggested_fix','consensus','gating_reason','verification_verdict','verification_model','verification_note','below_threshold'];
const callKeys = ['model','role','provider','lane','chunk_index','status','duration_ms','input_tokens','output_tokens','reasoning_tokens','dropped_findings','warnings','error','async'];
function converge(v: unknown): unknown { return object(v) ? pick(v, ['target','round','attempt']) : v ?? null; }
/** Compare every persisted immutable field; server-derived judgments are intentionally not receipts. */
export function matchesOriginalRun(raw: unknown, prepared: PreparedOriginal): boolean {
  try {
    if (!object(raw) || !required(raw, [...headerKeys,'target','converge','started_at','finished_at','stats','delivery','findings','calls','artifacts','tier','credential_kind'])) return false;
    if (raw.tier !== 'asserted' || !['cli','api_token'].includes(raw.credential_kind as string)) return false;
    const expected = prepared.envelope;
    if (!isDeepStrictEqual(pick(raw, headerKeys), pick(expected.run as unknown as Record<string, unknown>, headerKeys, { provenance: 'live' }))) return false;
    if (!object(raw.target) || !required(raw.target, targetKeys) || !isDeepStrictEqual(pick(raw.target, targetKeys), pick(expected.run.target as unknown as Record<string, unknown>, targetKeys))) return false;
    if (!isDeepStrictEqual(converge(raw.converge), converge(expected.run.converge)) || instant(raw.started_at) !== instant(expected.run.started_at) || instant(raw.finished_at) !== instant(expected.run.finished_at)) return false;
    if (!isDeepStrictEqual(raw.stats, expected.stats) || !isDeepStrictEqual(raw.delivery, expected.delivery)) return false;
    if (!Array.isArray(raw.findings) || raw.findings.length !== expected.findings.length || raw.findings.some(f => !object(f) || !required(f, findingKeys))) return false;
    if (new Set(raw.findings.map(f => (f as Record<string, unknown>).ref)).size !== raw.findings.length) return false;
    if (!isDeepStrictEqual(raw.findings.map(f => pick(f as Record<string, unknown>, findingKeys)), expected.findings.map(f => pick(f as unknown as Record<string, unknown>, findingKeys)))) return false;
    if (!Array.isArray(raw.calls) || raw.calls.length !== expected.calls.length || raw.calls.some(c => !object(c) || !required(c, callKeys))) return false;
    if (!isDeepStrictEqual(raw.calls.map(c => pick(c as Record<string, unknown>, callKeys)), expected.calls.map(c => pick(c as unknown as Record<string, unknown>, callKeys)))) return false;
    if (!Array.isArray(raw.artifacts) || raw.artifacts.length !== expected.artifacts_declared.length || raw.artifacts.some(a => !object(a) || !required(a, ['kind','declared_sha256','declared_bytes','stored']) || typeof a.stored !== 'boolean')) return false;
    return isDeepStrictEqual(raw.artifacts.map(a => pick(a as Record<string, unknown>, ['kind','declared_sha256','declared_bytes'])), expected.artifacts_declared.map(a => ({ kind: a.kind, declared_sha256: a.sha256, declared_bytes: a.bytes })));
  } catch { return false; }
}
export async function readOriginalRun(sink: HarnessSink, expected: Destination, prepared: PreparedOriginal): Promise<{ exists: false } | { exists: true; projection_sha256: string; raw: Record<string, unknown> }> {
  const result = await sink.getJson(`/api/v1/reviews/runs/${encodeURIComponent(prepared.selection.run)}`, (data, meta) => {
    if (!object(data) || !object(meta) || meta.org_id !== expected.org_id || meta.original_report_recovery_version !== 1 || meta.evidence_protocol_version !== 2) return null;
    return data;
  });
  if (missing(result)) return { exists: false };
  const raw = requireOk(result, 'run_read');
  if (!matchesOriginalRun(raw, prepared)) throw new Error('existing_run_full_projection_conflict');
  return { exists: true, raw, projection_sha256: sha256(stableStringify(raw)) };
}
export async function readOriginalArtifacts(sink: HarnessSink, prepared: PreparedOriginal): Promise<Record<string, 'missing' | 'verified'>> {
  const states: Record<string, 'missing' | 'verified'> = {};
  for (const a of prepared.envelope.artifacts_declared) {
    const read = await sink.getArtifact(prepared.selection.run, a.kind, a.bytes);
    if (missing(read)) { states[a.kind] = 'missing'; continue; }
    const receipt = requireOk(read, 'artifact_read');
    if (receipt.sha256 !== a.sha256 || receipt.bytes.length !== a.bytes || sha256(receipt.bytes) !== a.sha256) throw new Error('original_artifact_conflict');
    states[a.kind] = 'verified';
  }
  return states;
}
