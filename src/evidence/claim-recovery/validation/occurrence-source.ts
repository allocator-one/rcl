import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { decodeRecoveryOriginal as decodeOriginalReport } from './recovery-json.js';
import { claimDescriptorSchema } from './claims.js';
import { instant, object, uuidSchema } from './primitives.js';
import { isEventReceiptScope, isStoredEventReceipt, type StoredEventReceipt } from './receipts.js';
import { validSightingBinding } from './sighting.js';
import type { ClaimSeverity, OccurrenceContext, OccurrenceSource } from './occurrence-types.js';

export const hash = (raw: string): string => createHash('sha256').update(raw).digest('hex');
export const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v);
export const counter = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => counter(v) && v > 0 && v <= 2_147_483_647;
export function requireSource(valid: unknown): asserts valid { if (!valid) throw new Error('occurrence_source_conflict'); }
export function requireReason(value: unknown): asserts value is string {
  requireSource(typeof value === 'string' && value.trim().length > 0 && [...value].length <= 2000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !/[\uD800-\uDFFF]/u.test(value));
}

export interface OccurrenceMember {
  ref: string;
  raw: Record<string, unknown>;
  stored: Record<string, unknown>;
  mapping?: Record<string, unknown>;
  identity?: string;
  unresolvedReason?: 'classification-unavailable' | 'classification-ambiguous';
  correction?: StoredEventReceipt;
  severity: ClaimSeverity;
  gating: string;
}
export interface ValidatedOccurrenceSource {
  input: OccurrenceSource;
  digest: string;
  head: string;
  target: string;
  round: number;
  members: OccurrenceMember[];
}

/** Selected receipt content, not authentication or proof of inventory completeness. */
export function receiptFor(receipt: StoredEventReceipt, source: ValidatedOccurrenceSource): void {
  requireSource(isStoredEventReceipt(receipt, source.input.scope) && receipt.converge_target === source.target &&
    receipt.round === source.round);
  const converge = source.input.storedRun.converge as Record<string, unknown>;
  if (receipt.attempt !== null) requireSource(receipt.attempt === converge.attempt);
}

/** Sequence is per run; timestamps retain microseconds and never use client occurred_at for acceptance order. */
export function before(first: StoredEventReceipt, last: StoredEventReceipt): void {
  requireSource(first.run_id === last.run_id && first.sequence < last.sequence &&
    BigInt(instant(first.received_at)) <= BigInt(instant(last.received_at)));
}

/**
 * Bind supplied original bytes to every stored positional finding and selected
 * classification. Unsupported headerless/reversed-range sources refuse; this
 * helper neither normalizes their history nor claims to fetch/authenticate it.
 */
