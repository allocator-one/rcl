import { prepareClaimSplit } from './claim-split.js';
import { isDeepStrictEqual } from 'node:util';
import { matchesPreparedEventReceipt, type StoredEventReceipt } from './receipts.js';
import { claimDescriptorSchema } from './claims.js';
import { validateRetainedNativeEvidence } from './native-state.js';
import { instant, object, uuidSchema } from './primitives.js';
import { scrubDeep } from '../../../telemetry/scrub.js';
import { before, contextFor, counter, key, receiptFor, requireReason, requireSource, sameTarget, validateOccurrenceSource,
  type OccurrenceMember, type ValidatedOccurrenceSource } from './occurrence-source.js';
import type { ClaimDispositionInput, ObligationTransferInput, PreparedOccurrenceEvent, ReceiptAttribution, RecoveryOccurrenceEvent } from './occurrence-types.js';

function attribution(receipt: StoredEventReceipt): ReceiptAttribution {
  return { eventId: receipt.id, actorUserId: receipt.actor_user_id, occurredAt: receipt.occurred_at,
    receivedAt: receipt.received_at, sequence: receipt.sequence };
}

function split(input: ClaimDispositionInput | ObligationTransferInput) {
  requireSource(uuidSchema.safeParse(input.eventId).success && uuidSchema.safeParse(input.actorUserId).success);
  instant(input.occurredAt); requireReason(input.reason);
  const source = validateOccurrenceSource(input.split.source);
  contextFor(input.sourceContext, source, input.actorUserId);
  const selection = input.split.selection;
  requireSource(isDeepStrictEqual(source.input.scope, selection.scope) && source.input.reportJson === selection.reportJson &&
    selection.target === source.target && selection.classificationId === source.input.classification.id &&
    input.split.native.sourceJson === selection.nativeJson && input.split.native.target === selection.target &&
    isDeepStrictEqual(input.split.native.nativeSourceJsons ?? [], selection.nativeSourceJsons ?? []) &&
    isDeepStrictEqual(input.split.native.recoveryMaterials ?? [], selection.recoveryMaterials ?? []));
  validateRetainedNativeEvidence(input.split.native);
  const prepared = prepareClaimSplit(input.split.selection);
  const member = source.members.find(m => m.ref === selection.findingRef);
  requireSource(member && !member.unresolvedReason && member.identity === selection.previousIdentity &&
    (member.correction?.id ?? null) === (selection.correctionId ?? null));
  const receipts = [source.input.classification, ...(member.correction ? [member.correction] : [])];
  requireSource(isDeepStrictEqual(selection.sourceReceipts, receipts));
  receiptFor(input.split.receipt, source);
  requireSource(matchesPreparedEventReceipt(input.split.receipt, JSON.stringify(prepared.event), selection.scope,
    input.split.actorUserId) && input.split.receipt.sequence > selection.expectedEventSequence &&
    input.split.receipt.sequence <= input.sourceContext.eventSequence);
  for (const receipt of receipts) {
    requireSource(receipt.sequence <= selection.expectedEventSequence); before(receipt, input.split.receipt);
  }
  requireSource(![...source.input.corrections, source.input.classification, input.split.receipt].some(r => r.id === input.eventId));
  return { prepared, source, member };
}

function result(input: ClaimDispositionInput | ObligationTransferInput, event: RecoveryOccurrenceEvent,
  sources: ValidatedOccurrenceSource[]): PreparedOccurrenceEvent {
  requireSource(isDeepStrictEqual(scrubDeep(event), event));
  const unknown = sources.flatMap(source => source.members.flatMap(member => member.unresolvedReason ? [{
    runId: source.input.scope.run_id, target: source.target, reportSha256: source.digest, findingRef: member.ref,
    reportKey: member.raw.identity as string, reason: member.unresolvedReason,
  }] : []));
  return structuredClone({ event, qualification: 'content-only', coverage: 'one-occurrence', assertingActorUserId: input.actorUserId,
    splitAttribution: attribution(input.split.receipt), assertionReceipt: { kind: 'pending-server-receipt' },
    unresolvedMembers: [...new Map(unknown.map(member => [JSON.stringify(member), member])).values()] });
}

/**
 * Prepare one immutable occurrence transfer. Selected read authenticity, fresh
 * context, source inventory completeness, server CAS/selector uniqueness and
 * physical filesystem qualification remain outer obligations. No prefix
 * closure, key retirement, gate standing or delivery is asserted here.
 */
export function prepareObligationTransfer(input: ObligationTransferInput): PreparedOccurrenceEvent {
  try { return transfer(input); } catch { throw new Error('occurrence_transfer_source_conflict'); }
}

