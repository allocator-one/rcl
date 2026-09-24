import { isDeepStrictEqual } from 'node:util';
import { correctionAnchor, type NativeCorrectionAnchor } from './anchors.js';
import { projectOccurrenceCarrier } from './carrier-projection.js';
import type { AcceptedOccurrenceTransfer, CarrierProjectionInput, OccurrenceCarrierProjection, OccurrenceCarrierSelector } from './carrier-types.js';
import { prepareClaimDisposition, prepareObligationTransfer } from './occurrence.js';
import type { AcceptedSplitEvidence, ClaimDispositionInput, ReceiptAttribution } from './occurrence-types.js';
import { instant } from './primitives.js';
import { isStoredEventReceipt, matchesPreparedEventReceipt, type EventReceiptScope, type StoredEventReceipt } from './receipts.js';

export interface AcceptedClaimDisposition {
  preparation: ClaimDispositionInput;
  receipt: StoredEventReceipt;
  actorUserId: string;
}
export type NativeCarrierInventory = Omit<CarrierProjectionInput, 'transfers' | 'nativePredecessors'>;
export interface NativeOccurrenceInput {
  transfers?: readonly AcceptedOccurrenceTransfer[];
  dispositions?: readonly AcceptedClaimDisposition[];
  carriers?: readonly NativeCarrierInventory[];
}
/** Selectors for a future authenticated reader, never caller-supplied proof flags. */
export type NativeOccurrenceReadRequirement =
  | { kind: 'selected-event-receipts'; scope: EventReceiptScope; eventIds: string[] }
  | { kind: 'carrier-inventory'; carrier: OccurrenceCarrierSelector; firstRound: number; lastRound: number }
  | { kind: 'eligible-confirmation'; scope: EventReceiptScope; target: string; claimIdentity: string;
      afterRound: number; afterReceivedAt: string; assertionEventId: string };
export interface NativeOccurrenceProjection {
  qualification: 'supplied-content-only';
  /** No selected API or complete inventory read provenance is available in this slice. */
  readProvenance: 'unavailable';
  carriers: Array<{ content: OccurrenceCarrierProjection; unresolved: ['authenticated-inventory-unavailable'] }>;
  dispositions: Array<{ claimIdentity: string; splitEventId: string; verdict: 'fixed' | 'dismissed';
    mode: 'fresh' | 'preserved'; asserting: ReceiptAttribution; assertion: ReceiptAttribution;
    original?: ReceiptAttribution; supersedes: string | null; standing: 'unresolved';
    unresolved: Array<'authenticated-selected-receipt-unavailable' | 'eligible-confirmation-unavailable'> }>;
  readRequirements: NativeOccurrenceReadRequirement[];
}
export interface NativeOccurrenceEvidence {
  version: 1;
  transfers: AcceptedOccurrenceTransfer[];
  dispositions: AcceptedClaimDisposition[];
  carriers: NativeCarrierInventory[];
  projection: NativeOccurrenceProjection;
}
const requireEvidence = (condition: unknown): void => { if (!condition) throw new Error('native_recovery_occurrence_conflict'); };
const time = (value: unknown) => BigInt(instant(value));
const attribution = (r: StoredEventReceipt): ReceiptAttribution => ({ eventId: r.id, actorUserId: r.actor_user_id,
  occurredAt: r.occurred_at, receivedAt: r.received_at, sequence: r.sequence });
const cloneUnique = <T>(rows: readonly T[]): T[] => rows.filter((row, i) => rows.findIndex(r => isDeepStrictEqual(r, row)) === i).map(row => structuredClone(row));
function carrierKey(c: OccurrenceCarrierSelector): string {
  return JSON.stringify([c.scope.base_url, c.scope.org_id, c.scope.repo.toLowerCase(), c.scope.pr_number, c.target,
    c.scope.run_id, c.classificationId, c.identity, c.kind]);
}
function transferCarrier(proof: AcceptedOccurrenceTransfer): OccurrenceCarrierSelector {
  const p = proof.preparation;
  const { actorUserId: _actor, eventSequence: _sequence, ...selector } = p.carrierContext;
  return { ...selector, kind: p.carrierKind, classificationId: p.carrier.classification.id, identity: p.carrierIdentity };
}
function bindSplit(split: AcceptedSplitEvidence, anchors: NativeCorrectionAnchor[]): void {
  const matches = anchors.filter(a => a.identity === split.selection.identity);
  requireEvidence(matches.length === 1);
  const anchor = matches[0]!;
  // A historical anchor may predate stored chronology. Rebuild its original
  // content, then independently match the stronger supplied stored receipt.
  const expected = correctionAnchor(split.selection, anchor.receipt, split.actorUserId, anchor.operationId);
  requireEvidence(isDeepStrictEqual(expected, anchor) && matchesPreparedEventReceipt(split.receipt, anchor.eventJson,
    split.selection.scope, split.actorUserId));
  if ('sequence' in anchor.receipt || 'received_at' in anchor.receipt) requireEvidence(isDeepStrictEqual(anchor.receipt, split.receipt));
}
function consistentReceipts(receipts: StoredEventReceipt[]): void {
  for (const select of [(r: StoredEventReceipt) => r.id, (r: StoredEventReceipt) => `${r.run_id}:${r.sequence}`]) {
    const seen = new Map<string, StoredEventReceipt>();
    for (const receipt of receipts) {
      const key = select(receipt); const old = seen.get(key);
      requireEvidence(!old || isDeepStrictEqual(old, receipt)); seen.set(key, receipt);
    }
  }
}
function sourceReceipts(split: AcceptedSplitEvidence): StoredEventReceipt[] {
  return [split.receipt, split.source.classification, ...split.source.corrections];
}

