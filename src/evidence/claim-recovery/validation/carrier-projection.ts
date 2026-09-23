import { hash, key, validateOccurrenceSource, type ValidatedOccurrenceSource } from './occurrence-source.js';
import { prepareObligationTransfer } from './occurrence.js';
import { verifyNativeRecoveryLineage } from './native-state.js';
import { instant, object, uuidSchema } from './primitives.js';
import { isEventReceiptScope, isStoredEventReceipt, matchesPreparedEventReceipt, type StoredEventReceipt } from './receipts.js';
import type {
  CarrierProjectionInput, CarrierSourceInventory, CarrierResidual, OccurrenceRunSelector,
  OccurrenceCarrierProjection, CarrierOccurrenceSelector, ProjectedCarrierTransfer,
} from './carrier-types.js';

export const MAX_CARRIER_INVENTORY = 2000;
export const MAX_CARRIER_PREFIX_ROUNDS = 1000;
const uuid = (value: unknown): value is string => uuidSchema.safeParse(value).success;
function requireInput(valid: unknown): asserts valid { if (!valid) throw new Error('carrier_projection_input_invalid'); }

// Deterministic content ordering only; no filesystem, clock, provider or producer dependency.
function stable(value: unknown, depth = 0): string {
  requireInput(depth <= 64);
  if (Array.isArray(value)) return `[${value.map(v => stable(v, depth + 1)).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k], depth + 1)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function unique<T>(values: T[]): T[] { return [...new Map(values.map(v => [stable(v), v])).values()]; }
function ordered<T>(values: T[]): T[] {
  return unique(values).sort((a, b) => { const x = stable(a); const y = stable(b); return x < y ? -1 : x > y ? 1 : 0; });
}
function validSelector(value: OccurrenceRunSelector): boolean {
  return object(value) && object(value.scope) && isEventReceiptScope(value.scope) && value.scope.repo.length <= 200 &&
    value.scope.pr_number <= 2_147_483_647 && typeof value.target === 'string' && value.target.trim() === value.target &&
    value.target.length > 0 && value.target.length <= 500 && Number.isSafeInteger(value.round) && value.round > 0 &&
    value.round <= 2_147_483_647 && typeof value.headSha === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.headSha) &&
    !/^0+$/.test(value.headSha) && typeof value.reportSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.reportSha256);
}
function sameTarget(a: OccurrenceRunSelector, b: OccurrenceRunSelector): boolean {
  return a.scope.base_url === b.scope.base_url && a.scope.org_id === b.scope.org_id &&
    a.scope.repo.toLowerCase() === b.scope.repo.toLowerCase() && a.scope.pr_number === b.scope.pr_number && a.target === b.target;
}
function sameRun(a: OccurrenceRunSelector, b: OccurrenceRunSelector): boolean {
  return sameTarget(a, b) && a.scope.run_id === b.scope.run_id && a.round === b.round &&
    a.headSha === b.headSha && a.reportSha256 === b.reportSha256;
}
function sourceSelector(source: ValidatedOccurrenceSource): OccurrenceRunSelector {
  return { scope: source.input.scope, target: source.target, round: source.round, headSha: source.head, reportSha256: source.digest };
}
function occurrence(source: ValidatedOccurrenceSource, ref: string): CarrierOccurrenceSelector {
  const member = source.members.find(m => m.ref === ref); requireInput(member);
  return { source: sourceSelector(source), classificationId: source.input.classification.id,
    correctionId: member.correction?.id ?? null, findingRef: ref, reportKey: member.raw.identity as string };
}
function occurrenceKey(value: CarrierOccurrenceSelector): string {
  const s = value.source;
  return stable([s.scope.base_url, s.scope.org_id, s.scope.repo.toLowerCase(), s.scope.pr_number,
    s.target, s.scope.run_id, s.reportSha256, value.findingRef]);
}
function inspectSource(row: CarrierSourceInventory, residuals: CarrierResidual[]): ValidatedOccurrenceSource | undefined {
  const add = (reason: CarrierResidual['reason'], eventIds?: string[]) => residuals.push({ reason, source: row.selector,
    ...(eventIds ? { eventIds: [...eventIds].sort() } : {}) });
  let missing = false;
  if (row.storedRun === null) { add('run-unavailable'); missing = true; }
  if (row.reportJson === null) { add('artifact-unavailable'); missing = true; }
  if (!row.classifications?.length) { add('classification-unavailable'); missing = true; }
  if (row.correctionIds === null || row.corrections === null) { add('correction-unavailable'); missing = true; }
  if (missing) return;
  const classifications = unique(row.classifications!);
  if (classifications.length !== 1) { add('classification-conflict', classifications.map(c => c.id)); return; }
  const corrections = unique(row.corrections!); const expected = row.correctionIds!;
  if (!expected.every(uuid) || new Set(expected).size !== expected.length) { add('correction-conflict'); return; }
  const absent = expected.filter(id => !corrections.some(c => c.id === id));
  if (absent.length) { add('correction-unavailable', absent); return; }
  if (corrections.length !== expected.length || corrections.some(c => !expected.includes(c.id))) { add('correction-conflict'); return; }
  try {
    const source = validateOccurrenceSource({ scope: row.selector.scope, reportJson: row.reportJson!, storedRun: row.storedRun!,
      classification: classifications[0], corrections });
    requireInput(sameRun(sourceSelector(source), row.selector));
    return source;
  } catch { add('source-conflict'); return; }
}

function acceptedTransfers(input: CarrierProjectionInput, out: OccurrenceCarrierProjection): {
  values: ProjectedCarrierTransfer[]; receipts: StoredEventReceipt[];
} {
  const candidates: Array<{ value: ProjectedCarrierTransfer; signature: string; evidence: StoredEventReceipt[] }> = [];
  const invalidIds = new Set<string>();
  for (const proof of input.transfers) {
    const p = proof.preparation; const c = input.carrier;
    try {
      // Another carrier's receipt never subtracts this carrier's same-key members.
      if (p.carrierKind !== c.kind || p.carrierIdentity !== c.identity || p.carrier.classification.id !== c.classificationId ||
          !sameTarget(p.carrierContext, c) || p.carrierContext.scope.run_id !== c.scope.run_id || p.carrierContext.round !== c.round) {
        if (uuid(proof.receipt.id)) out.ignoredTransferEventIds.push(proof.receipt.id);
        continue;
      }
      const prepared = prepareObligationTransfer(p);
      requireInput(sameRun(p.carrierContext, c) && proof.actorUserId === p.actorUserId &&
        isStoredEventReceipt(proof.receipt, c.scope) &&
        matchesPreparedEventReceipt(proof.receipt, JSON.stringify(prepared.event), c.scope, proof.actorUserId) &&
        proof.receipt.sequence > p.carrierContext.eventSequence &&
        [p.split.receipt, p.carrier.classification, ...p.carrier.corrections].every(receipt =>
          BigInt(instant(proof.receipt.received_at)) >= BigInt(instant(receipt.received_at))));
      const source = validateOccurrenceSource(p.split.source);
      const value: ProjectedCarrierTransfer = { occurrence: occurrence(source, p.split.selection.findingRef),
        eventId: proof.receipt.id, splitEventId: p.split.receipt.id, claimIdentity: p.split.selection.identity,
        actorUserId: proof.actorUserId, splitActorUserId: p.split.actorUserId,
        sequence: proof.receipt.sequence, receivedAt: proof.receipt.received_at };
      candidates.push({ value, signature: stable(proof.receipt), evidence: unique([proof.receipt, p.split.receipt,
        p.split.source.classification, ...p.split.source.corrections, p.carrier.classification, ...p.carrier.corrections]) });
    } catch {
      const id = proof.receipt?.id;
      if (uuid(id)) invalidIds.add(id);
      out.residuals.push({ reason: 'transfer-invalid', ...(uuid(id) ? { eventIds: [id] } : {}) });
    }
  }
  const distinct = unique(candidates); const blocked = new Set<string>();
  // Accepted preparations must also agree on shared source/split receipt UUIDs
  // and stream positions. Individually valid contradictory proofs cannot combine.
  const evidence = distinct.flatMap(c => c.evidence.map(receipt => ({ receipt, owner: c.value.eventId })));
  for (const select of [(r: StoredEventReceipt) => r.id, (r: StoredEventReceipt) => `${r.run_id}:${r.sequence}`]) {
    const groups = new Map<string, typeof evidence>();
    for (const row of evidence) { const k = select(row.receipt); groups.set(k, [...(groups.get(k) ?? []), row]); }
    for (const group of groups.values()) if (unique(group.map(row => row.receipt)).length > 1) {
      const ids = [...new Set(group.map(row => row.owner))].sort(); ids.forEach(id => blocked.add(id));
      out.residuals.push({ reason: 'transfer-conflict', eventIds: ids });
    }
  }
  for (const select of [
    (v: ProjectedCarrierTransfer) => v.eventId,
    (v: ProjectedCarrierTransfer) => occurrenceKey(v.occurrence),
    (v: ProjectedCarrierTransfer) => String(v.sequence),
  ]) {
    const groups = new Map<string, typeof distinct>();
    for (const candidate of distinct) { const k = select(candidate.value); groups.set(k, [...(groups.get(k) ?? []), candidate]); }
    for (const group of groups.values()) if (group.length > 1) {
      const ids = [...new Set(group.map(c => c.value.eventId))].sort();
      ids.forEach(id => blocked.add(id)); out.residuals.push({ reason: 'transfer-conflict', eventIds: ids });
    }
  }
  const accepted = distinct.filter(c => !blocked.has(c.value.eventId) && !invalidIds.has(c.value.eventId));
  return { values: accepted.map(c => c.value), receipts: unique(accepted.flatMap(c => c.evidence)) };
}

function sourceReceiptResiduals(sources: ValidatedOccurrenceSource[], proofReceipts: StoredEventReceipt[],
  out: OccurrenceCarrierProjection): void {
  const rows = sources.flatMap(source => [source.input.classification, ...source.input.corrections].map(receipt => ({
    receipt, source: sourceSelector(source), reason: receipt.kind === 'round_processed' ?
      'classification-conflict' as const : 'correction-conflict' as const,
  })));
  // Compare all selected receipt content, including source/carrier corrections
  // and splits retained inside acknowledged transfer proofs. Agreement inside
  // each set alone does not establish agreement across their shared UUIDs or
  // per-run stream positions. Keep prior transfers; expose the inventory conflict.
  type Row = { receipt: StoredEventReceipt; source?: OccurrenceRunSelector;
    reason?: 'classification-conflict' | 'correction-conflict' };
  const combined: Row[] = [...rows, ...proofReceipts.map(receipt => ({ receipt }))];
  for (const select of [(r: StoredEventReceipt) => r.id, (r: StoredEventReceipt) => `${r.run_id}:${r.sequence}`]) {
    const groups = new Map<string, Row[]>();
    for (const row of combined) { const k = select(row.receipt); groups.set(k, [...(groups.get(k) ?? []), row]); }
    for (const group of groups.values()) if (unique(group.map(row => row.receipt)).length > 1) {
      const eventIds = [...new Set(group.map(row => row.receipt.id))].sort();
      for (const row of group) if (row.reason && row.source) out.residuals.push({ reason: row.reason, source: row.source, eventIds });
    }
  }
  // New conflicting inventory does not rewrite accepted transfer history, but
  // it prevents a residual-free content result until the conflict is resolved.
  for (const transfer of out.transfers) if (rows.some(row => row.receipt.id === transfer.eventId ||
      row.receipt.run_id === out.carrier.scope.run_id && row.receipt.sequence === transfer.sequence)) {
    out.residuals.push({ reason: 'transfer-conflict', eventIds: [transfer.eventId] });
  }
}

function nativeResiduals(input: CarrierProjectionInput, sources: CarrierSourceInventory[], out: OccurrenceCarrierProjection): void {
  for (const predecessor of unique(input.nativePredecessors)) {
    const digest = typeof predecessor.sourceJson === 'string' ? hash(predecessor.sourceJson) : undefined;
    try {
      const lineage = verifyNativeRecoveryLineage(predecessor.sourceJson, input.carrier.target, predecessor.nativeSourceJsons);
      for (const round of lineage.state.rounds) {
        if (round.round > input.carrier.round || input.carrier.kind === 'classified_group' && round.round !== input.carrier.round) continue;
        if (!round.runId) { out.residuals.push({ reason: 'native-run-id-unavailable', round: round.round, nativeSha256: digest }); continue; }
        const rows = sources.filter(s => s.selector.scope.run_id === round.runId && s.selector.round === round.round);
        if (!rows.length) out.residuals.push({ reason: 'native-source-unlisted', round: round.round, nativeRunId: round.runId, nativeSha256: digest });
        for (const row of rows) if (round.reportBinding && round.reportBinding.reportSha256 !== row.selector.reportSha256) {
          out.residuals.push({ reason: 'source-conflict', source: row.selector, nativeRunId: round.runId, nativeSha256: digest });
        }
      }
    } catch { out.residuals.push({ reason: 'native-source-invalid', ...(digest ? { nativeSha256: digest } : {}) }); }
  }
}
function finish(out: OccurrenceCarrierProjection): OccurrenceCarrierProjection {
  out.occurrences = ordered(out.occurrences); out.transfers = ordered(out.transfers);
  out.residuals = ordered(out.residuals); out.ignoredSources = ordered(out.ignoredSources);
  out.ignoredTransferEventIds = [...new Set(out.ignoredTransferEventIds)].sort();
  out.inspectedRounds.sort((a, b) => a.round - b.round);
  out.coverage = out.residuals.length ? 'residuals-present' : 'no-residuals-in-supplied-content';
  return structuredClone(out);
}

/**
 * Project only the supplied inventory's content. Even a residual-free result is
 * neither authenticated prefix completeness nor native/server closure, claim
 * disposition, gate standing or permission to write. No accounting is changed.
 */
export function projectOccurrenceCarrier(input: CarrierProjectionInput): OccurrenceCarrierProjection {
  const c = input.carrier;
  requireInput(validSelector(c) && uuid(c.classificationId) && key(c.identity) &&
    ['classified_group', 'legacy_pending'].includes(c.kind) && ['complete', 'incomplete', 'truncated'].includes(input.inventoryStatus) &&
    Array.isArray(input.sources) && Array.isArray(input.transfers) && Array.isArray(input.nativePredecessors));
  const out: OccurrenceCarrierProjection = { qualification: 'supplied-inventory-content-only', carrier: c,
    coverage: 'residuals-present', inspectedRounds: [], occurrences: [], transfers: [], residuals: [],
    ignoredSources: [], ignoredTransferEventIds: [] };
  if (input.inventoryStatus !== 'complete') out.residuals.push({ reason: `inventory-${input.inventoryStatus}` });
  if ([input.sources, input.transfers, input.nativePredecessors].some(a => a.length > MAX_CARRIER_INVENTORY)) {
    out.residuals.push({ reason: 'inventory-limit' }); return finish(out);
  }
  const sources = unique(input.sources).filter(row => {
    requireInput(validSelector(row.selector));
    const included = sameTarget(row.selector, c) && (c.kind === 'legacy_pending' ? row.selector.round <= c.round :
      row.selector.scope.run_id === c.scope.run_id && row.selector.round === c.round);
    if (!included) out.ignoredSources.push(row.selector);
    return included;
  });
  let rounds = [c.round];
  if (c.kind === 'legacy_pending') {
    if (c.round > MAX_CARRIER_PREFIX_ROUNDS) {
      out.residuals.push({ reason: 'prefix-limit', round: c.round }); rounds = [...new Set(sources.map(s => s.selector.round))];
    } else rounds = Array.from({ length: c.round }, (_, i) => i + 1);
  }
  for (const round of rounds) {
    const runIds = [...new Set(sources.filter(s => s.selector.round === round).map(s => s.selector.scope.run_id))].sort();
    out.inspectedRounds.push({ round, runIds });
    if (!runIds.length) out.residuals.push({ reason: 'round-missing', round, runIds });
    if (runIds.length > 1) out.residuals.push({ reason: 'round-conflict', round, runIds });
  }
  for (const row of sources) if (sources.filter(s => s.selector.scope.run_id === row.selector.scope.run_id).length > 1) {
    out.residuals.push({ reason: 'source-conflict', source: row.selector });
  }
  const validated = sources.map(s => inspectSource(s, out.residuals)).filter((s): s is ValidatedOccurrenceSource => !!s);
  const carrierSources = validated.filter(s => sameRun(sourceSelector(s), c));
  if (!carrierSources.length) out.residuals.push({ reason: 'carrier-unavailable', source: {
    scope: c.scope, target: c.target, round: c.round, headSha: c.headSha, reportSha256: c.reportSha256 } });
  for (const source of carrierSources) {
    const classification = source.input.classification;
    const supported = classification.id === c.classificationId && (c.kind === 'legacy_pending' ?
      classification.payload.classification_version === 1 && Array.isArray(classification.payload.legacy_pending_identities) &&
        classification.payload.legacy_pending_identities.includes(c.identity) :
      source.members.some(m => m.identity === c.identity || m.mapping?.matched_identity === c.identity));
    if (!supported) out.residuals.push({ reason: 'carrier-conflict', source: sourceSelector(source) });
  }
  const accepted = acceptedTransfers(input, out);
  out.transfers = accepted.values;
  sourceReceiptResiduals(validated, accepted.receipts, out);
  for (const source of validated) for (const member of source.members) {
    const selector = occurrence(source, member.ref);
    if (member.unresolvedReason) {
      out.residuals.push({ reason: member.unresolvedReason, occurrence: selector }); continue;
    }
    if (member.identity !== c.identity && member.mapping?.matched_identity !== c.identity) continue;
    const transferred = out.transfers.find(t => occurrenceKey(t.occurrence) === occurrenceKey(selector));
    const matches = transferred && sameRun(transferred.occurrence.source, selector.source) &&
      transferred.occurrence.classificationId === selector.classificationId && transferred.occurrence.correctionId === selector.correctionId &&
      transferred.occurrence.reportKey === selector.reportKey && member.identity === c.identity;
    out.occurrences.push({ selector, identity: member.identity!, severity: member.severity, gating: member.gating,
      transferEventId: matches ? transferred.eventId : null });
    if (!matches) out.residuals.push({ reason: transferred ? 'transfer-source-conflict' : 'untransferred-occurrence', occurrence: selector });
    if (member.identity !== c.identity) out.residuals.push({ reason: 'source-mapping-changed', occurrence: selector });
  }
  for (const transfer of out.transfers) if (!sources.some(s => sameRun(s.selector, transfer.occurrence.source))) {
    out.residuals.push({ reason: 'source-unlisted', occurrence: transfer.occurrence });
  }
  nativeResiduals(input, sources, out);
  return finish(out);
}