function transfer(input: ObligationTransferInput): PreparedOccurrenceEvent {
  const { prepared, source: original } = split(input); const source = prepared.source; const scope = input.carrierContext.scope;
  const carrier = validateOccurrenceSource(input.carrier);
  contextFor(input.carrierContext, carrier, input.actorUserId); sameTarget(carrier, original);
  requireSource(key(input.carrierIdentity) && input.carrierIdentity === source.previousIdentity &&
    input.eventId !== carrier.input.classification.id && !carrier.input.corrections.some(r => r.id === input.eventId));
  if (scope.run_id === original.input.scope.run_id) {
    requireSource(isDeepStrictEqual(input.carrierContext, input.sourceContext) && isDeepStrictEqual(input.carrier, input.split.source));
  }
  if (input.carrierKind === 'classified_group') {
    requireSource(scope.run_id === source.runId && carrier.digest === source.reportSha256 &&
      carrier.input.classification.id === input.split.selection.classificationId &&
      carrier.members.some(m => m.ref === source.findingRef && m.identity === input.carrierIdentity));
  } else {
    requireSource(input.carrierKind === 'legacy_pending' && carrier.round >= original.round &&
      carrier.input.classification.payload.classification_version === 1 &&
      Array.isArray(carrier.input.classification.payload.legacy_pending_identities) &&
      carrier.input.classification.payload.legacy_pending_identities.includes(input.carrierIdentity));
  }
  const payload = { version: 1, org_id: scope.org_id, repo: scope.repo, pr_number: scope.pr_number,
    head_sha: input.carrierContext.headSha, report_json_sha256: input.carrierContext.reportSha256,
    expected_event_sequence: input.carrierContext.eventSequence,
    carrier: { kind: input.carrierKind, classification_event_id: input.carrier.classification.id, identity_key: input.carrierIdentity },
    source: { run_id: source.runId, round: source.round, head_sha: input.sourceContext.headSha,
      report_json_sha256: source.reportSha256, classification_event_id: input.split.selection.classificationId,
      correction_event_id: input.split.selection.correctionId ?? null, finding_ref: source.findingRef,
      identity_key: source.reportKey, previous_identity: source.previousIdentity },
    split_event_id: input.split.receipt.id, claim_identity: input.split.selection.identity,
    expected_source_event_sequence: input.sourceContext.eventSequence,
    native_evidence: prepared.event.payload.native_evidence, reason: input.reason };
  return result(input, { id: input.eventId, kind: 'finding_obligation_transferred', run_id: scope.run_id,
    converge_target: input.carrierContext.target, round: input.carrierContext.round, occurred_at: input.occurredAt, payload }, [original, carrier]);
}

/**
 * Prepare an attributed decision without fabricating its future server receipt.
 * Preserved mode additionally proves exact descriptor equality for the entire
 * original co-key family; bare keys and fuzzy paraphrases are insufficient.
 * This does not confirm a fixed claim or project any native/server obligation.
 */
export function prepareClaimDisposition(input: ClaimDispositionInput): PreparedOccurrenceEvent {
  try { return disposition(input); } catch { throw new Error('occurrence_disposition_source_conflict'); }
}

function disposition(input: ClaimDispositionInput): PreparedOccurrenceEvent {
  const { prepared, source: original, member } = split(input); const source = prepared.source; const scope = input.sourceContext.scope;
  requireSource(['fresh', 'preserved'].includes(input.mode) && ['fixed', 'dismissed'].includes(input.verdict) &&
    ['critical', 'important', 'minor', 'nitpick'].includes(input.severity));
  const effectiveSeverity = severity(input, original, member);
  requireSource(effectiveSeverity !== 'critical' || input.severity === 'critical');
  previousDisposition(input, original);
  if (input.mode === 'preserved') preservedVerdict(input, original, member);
  else requireSource(input.originalVerdict === undefined && input.originalVerdictActorUserId === undefined);
  const payload = { version: 1, org_id: scope.org_id, repo: scope.repo, pr_number: scope.pr_number,
    head_sha: input.sourceContext.headSha, report_json_sha256: source.reportSha256, expected_event_sequence: input.sourceContext.eventSequence,
    finding_ref: source.findingRef, identity_key: source.reportKey, split_event_id: input.split.receipt.id,
    claim_identity: input.split.selection.identity, previous_disposition_event_id: input.previousDispositionEventId,
    mode: input.mode, verdict: input.verdict, severity: input.severity, reason: input.reason,
    ...(input.mode === 'preserved' ? { original_verdict: { run_id: source.runId, event_id: input.originalVerdict!.id,
      identity_key: source.previousIdentity, classification_event_id: input.split.selection.classificationId,
      report_json_sha256: source.reportSha256, finding_ref: source.findingRef } } : {}) };
  const out = result(input, { id: input.eventId, kind: 'finding_claim_disposition', run_id: scope.run_id,
    converge_target: source.target, round: source.round, occurred_at: input.occurredAt, payload }, [original]);
  if (input.mode === 'preserved') {
    out.originalVerdictAttribution = attribution(input.originalVerdict!);
    out.assertionReceipt = { kind: 'preserved', receipt: out.originalVerdictAttribution };
  }
  return out;
}

