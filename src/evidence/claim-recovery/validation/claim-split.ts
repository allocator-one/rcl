import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { claimDescriptorSchema, type ClaimDescriptor } from './claims.js';
import type { ConsensusFinding } from '../../../consensus/types.js';
import { findingGatingReason } from './obligations.js';
import { verifyNativeRecoveryLineage } from './native-state.js';
import type { WireEvent as OrdinaryWireEvent } from '../../../telemetry/events.js';
type WireEvent = Omit<OrdinaryWireEvent, 'kind'> & { kind: 'finding_claim_split' };
import { normalizeUrl } from './primitives.js';
import { scrubDeep, scrubIdentifier } from '../../../telemetry/scrub.js';
import { validSightingBinding } from './sighting.js';
import { isEventReceipt, type EventReceipt, type EventReceiptScope } from './receipts.js';
import { decodeOriginalReport } from '../../original-run/decode.js';
import { instant, object } from './primitives.js';
import { uuidSchema } from './primitives.js';

/** A journal supplies the ID/time once; preparation never mints or sends them. */
export interface ClaimSplitInput {
  scope: EventReceiptScope;
  target: string;
  eventId: string;
  occurredAt: string;
  nativeJson: string;
  /** Exact retained predecessor and legacy migration snapshots, when required. */
  nativeSourceJsons?: string[];
  reportJson: string;
  findingRef: string;
  previousIdentity: string;
  identity: string;
  descriptor: ClaimDescriptor;
  reason: string;
  expectedEventSequence: number;
  classificationId: string;
  correctionId?: string;
  sourceReceipts: EventReceipt[];
}

