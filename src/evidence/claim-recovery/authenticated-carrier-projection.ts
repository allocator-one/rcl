import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { authenticatedReceiptContent, type AuthenticatedSelectedReceipts } from './authenticated-receipts.js';
import { carrierInventoryContent, type AuthenticatedCarrierInventory } from './carrier-inventory.js';
import { projectOccurrenceCarrier } from './validation/carrier-projection.js';
import type { AcceptedOccurrenceTransfer, NativePredecessorInventory, OccurrenceCarrierProjection } from './validation/carrier-types.js';
import type { StoredEventReceipt } from './validation/receipts.js';
import type { OccurrenceSource } from './validation/occurrence-types.js';

/** Opaque one-carrier snapshot derived only from live authenticated reader tokens. */
export interface AuthenticatedCarrierProjection { readonly qualification: 'authenticated-single-carrier-projection' }
export interface AuthenticatedCarrierProjectionContent {
  actorUserId: string;
  projection: OccurrenceCarrierProjection;
}
const accepted = new WeakMap<AuthenticatedCarrierProjection, AuthenticatedCarrierProjectionContent>();

export function authenticatedCarrierProjectionContent(value: AuthenticatedCarrierProjection): AuthenticatedCarrierProjectionContent {
  const content = accepted.get(value);
  if (!content) throw new Error('unverified_authenticated_carrier_projection');
  return structuredClone(content);
}

const exact = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
const receiptKey = (receipt: StoredEventReceipt): string => `${receipt.run_id}:${receipt.id}`;
const sequenceKey = (receipt: StoredEventReceipt): string => `${receipt.run_id}:${receipt.sequence}`;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function sourceMatchesSelection(source: OccurrenceSource, selection: {
  scope: { base_url: string; org_id: string; run_id: string; repo: string; pr_number: number };
  target: string; round: number; headSha: string; reportSha256: string;
}): boolean {
  const run = source.storedRun as { target?: { head_sha?: unknown }; converge?: { target?: unknown; round?: unknown } };
  return exact(source.scope, selection.scope) && run.converge?.target === selection.target &&
    run.converge?.round === selection.round && run.target?.head_sha === selection.headSha &&
    digest(source.reportJson) === selection.reportSha256;
}

/**
 * Projects exactly one authenticated carrier snapshot. It neither proves global
 * closure nor changes a claim, gate, native state, or delivery outcome.
 */
export function projectAuthenticatedCarrier(
  inventoryToken: AuthenticatedCarrierInventory,
  receiptToken: AuthenticatedSelectedReceipts | undefined,
  input: { transfers?: readonly AcceptedOccurrenceTransfer[]; nativePredecessors?: readonly NativePredecessorInventory[] } = {},
): { kind: 'authenticated'; value: AuthenticatedCarrierProjection } | { kind: 'conflict'; reason: string } {
  try {
    const inventory = carrierInventoryContent(inventoryToken);
    const reads = receiptToken ? authenticatedReceiptContent(receiptToken) : undefined;
    if ((reads && inventory.actorUserId !== reads.actorUserId) || inventory.inventory.inventoryStatus !== 'complete') throw new Error('actor_or_inventory_conflict');
    const byRun = new Map(inventory.runSequences.map(row => [row.runId, row.eventSequence]));
    if (byRun.size !== inventory.runSequences.length) throw new Error('inventory_sequence_conflict');
    const selected = new Map((reads?.selections ?? []).map(row => [row.selection.scope.run_id, row]));
    if (reads && selected.size !== reads.selections.length) throw new Error('receipt_selection_conflict');
    const receipts = new Map<string, StoredEventReceipt>();
    const sequences = new Map<string, StoredEventReceipt>();
    for (const row of reads?.selections ?? []) {
      const current = byRun.get(row.selection.scope.run_id);
      if (current === undefined || row.eventSequence !== current) throw new Error('stale_token_sequence');
      for (const receipt of row.receipts) {
        if (receipt.run_id !== row.selection.scope.run_id || receipt.sequence > current) throw new Error('receipt_sequence_conflict');
        const key = receiptKey(receipt); const prior = receipts.get(key);
        if (prior && !exact(prior, receipt)) throw new Error('receipt_content_conflict');
        const stream = sequenceKey(receipt); const sequencePrior = sequences.get(stream);
        if (sequencePrior && !exact(sequencePrior, receipt)) throw new Error('receipt_sequence_conflict');
        receipts.set(key, receipt); sequences.set(stream, receipt);
      }
    }
    const requireReceipt = (receipt: StoredEventReceipt): void => {
      if (!exact(receipts.get(receiptKey(receipt)), receipt)) throw new Error('receipt_not_authenticated');
    };
    const requireSource = (source: OccurrenceSource): void => {
      const read = selected.get(source.scope.run_id);
      if (!read || !sourceMatchesSelection(source, read.selection)) throw new Error('transfer_source_not_authenticated');
      requireReceipt(source.classification);
      for (const receipt of source.corrections) requireReceipt(receipt);
    };
    for (const source of inventory.inventory.sources) {
      const read = selected.get(source.selector.scope.run_id);
      if (read && (!exact(read.selection.scope, source.selector.scope) || read.selection.target !== source.selector.target ||
          read.selection.round !== source.selector.round || read.selection.headSha !== source.selector.headSha ||
          read.selection.reportSha256 !== source.selector.reportSha256)) throw new Error('source_not_authenticated');
    }
    const transfers = [...structuredClone(input.transfers ?? [])];
    if (transfers.length && !reads) throw new Error('transfer_receipts_required');
    for (const transfer of transfers) {
      requireReceipt(transfer.receipt); requireReceipt(transfer.preparation.split.receipt);
      requireSource(transfer.preparation.split.source);
      requireSource(transfer.preparation.carrier);
    }
    const projection = projectOccurrenceCarrier({ ...inventory.inventory, transfers,
      nativePredecessors: [...structuredClone(input.nativePredecessors ?? [])] });
    const value = Object.freeze({ qualification: 'authenticated-single-carrier-projection' as const });
    accepted.set(value, structuredClone({ actorUserId: inventory.actorUserId, projection }));
    return { kind: 'authenticated', value };
  } catch (error) {
    return { kind: 'conflict', reason: error instanceof Error ? error.message : 'authenticated_carrier_projection_conflict' };
  }
}