function severity(input: ClaimDispositionInput, source: ValidatedOccurrenceSource, member: OccurrenceMember): string {
  let effective: string = member.severity;
  const batches = (input.laterSources ?? []).map(validateOccurrenceSource).sort((a, b) => a.round - b.round);
  const rounds = new Set<number>();
  for (const batch of batches) {
    sameTarget(source, batch);
    requireSource(batch.round > source.round && !rounds.has(batch.round) &&
      batch.input.scope.run_id !== source.input.scope.run_id && batch.input.classification.payload.classification_version === 1 &&
      BigInt(instant(batch.input.classification.received_at)) >= BigInt(instant(input.split.receipt.received_at)));
    rounds.add(batch.round);
    const sightings = batch.members.filter(m => m.identity === input.split.selection.identity);
    requireSource(sightings.length > 0 && sightings.every(m => isDeepStrictEqual(m.raw.claimDescriptor, input.split.selection.descriptor)));
    const gated = sightings.filter(m => m.gating !== 'none');
    if (gated.length) effective = ['critical', 'important', 'minor', 'nitpick'].find(s => gated.some(m => m.severity === s))!;
  }
  return effective;
}

function previousDisposition(input: ClaimDispositionInput, source: ValidatedOccurrenceSource): void {
  if (input.previousDispositionEventId === null) { requireSource(input.previousDisposition === undefined); return; }
  const receipt = input.previousDisposition;
  requireSource(uuidSchema.safeParse(input.previousDispositionEventId).success && receipt &&
    receipt.id === input.previousDispositionEventId && receipt.id !== input.eventId && uuidSchema.safeParse(receipt.actor_user_id).success);
  receiptFor(receipt, source); before(input.split.receipt, receipt);
  const p = receipt.payload;
  requireSource(receipt.sequence <= input.sourceContext.eventSequence && receipt.kind === 'finding_claim_disposition' &&
    p.version === 1 && p.org_id === source.input.scope.org_id && p.repo === source.input.scope.repo &&
    p.pr_number === source.input.scope.pr_number && p.head_sha === source.head && p.report_json_sha256 === source.digest &&
    p.finding_ref === input.split.selection.findingRef && p.identity_key === input.split.receipt.payload.identity_key &&
    p.split_event_id === input.split.receipt.id && p.claim_identity === input.split.selection.identity &&
    ['fresh', 'preserved'].includes(p.mode as string) && ['fixed', 'dismissed'].includes(p.verdict as string) &&
    ['critical', 'important', 'minor', 'nitpick'].includes(p.severity as string) && counter(p.expected_event_sequence) &&
    p.expected_event_sequence < receipt.sequence);
  requireReason(p.reason);
}

function preservedVerdict(input: ClaimDispositionInput, source: ValidatedOccurrenceSource, member: OccurrenceMember): void {
  requireSource(input.originalVerdict); before(input.originalVerdict, input.split.receipt);
  validatePreservedDispositionSubject({source,member,descriptor:input.split.selection.descriptor,eventId:input.eventId,
    verdict:input.verdict,severity:input.severity,reason:input.reason,originalVerdict:input.originalVerdict,
    originalVerdictActorUserId:input.originalVerdictActorUserId});
}

/** Prove the retained original decision's full subject before any recovery POST.
 * This does not fabricate or predict a split receipt or authorize delivery. */
export function validatePreservedDispositionSubject(input: {
  source:ValidatedOccurrenceSource;member:OccurrenceMember;descriptor:unknown;eventId:string;
  verdict:string;severity:string;reason:string;originalVerdict?:StoredEventReceipt;originalVerdictActorUserId?:string;
}):void {
  const {source,member}=input;const receipt=input.originalVerdict;
  requireSource(receipt && uuidSchema.safeParse(input.originalVerdictActorUserId).success &&
    receipt.actor_user_id===input.originalVerdictActorUserId && receipt.id!==input.eventId);
  receiptFor(receipt,source);before(source.input.classification,receipt);
  // A correction after the decision cannot retroactively establish its subject.
  // Include every original co-key member even if a supplied later correction
  // moved a sibling away. A narrowed current map cannot erase verdict history.
  requireSource(source.members.every(m => !m.unresolvedReason));
  const family = source.members.filter(m => m.identity === member.identity || m.mapping?.matched_identity === member.identity);
  requireSource(family.length > 0);
  for (const sibling of family) {
    if (sibling.correction) before(sibling.correction, receipt);
    requireSource(claimDescriptorSchema.safeParse(sibling.raw.claimDescriptor).success &&
      isDeepStrictEqual(sibling.raw.claimDescriptor, sibling.stored.claim_descriptor) &&
      isDeepStrictEqual(sibling.raw.claimDescriptor, sibling.mapping?.claim_descriptor) &&
      isDeepStrictEqual(sibling.raw.claimDescriptor, input.descriptor));
  }
  requireSource(receipt.kind === 'verdicts_recorded' && Array.isArray(receipt.payload.verdicts));
  const entries = receipt.payload.verdicts;
  requireSource(entries.every(e => object(e) && key(e.identity_key)) &&
    new Set(entries.map(e => e.identity_key)).size === entries.length);
  const verdicts = entries.filter(v => v.identity_key === member.identity);
  requireSource(verdicts.length === 1 && verdicts[0].verdict === input.verdict && verdicts[0].severity === input.severity &&
    verdicts[0].reason === input.reason && (family.every(m => m.gating === 'none' || m.severity !== 'critical') || input.severity === 'critical'));
}