export interface PreparedClaimSplit {
  event: WireEvent;
  /** Recovery provenance, deliberately separate from producer sighting history. */
  source: {
    runId: string; target: string; round: number; reportSha256: string;
    findingRef: string; reportKey: string; previousIdentity: string;
    file: string; category: string; startLine: number; endLine: number;
    severity: ConsensusFinding['severity']; gating: string; belowThreshold: boolean;
  };
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const requireEvidence = (valid: unknown): void => { if (!valid) throw new Error('claim_split_source_conflict'); };
function original(raw: string): Record<string, unknown> {
  requireEvidence(typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') <= 64 * 1024 * 1024);
  const parsed = decodeOriginalReport(raw, { exactNumbers: true });
  requireEvidence(object(parsed.value) && parsed.transformations.length === 0);
  return parsed.value as Record<string, unknown>;
}

/**
 * Validate exact original membership and source receipts before journaling a
 * semantic assertion. Meaning is explicitly asserted by the caller; this does
 * not infer a verdict or claim that the new identity existed in an old review.
 * No clock, UUID generation, filesystem, network or native mutation occurs.
 */
export function prepareClaimSplit(input: ClaimSplitInput): PreparedClaimSplit {
  try { return prepare(input); }
  catch { throw new Error('claim_split_source_conflict'); }
}

function prepare(input: ClaimSplitInput): PreparedClaimSplit {
  const { scope } = input;
  requireEvidence(normalizeUrl(scope.base_url) === scope.base_url && uuidSchema.safeParse(scope.org_id).success &&
    uuidSchema.safeParse(scope.run_id).success && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repo) && positive(scope.pr_number));
  requireEvidence(uuidSchema.safeParse(input.eventId).success && input.target.trim() === input.target && input.target.length > 0 &&
    scrubIdentifier(input.target) === input.target && identity(input.previousIdentity) && identity(input.identity) &&
    input.previousIdentity !== input.identity && Number.isSafeInteger(input.expectedEventSequence) && input.expectedEventSequence >= 0);
  instant(input.occurredAt);
  requireEvidence(claimDescriptorSchema.safeParse(input.descriptor).success && typeof input.reason === 'string' &&
    input.reason.trim().length > 0 && [...input.reason].length <= 2000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.reason));
  const native = original(input.nativeJson); const report = original(input.reportJson);
  requireEvidence([1, 2, 3].includes(native.version as number) && native.target === input.target &&
    Array.isArray(native.rounds) && object(native.findings) && object(report.run));
  const lineage = native.version === 3 || input.nativeSourceJsons !== undefined
    ? verifyNativeRecoveryLineage(input.nativeJson, input.target, input.nativeSourceJsons) : undefined;
  requireEvidence(!lineage?.reservedIdentities.includes(input.identity));
  const run = report.run as Record<string, unknown>;
  requireEvidence(run.id === scope.run_id && object(run.target) && object(run.converge));
  const target = run.target as Record<string, unknown>; const converge = run.converge as Record<string, unknown>;
  requireEvidence(['pr', 'patch'].includes(target.kind as string) && target.repo === scope.repo && target.pr_number === scope.pr_number &&
    typeof target.head_sha === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(target.head_sha) &&
    converge.target === input.target && positive(converge.round));
  const round = converge.round as number;
  const rounds = (native.rounds as unknown[]).filter(r => object(r) && r.round === round);
  requireEvidence(rounds.length === 1 && (rounds[0] as Record<string, unknown>).runId === scope.run_id);
  const nativeFindings = native.findings as Record<string, unknown>;
  requireEvidence(Object.hasOwn(nativeFindings, input.previousIdentity) && object(nativeFindings[input.previousIdentity]) &&
    !Object.hasOwn(nativeFindings, input.identity));
  const prior = nativeFindings[input.previousIdentity] as Record<string, unknown>;
  requireEvidence(prior.key === input.previousIdentity);
  requireEvidence(Array.isArray(report.findings) && (report.belowThresholdFindings === undefined || Array.isArray(report.belowThresholdFindings)) &&
    /^f\d{3,}$/.test(input.findingRef));
  const kept = report.findings as unknown[];
  const all = [...kept, ...(report.belowThresholdFindings as unknown[] | undefined ?? [])];
  const index = Number(input.findingRef.slice(1)) - 1;
  requireEvidence(Number.isSafeInteger(index) && index >= 0 && input.findingRef === `f${String(index + 1).padStart(3, '0')}` && object(all[index]));
  const finding = all[index] as Record<string, unknown>;
  requireEvidence(typeof finding.identity === 'string' && finding.identity.length > 0 && finding.identity.length <= 64 &&
    typeof finding.file === 'string' && typeof finding.category === 'string' &&
    Number.isSafeInteger(finding.startLine) && Number.isSafeInteger(finding.endLine) &&
    (finding.startLine as number) >= 0 && (finding.endLine as number) >= (finding.startLine as number) &&
    ['critical', 'important', 'minor', 'nitpick'].includes(finding.severity as string));
  const reportSha256 = sha(input.reportJson);
  requireEvidence(!lineage?.state.recovery?.operations.some(operation => operation.anchors.some(anchor =>
    anchor.source.runId === scope.run_id && anchor.source.reportSha256 === reportSha256 &&
    anchor.source.findingRef === input.findingRef)));
  const retainedBinding = (rounds[0] as Record<string, unknown>).reportBinding;
  if (retainedBinding !== undefined) {
    requireEvidence(object(retainedBinding) && retainedBinding.runId === scope.run_id && retainedBinding.target === input.target &&
      retainedBinding.round === round && retainedBinding.reportSha256 === reportSha256 &&
      typeof retainedBinding.sourcePath === 'string' && retainedBinding.sourcePath.length > 0);
  }
  if (native.version === 2 || native.version === 3) {
    requireEvidence(Array.isArray(native.sightings));
    const members = (native.sightings as unknown[]).filter(s => object(s) && s.runId === scope.run_id && s.findingRef === input.findingRef);
    if (members.length > 0) {
      requireEvidence(members.length === 1);
      const member = members[0] as Record<string, unknown>;
      requireEvidence(member.target === input.target && member.round === round && member.reportSha256 === reportSha256 &&
        member.reportKey === finding.identity && member.canonicalIdentity === input.previousIdentity);
    } else {
      // Recovery does not invent producer sightings for legacy rounds. Prove
      // membership against the exact retained v1 origin and its unchanged round.
      const legacy = lineage?.legacy;
      requireEvidence(legacy && Object.hasOwn(legacy.findings, input.previousIdentity) &&
        legacy.findings[input.previousIdentity]?.key === input.previousIdentity &&
        legacy.rounds.some(record => record.round === round && isDeepStrictEqual(record, rounds[0])));
    }
  }

