import type { RunEnvelope } from '../../src/telemetry/envelope.js';
const findingFields = ['ref','identity_key','file','start_line','end_line','location_provenance','claim_descriptor','severity','category','title','description','suggested_fix','consensus','gating_reason','verification_verdict','verification_model','verification_note','below_threshold'];
const callFields = ['model','role','provider','lane','chunk_index','status','duration_ms','input_tokens','output_tokens','reasoning_tokens','dropped_findings','warnings','error','async'];
const defaults = (row: object, keys: string[]) => Object.fromEntries(keys.map(k => [k, (row as Record<string, unknown>)[k] ?? null]));
/** Mirrors the independent backend serializer, including explicit nil optional fields. */
export function projection(e: RunEnvelope, stored: Record<string, string>) {
  return { ...e.run, provenance: e.run.provenance ?? 'live', historical_source: null, spec: e.run.spec ?? null, plan: e.run.plan ?? null,
    target: defaults(e.run.target, ['kind','repo','pr_number','url','head_sha','base_sha','head_ref','base_ref','diff_sha256','files','additions','deletions']),
    converge: e.run.converge ? { target: e.run.converge.target, round: e.run.converge.round ?? null, attempt: e.run.converge.attempt ?? null } : null,
    started_at: e.run.started_at.replace('.000Z','.000000Z'), finished_at: e.run.finished_at.replace('.000Z','.000000Z'),
    tier: 'asserted', credential_kind: 'api_token', stats: e.stats, delivery: e.delivery,
    findings: e.findings.map(f => ({ ...defaults(f, findingFields), verdict: null, claim_identity: null, identity_provenance: null, verification_provenance: null })),
    calls: e.calls.map(c => defaults(c, callFields)),
    artifacts: e.artifacts_declared.map(a => ({ kind: a.kind, declared_sha256: a.sha256, declared_bytes: a.bytes, stored: Object.hasOwn(stored, a.kind), url: null })) };
}