export function validateOccurrenceSource(input: OccurrenceSource): ValidatedOccurrenceSource {
  requireSource(isEventReceiptScope(input.scope) && input.scope.repo.length <= 200 && positive(input.scope.pr_number) &&
    typeof input.reportJson === 'string' && Buffer.byteLength(input.reportJson) <= 64 * 1024 * 1024);
  const decoded = decodeOriginalReport(input.reportJson, { exactNumbers: true, originalProse: 'control-code-units-v1' });
  requireSource(object(decoded.value));
  const report = decoded.value; const run = report.run; const stored = input.storedRun;
  requireSource(object(run) && object(stored) && run.id === input.scope.run_id && stored.id === run.id &&
    object(run.target) && object(stored.target) && object(run.converge) && object(stored.converge));
  const target = run.target; const storedTarget = stored.target;
  const converge = run.converge; const storedConverge = stored.converge;
  requireSource(['pr', 'patch'].includes(run.target.kind as string) && run.target.repo === input.scope.repo &&
    run.target.pr_number === input.scope.pr_number && typeof run.target.head_sha === 'string' &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(run.target.head_sha) && !/^0+$/.test(run.target.head_sha) &&
    ['kind', 'repo', 'pr_number', 'head_sha', 'base_sha', 'diff_sha256'].every(field =>
      isDeepStrictEqual(target[field] ?? null, storedTarget[field] ?? null)) &&
    ['rcl_version', 'command'].every(field => typeof run[field] === 'string' && run[field] === stored[field]));
  requireSource(typeof run.converge.target === 'string' && run.converge.target.trim() === run.converge.target &&
    run.converge.target.length > 0 && run.converge.target.length <= 500 && positive(run.converge.round) &&
    ['target', 'round', 'attempt'].every(field => isDeepStrictEqual(converge[field] ?? null, storedConverge[field] ?? null)));
  const digest = hash(input.reportJson);
  requireSource(Array.isArray(stored.artifacts));
  const originals = stored.artifacts.filter(a => object(a) && a.kind === 'report_json');
  requireSource(originals.length === 1 && originals[0].declared_sha256 === digest && originals[0].stored === true &&
    originals[0].declared_bytes === Buffer.byteLength(input.reportJson));
  requireSource(Array.isArray(report.findings) && (report.belowThresholdFindings === undefined || Array.isArray(report.belowThresholdFindings)));
  const kept = report.findings; const all = [...kept, ...(report.belowThresholdFindings as unknown[] | undefined ?? [])];
  requireSource(all.length <= 2000 && Array.isArray(stored.findings) && stored.findings.length === all.length);
  const storedMembers = new Map<string, Record<string, unknown>>();
  for (const member of stored.findings) {
    requireSource(object(member) && typeof member.ref === 'string' && !storedMembers.has(member.ref));
    storedMembers.set(member.ref, member);
  }
  const out: ValidatedOccurrenceSource = { input, digest, head: run.target.head_sha,
    target: run.converge.target, round: run.converge.round, members: [] };
  receiptFor(input.classification, out);
  requireSource(input.classification.kind === 'round_processed' && Array.isArray(input.classification.payload.identities));
  const payload = input.classification.payload;
  const rows = payload.identities as unknown[];
  const declared = Object.hasOwn(payload, 'classification_version') || Object.hasOwn(payload, 'legacy_pending_identities');
  if (Object.hasOwn(payload, 'report_json_sha256')) requireSource(payload.report_json_sha256 === digest);
  if (declared) requireSource(payload.classification_version === 1 && payload.report_json_sha256 === digest && rows.length === all.length);
  if (Object.hasOwn(payload, 'legacy_pending_identities')) {
    const ids = payload.legacy_pending_identities;
    requireSource(Array.isArray(ids) && ids.length > 0 && ids.length <= 2000 && ids.every(key) &&
      isDeepStrictEqual(ids, [...new Set(ids)].sort()));
  }
  const boundRefs = new Set<string>();
  for (const row of rows) {
    requireSource(object(row) && typeof row.identity_key === 'string' && key(row.matched_identity) &&
      ['new', 'repeat', 'suppressed', 'regating'].includes(row.status as string) &&
      all.some(member => object(member) && member.identity === row.identity_key));
    const bound = declared || ['version', 'finding_ref', 'report_json_sha256'].some(field => Object.hasOwn(row, field));
    if (bound) {
      requireSource(validSightingBinding(row) && Object.hasOwn(row, 'pending_round') &&
        (row.pending_round === null || positive(row.pending_round) && row.pending_round <= out.round));
      const ref = row.finding_ref as string; const index = Number(ref.slice(1)) - 1;
      requireSource(Number.isSafeInteger(index) && ref === `f${String(index + 1).padStart(3, '0')}` && !boundRefs.has(ref) &&
        object(all[index]) && row.identity_key === all[index].identity && row.report_json_sha256 === digest &&
        isDeepStrictEqual(row.claim_descriptor, all[index].claimDescriptor));
      boundRefs.add(ref);
    }
  }
  for (const [index, raw] of all.entries()) {
    const ref = `f${String(index + 1).padStart(3, '0')}`; const member = storedMembers.get(ref);
    requireSource(object(raw) && member && typeof raw.identity === 'string' && raw.identity.length > 0 && raw.identity.length <= 64 &&
      typeof raw.file === 'string' && typeof raw.category === 'string' && counter(raw.startLine) && counter(raw.endLine) && raw.startLine <= raw.endLine &&
      ['critical', 'important', 'minor', 'nitpick'].includes(raw.severity as string) &&
      (raw.gating === undefined || object(raw.gating) && typeof raw.gating.reason === 'string'));
    const gating = object(raw.gating) ? raw.gating : {};
    requireSource(member.identity_key === raw.identity && member.file === raw.file && member.category === raw.category &&
      member.start_line === raw.startLine && member.end_line === raw.endLine && member.severity === raw.severity &&
      member.below_threshold === (index >= kept.length) && member.gating_reason === (gating.reason ?? 'none') &&
      member.verification_verdict === (object(gating.verification) ? gating.verification.verdict ?? null : null) &&
      Object.hasOwn(member, 'claim_descriptor') && isDeepStrictEqual(member.claim_descriptor, raw.claimDescriptor ?? null));
    if (raw.claimDescriptor !== undefined) requireSource(claimDescriptorSchema.safeParse(raw.claimDescriptor).success);
    const mappings = (rows as Record<string, unknown>[]).filter(row => row.identity_key === raw.identity &&
      (row.finding_ref === undefined || row.finding_ref === ref));
    const unresolvedReason = mappings.length === 0 ? 'classification-unavailable' :
      new Set(mappings.map(m => m.matched_identity)).size !== 1 ? 'classification-ambiguous' : undefined;
    // Released unmarked classifications may cover kept findings only. Preserve
    // every original appendix member without inventing its native association.
    // Declared snapshots, in contrast, promise complete positional membership.
    requireSource(!declared || unresolvedReason === undefined);
    if (mappings.some(row => row.claim_descriptor !== undefined)) requireSource(mappings.every(row =>
      isDeepStrictEqual(row.claim_descriptor, raw.claimDescriptor)));
    out.members.push({ ref, raw, stored: member,
      ...(unresolvedReason ? { unresolvedReason } : { mapping: mappings[0], identity: mappings[0].matched_identity as string }),
      severity: raw.severity as ClaimSeverity, gating: index >= kept.length ? 'none' : (gating.reason as string | undefined ??
        (['critical', 'important'].includes(raw.severity as string) ? 'legacy-blocking' : 'none')) });
  }
  requireSource(Array.isArray(input.corrections) && input.corrections.length <= all.length);
  const corrected = new Set<string>(); const ids = new Set([input.classification.id]);
  for (const receipt of input.corrections) {
    receiptFor(receipt, out); before(input.classification, receipt);
    const p = receipt.payload; const member = out.members.find(m => m.ref === p.finding_ref);
    requireSource(receipt.kind === 'finding_identity_corrected' && uuidSchema.safeParse(receipt.actor_user_id).success &&
      !ids.has(receipt.id) && member && !corrected.has(member.ref) && p.report_json_sha256 === digest &&
      p.identity_key === member.raw.identity && key(p.matched_identity));
    for (const [field, expected] of Object.entries({ org_id: input.scope.org_id, repo: input.scope.repo,
      pr_number: input.scope.pr_number, head_sha: out.head })) {
      requireSource(p[field] === expected);
    }
    member.identity = p.matched_identity; member.correction = receipt;
    corrected.add(member.ref); ids.add(receipt.id);
  }
  return out;
}

export function contextFor(context: OccurrenceContext, source: ValidatedOccurrenceSource, actor: string): void {
  requireSource(isDeepStrictEqual(context.scope, source.input.scope) && context.target === source.target && context.round === source.round &&
    context.headSha === source.head && context.reportSha256 === source.digest && counter(context.eventSequence) &&
    uuidSchema.safeParse(actor).success && context.actorUserId === actor);
  for (const receipt of [source.input.classification, ...source.input.corrections]) requireSource(receipt.sequence <= context.eventSequence);
}

export function sameTarget(a: ValidatedOccurrenceSource, b: ValidatedOccurrenceSource): void {
  requireSource(a.input.scope.base_url === b.input.scope.base_url && a.input.scope.org_id === b.input.scope.org_id &&
    a.input.scope.repo.toLowerCase() === b.input.scope.repo.toLowerCase() && a.input.scope.pr_number === b.input.scope.pr_number && a.target === b.target);
}