/**
 * Replay exact supplied acceptance content. Neither retained bytes nor a
 * positive content projection authenticate a remote read. No old key is
 * subtracted and no disposition receives gate standing here.
 */
export function deriveNativeOccurrenceEvidence(input: NativeOccurrenceInput, context: {
  target: string; sourceJson: string; nativeSourceJsons?: string[];
  anchors: NativeCorrectionAnchor[]; previous: NativeOccurrenceEvidence[];
}): NativeOccurrenceEvidence | undefined {
  for (const rows of [input.transfers, input.dispositions, input.carriers]) requireEvidence(rows === undefined || Array.isArray(rows));
  if (![input.transfers, input.dispositions, input.carriers].some(rows => rows?.length)) return undefined;
  const transfers = cloneUnique([...context.previous.flatMap(p => p.transfers), ...input.transfers ?? []]);
  const dispositions = cloneUnique([...context.previous.flatMap(p => p.dispositions), ...input.dispositions ?? []]);
  const inventories = [...context.previous.flatMap(p => p.carriers), ...input.carriers ?? []];
  requireEvidence(transfers.length + dispositions.length + inventories.length <= 2000);
  const receipts: StoredEventReceipt[] = [];
  const requirements: NativeOccurrenceReadRequirement[] = [];
  const selected = (scope: EventReceiptScope, rows: StoredEventReceipt[]) => {
    receipts.push(...rows); requirements.push({ kind: 'selected-event-receipts', scope, eventIds: [...new Set(rows.map(r => r.id))].sort() });
  };
  const ensureTarget = (split: AcceptedSplitEvidence) => {
    requireEvidence(split.selection.target === context.target); bindSplit(split, context.anchors);
  };
  const selectors = new Map<string, string>();
  for (const proof of transfers) {
    const p = proof.preparation; ensureTarget(p.split);
    const prepared = prepareObligationTransfer(p); const scope = p.carrierContext.scope;
    requireEvidence(proof.actorUserId === p.actorUserId && isStoredEventReceipt(proof.receipt, scope) &&
      matchesPreparedEventReceipt(proof.receipt, JSON.stringify(prepared.event), scope, proof.actorUserId) &&
      proof.receipt.sequence > p.carrierContext.eventSequence &&
      [p.split.receipt, p.carrier.classification, ...p.carrier.corrections].every(r => time(proof.receipt.received_at) >= time(r.received_at)));
    const selector = JSON.stringify([carrierKey(transferCarrier(proof)), p.split.selection.scope.run_id,
      p.sourceContext.reportSha256, p.split.selection.findingRef]);
    requireEvidence(!selectors.has(selector) || selectors.get(selector) === proof.receipt.id); selectors.set(selector, proof.receipt.id);
    selected(scope, [proof.receipt, p.carrier.classification, ...p.carrier.corrections]);
    selected(p.split.selection.scope, sourceReceipts(p.split));
  }
  const projected: NativeOccurrenceProjection['dispositions'] = [];
  const latest = new Map<string, AcceptedClaimDisposition>();
  for (const proof of dispositions.sort((a, b) => a.receipt.run_id.localeCompare(b.receipt.run_id) || a.receipt.sequence - b.receipt.sequence)) {
    const p = proof.preparation; ensureTarget(p.split);
    const prepared = prepareClaimDisposition(p); const scope = p.sourceContext.scope;
    requireEvidence(proof.actorUserId === p.actorUserId && isStoredEventReceipt(proof.receipt, scope) &&
      matchesPreparedEventReceipt(proof.receipt, JSON.stringify(prepared.event), scope, proof.actorUserId) &&
      proof.receipt.sequence > p.sourceContext.eventSequence && time(proof.receipt.received_at) >= time(p.split.receipt.received_at) &&
      (p.laterSources ?? []).flatMap(source => [source.classification, ...source.corrections])
        .every(receipt => time(proof.receipt.received_at) >= time(receipt.received_at)));
    const previous = latest.get(p.split.selection.identity);
    // A predecessor must be fully replayable too, not just a plausible payload.
    requireEvidence(p.previousDispositionEventId === (previous?.receipt.id ?? null) &&
      (!previous || isDeepStrictEqual(p.previousDisposition, previous.receipt) && time(proof.receipt.received_at) >= time(previous.receipt.received_at)));
    latest.set(p.split.selection.identity, proof);
    const asserting = attribution(proof.receipt);
    const assertion = prepared.assertionReceipt.kind === 'preserved' ? prepared.assertionReceipt.receipt : asserting;
    projected.push({ claimIdentity: p.split.selection.identity, splitEventId: p.split.receipt.id, verdict: p.verdict,
      mode: p.mode, asserting, assertion, ...(prepared.originalVerdictAttribution ? { original: prepared.originalVerdictAttribution } : {}),
      supersedes: p.previousDispositionEventId, standing: 'unresolved', unresolved: ['authenticated-selected-receipt-unavailable',
        ...(p.verdict === 'fixed' ? ['eligible-confirmation-unavailable' as const] : [])] });
    selected(scope, [proof.receipt, ...sourceReceipts(p.split), ...(p.originalVerdict ? [p.originalVerdict] : [])]);
    for (const later of p.laterSources ?? []) selected(later.scope, [later.classification, ...later.corrections]);
    if (p.verdict === 'fixed') requirements.push({ kind: 'eligible-confirmation', scope, target: context.target,
      claimIdentity: p.split.selection.identity, afterRound: p.sourceContext.round,
      afterReceivedAt: assertion.receivedAt, assertionEventId: assertion.eventId });
  }
  consistentReceipts(receipts);
  const currentInventories = new Map<string, NativeCarrierInventory>();
  for (const inventory of inventories) {
    requireEvidence(inventory.carrier.target === context.target && context.anchors.some(a =>
      a.destination.base_url === inventory.carrier.scope.base_url && a.destination.org_id === inventory.carrier.scope.org_id &&
      a.destination.repo.toLowerCase() === inventory.carrier.scope.repo.toLowerCase() && a.destination.pr_number === inventory.carrier.scope.pr_number));
    currentInventories.set(carrierKey(inventory.carrier), inventory);
  }
  // A transfer without a supplied inventory is still retained, with explicit
  // missing source residuals; it cannot silently disappear from the projection.
  for (const proof of transfers) {
    const carrier = transferCarrier(proof); const key = carrierKey(carrier);
    if (!currentInventories.has(key)) currentInventories.set(key, { carrier, inventoryStatus: 'incomplete', sources: [] });
  }
  const carriers: NativeOccurrenceProjection['carriers'] = [];
  for (const inventory of currentInventories.values()) {
    const content = projectOccurrenceCarrier({ ...inventory, transfers, nativePredecessors: [{ sourceJson: context.sourceJson,
      ...(context.nativeSourceJsons ? { nativeSourceJsons: context.nativeSourceJsons } : {}) }] });
    // Inventory contradictions are residual evidence, not deletion of previously
    // accepted transfers. Include disposition source receipts in this comparison.
    for (const source of inventory.sources) for (const r of [...source.classifications ?? [], ...source.corrections ?? []]) {
      if (receipts.some(p => (p.id === r.id || p.run_id === r.run_id && p.sequence === r.sequence) && !isDeepStrictEqual(p, r))) {
        content.residuals.push({ reason: r.kind === 'round_processed' ? 'classification-conflict' : 'correction-conflict',
          source: source.selector, eventIds: [r.id] }); content.coverage = 'residuals-present';
      }
    }
    content.residuals = cloneUnique(content.residuals);
    carriers.push({ content, unresolved: ['authenticated-inventory-unavailable'] });
    requirements.push({ kind: 'carrier-inventory', carrier: inventory.carrier,
      firstRound: inventory.carrier.kind === 'legacy_pending' ? 1 : inventory.carrier.round, lastRound: inventory.carrier.round });
  }
  return structuredClone({ version: 1, transfers: [...input.transfers ?? []], dispositions: [...input.dispositions ?? []],
    carriers: [...input.carriers ?? []], projection: { qualification: 'supplied-content-only', readProvenance: 'unavailable',
      carriers, dispositions: projected, readRequirements: cloneUnique(requirements) } });
}

/** Retain adverse/unknown carriers. Recovery cannot manufacture a gating source. */
export function occurrencePendingIdentities(evidence: NativeOccurrenceEvidence | undefined): string[] {
  return evidence?.projection.carriers.filter(({ content }) => {
    const knownNonGating = content.carrier.kind === 'classified_group' && content.occurrences.length > 0 &&
      content.occurrences.every(member => member.gating === 'none') && content.residuals.every(residual =>
        residual.reason === 'untransferred-occurrence' && content.occurrences.some(member =>
          member.gating === 'none' && isDeepStrictEqual(member.selector, residual.occurrence)));
    // Existing native pending entries are independently preserved by the caller;
    // this only avoids adding a new obligation from proven nongating content.
    return !knownNonGating;
  }).map(c => c.content.carrier.identity) ?? [];
}