  const ids = [input.classificationId, ...(input.correctionId ? [input.correctionId] : [])];
  requireEvidence(new Set(ids).size === ids.length && ids.every(id => uuidSchema.safeParse(id).success) && !ids.includes(input.eventId) &&
    input.sourceReceipts.length === ids.length && new Set(input.sourceReceipts.map(r => r.id)).size === ids.length &&
    input.sourceReceipts.every(r => ids.includes(r.id) && isEventReceipt(r, scope) && r.converge_target === input.target && r.round === round));
  const classification = input.sourceReceipts.find(r => r.id === input.classificationId)!;
  requireEvidence(classification.kind === 'round_processed' && Array.isArray(classification.payload.identities));
  const snapshot = classification.payload;
  const declared = Object.hasOwn(snapshot, 'classification_version') || Object.hasOwn(snapshot, 'legacy_pending_identities');
  if (Object.hasOwn(snapshot, 'report_json_sha256')) requireEvidence(snapshot.report_json_sha256 === reportSha256);
  if (declared) {
    requireEvidence(snapshot.classification_version === 1 && snapshot.report_json_sha256 === reportSha256);
    const rows = snapshot.identities as unknown[];
    const refs = new Set<string>();
    requireEvidence(rows.length === all.length);
    for (const row of rows) {
      requireEvidence(object(row) && validSightingBinding(row));
      const member = row as Record<string, unknown>;
      const ref = member.finding_ref as string;
      const at = Number(ref.slice(1)) - 1;
      requireEvidence(Number.isSafeInteger(at) && at >= 0 && ref === `f${String(at + 1).padStart(3, '0')}` &&
        !refs.has(ref) && object(all[at]));
      refs.add(ref);
      const original = all[at] as Record<string, unknown>;
      requireEvidence(member.report_json_sha256 === reportSha256 && member.identity_key === original.identity &&
        isDeepStrictEqual(member.claim_descriptor, original.claimDescriptor) && Object.hasOwn(member, 'pending_round') &&
        (member.pending_round === null || positive(member.pending_round) && member.pending_round <= round));
    }
  }
  const mappings = (classification.payload.identities as unknown[]).filter(r => object(r) && r.identity_key === finding.identity);
  requireEvidence(mappings.length > 0 && mappings.every(m => object(m) && identity(m.matched_identity) &&
    ['new', 'repeat', 'suppressed', 'regating'].includes(m.status as string)));
  const previous = new Set(mappings.map(m => (m as Record<string, unknown>).matched_identity));
  requireEvidence(previous.size === 1);
  for (const raw of mappings) {
    const mapping = raw as Record<string, unknown>;
    if (mapping.version !== undefined || mapping.finding_ref !== undefined || mapping.report_json_sha256 !== undefined) {
      requireEvidence(mapping.version === 1 && mapping.finding_ref === input.findingRef && mapping.report_json_sha256 === reportSha256);
    }
  }
  if (input.correctionId) {
    const correction = input.sourceReceipts.find(r => r.id === input.correctionId)!;
    requireEvidence(correction.kind === 'finding_identity_corrected' && correction.payload.report_json_sha256 === reportSha256 &&
      correction.payload.finding_ref === input.findingRef && correction.payload.identity_key === finding.identity &&
      correction.payload.matched_identity === input.previousIdentity);
  } else requireEvidence(previous.has(input.previousIdentity));
  const payload = {
    version: 1, org_id: scope.org_id, repo: scope.repo, pr_number: scope.pr_number, head_sha: target.head_sha,
    report_json_sha256: reportSha256, finding_ref: input.findingRef, identity_key: finding.identity,
    previous_identity: input.previousIdentity, matched_identity: input.identity, classification: 'new',
    reason: input.reason, claim_descriptor: input.descriptor,
    native_evidence: { source: 'rcl_converge_state', state_version: native.version, state_sha256: sha(input.nativeJson) },
    source_event_ids: ids, expected_event_sequence: input.expectedEventSequence,
  };
  requireEvidence(isDeepStrictEqual(scrubDeep(payload), payload));
  // Copy the assertion so a caller cannot later mutate its descriptor through
  // a shared reference after serializing a journal checkpoint.
  const event: WireEvent = { id: input.eventId, kind: 'finding_claim_split', run_id: scope.run_id,
    converge_target: input.target, round, payload: structuredClone(payload), occurred_at: input.occurredAt };
  const belowThreshold = index >= kept.length;
  requireEvidence(finding.gating === undefined || object(finding.gating) && typeof finding.gating.reason === 'string');
  const gating = belowThreshold ? 'none' : findingGatingReason({ severity: finding.severity as string,
    ...(finding.gating === undefined ? {} : { gating: finding.gating as { reason: string } }) });
  return { event, source: { runId: scope.run_id, target: input.target, round, reportSha256,
    findingRef: input.findingRef, reportKey: finding.identity as string, previousIdentity: input.previousIdentity,
    file: finding.file as string, category: finding.category as string, startLine: finding.startLine as number, endLine: finding.endLine as number,
    severity: finding.severity as ConsensusFinding['severity'], gating, belowThreshold } };
}
