import { isDeepStrictEqual } from 'node:util';
import { MAX_SELECTED_EVENT_RECEIPTS, readEventReceipts, type EventReceiptScope, type StoredEventReceipt } from '../event-receipts.js';
import { readClaimRecoveryContext, type ClaimRecoverySelection } from './context.js';
import { isStoredEventReceipt } from './validation/receipts.js';
import { uuidSchema } from './validation/primitives.js';
import type { NativeOccurrenceReadRequirement } from './validation/native-occurrences.js';
import type { HarnessSink } from '../../telemetry/sink.js';

type SelectedReceiptRequirement = Extract<NativeOccurrenceReadRequirement, { kind: 'selected-event-receipts' }>;

/** Explicit original source and exact server receipts expected for that source. */
export interface AuthenticatedReceiptSelection {
  selection: ClaimRecoverySelection;
  expectedReceipts: readonly StoredEventReceipt[];
  /** Selected receipt requirements produced by native occurrence preparation. */
  readRequirements: readonly SelectedReceiptRequirement[];
}

/** A live token only the verifier can create. Use the accessor for defensive content. */
export interface AuthenticatedSelectedReceipts { readonly qualification: 'authenticated-selected-receipts' }
export interface AuthenticatedReceiptContent {
  actorUserId: string;
  selections: Array<{ selection: ClaimRecoverySelection; eventIds: string[]; eventSequence: number; receipts: StoredEventReceipt[] }>;
}
const accepted = new WeakMap<AuthenticatedSelectedReceipts, AuthenticatedReceiptContent>();

/** Reject serialized or caller-forged tokens and return only a defensive snapshot. */
export function authenticatedReceiptContent(verification: AuthenticatedSelectedReceipts): AuthenticatedReceiptContent {
  const content = accepted.get(verification);
  if (!content) throw new Error('unverified_authenticated_receipts');
  return structuredClone(content);
}

export type AuthenticatedReceiptVerification =
  | { kind: 'verified'; value: AuthenticatedSelectedReceipts }
  | { kind: 'conflict'; reason: string }
  | { kind: 'unknown'; reason: string };

const sameScope = (a: EventReceiptScope, b: EventReceiptScope): boolean =>
  a.base_url === b.base_url && a.org_id === b.org_id && a.run_id === b.run_id && a.repo === b.repo && a.pr_number === b.pr_number;
const sameOperation = (a: ClaimRecoverySelection, b: ClaimRecoverySelection): boolean =>
  a.scope.base_url === b.scope.base_url && a.scope.org_id === b.scope.org_id && a.scope.repo.toLowerCase() === b.scope.repo.toLowerCase() &&
  a.scope.pr_number === b.scope.pr_number && a.target === b.target;

function selectedIds(input: AuthenticatedReceiptSelection): string[] {
  const requirements = input.readRequirements;
  if (!requirements.length || !input.expectedReceipts.length) throw new Error('invalid_authenticated_receipt_selection');
  const ids: string[] = [];
  for (const requirement of requirements) {
    if (!sameScope(input.selection.scope, requirement.scope) || !Array.isArray(requirement.eventIds) ||
        requirement.eventIds.length < 1) throw new Error('invalid_authenticated_receipt_selection');
    ids.push(...requirement.eventIds);
  }
  const uniqueIds = [...new Set(ids)];
  if (new Set(input.expectedReceipts.map(receipt => receipt.id)).size !== input.expectedReceipts.length ||
      !input.expectedReceipts.every(receipt => isStoredEventReceipt(receipt, input.selection.scope)) ||
      !isDeepStrictEqual([...uniqueIds].sort(), input.expectedReceipts.map(receipt => receipt.id).sort())) {
    throw new Error('invalid_authenticated_receipt_selection');
  }
  return uniqueIds;
}

function unknown(reason: string): AuthenticatedReceiptVerification { return { kind: 'unknown', reason }; }
function conflict(reason: string): AuthenticatedReceiptVerification { return { kind: 'conflict', reason }; }

interface PinnedSelection { input: AuthenticatedReceiptSelection; ids: string[]; before?: { actorUserId: string; eventSequence: number } }

/**
 * Authenticate exact selected receipts in one stable, ordinary-authenticated
 * read window. This is read-only and establishes neither inventory closure nor
 * disposition standing.
 */
export async function verifyAuthenticatedSelectedReceipts(
  sink: HarnessSink, expectedActorUserId: string, selections: readonly AuthenticatedReceiptSelection[]
): Promise<AuthenticatedReceiptVerification> {
  if (!uuidSchema.safeParse(expectedActorUserId).success || !Array.isArray(selections) || !selections.length) {
    throw new Error('invalid_authenticated_receipt_selection');
  }
  // Pin every nested source before the first await. The caller retains no live
  // path to later receipt, context, or operation comparisons.
  const pinned = structuredClone(selections) as AuthenticatedReceiptSelection[];
  const seenSourceRuns = new Set<string>();
  const seenEvents = new Map<string, string>();
  const operations = pinned.map(input => input.selection);
  if (!operations.every(selection => sameOperation(operations[0]!, selection))) throw new Error('authenticated_receipt_operation_conflict');
  const entries: PinnedSelection[] = pinned.map(input => {
    const ids = selectedIds(input);
    const sourceRunKey = JSON.stringify([input.selection.scope.base_url, input.selection.scope.org_id, input.selection.scope.run_id]);
    if (seenSourceRuns.has(sourceRunKey)) throw new Error('duplicate_authenticated_receipt_selection');
    seenSourceRuns.add(sourceRunKey);
    const sequences = new Map<number, string>();
    for (const receipt of input.expectedReceipts) {
      const sequenceId = sequences.get(receipt.sequence);
      if (sequenceId && sequenceId !== receipt.id) throw new Error('authenticated_receipt_sequence_conflict');
      sequences.set(receipt.sequence, receipt.id);
      const eventScope = JSON.stringify([input.selection.scope.base_url, input.selection.scope.org_id, input.selection.scope.run_id, receipt.id]);
      const previousScope = seenEvents.get(receipt.id);
      if (previousScope && previousScope !== eventScope) throw new Error('authenticated_receipt_event_scope_conflict');
      if (previousScope) throw new Error('authenticated_receipt_event_scope_conflict');
      seenEvents.set(receipt.id, eventScope);
    }
    return { input, ids };
  });

  // All source contexts precede any receipt material, yielding one operation-wide window.
  for (const entry of entries) {
    const before = await readClaimRecoveryContext(sink, entry.input.selection);
    if (before.kind !== 'ok') return unknown('authenticated_context_unavailable');
    if (before.value.actorUserId !== expectedActorUserId) return conflict('authenticated_actor_changed');
    if (entry.input.expectedReceipts.some(receipt => receipt.sequence > before.value.eventSequence)) {
      return conflict('selected_receipt_sequence_conflict');
    }
    entry.before = before.value;
  }
  for (const entry of entries) {
    const expected = new Map<string, StoredEventReceipt>(entry.input.expectedReceipts.map((receipt: StoredEventReceipt): [string, StoredEventReceipt] => [receipt.id, receipt]));
    for (let offset = 0; offset < entry.ids.length; offset += MAX_SELECTED_EVENT_RECEIPTS) {
      const batch = entry.ids.slice(offset, offset + MAX_SELECTED_EVENT_RECEIPTS);
      const result = await readEventReceipts(sink, entry.input.selection.scope, batch);
      if (result.kind !== 'ok') return unknown('selected_receipt_read_unavailable');
      if (result.value.missing.length) return conflict('selected_receipt_missing');
      if (result.value.receipts.length !== batch.length || result.value.receipts.some(receipt =>
        !expected.has(receipt.id) || !isDeepStrictEqual(receipt, expected.get(receipt.id)))) {
        return conflict('selected_receipt_mismatch');
      }
    }
  }
  for (const entry of entries) {
    const after = await readClaimRecoveryContext(sink, entry.input.selection);
    if (after.kind !== 'ok') return unknown('authenticated_context_unavailable');
    if (after.value.actorUserId !== expectedActorUserId || after.value.actorUserId !== entry.before!.actorUserId) {
      return conflict('authenticated_actor_changed');
    }
    if (after.value.eventSequence !== entry.before!.eventSequence) return conflict('source_event_sequence_changed');
  }
  const token = Object.freeze({ qualification: 'authenticated-selected-receipts' as const });
  accepted.set(token, structuredClone({ actorUserId: expectedActorUserId, selections: entries.map(entry => ({
    selection: entry.input.selection, eventIds: entry.ids, eventSequence: entry.before!.eventSequence,
    receipts: [...entry.input.expectedReceipts],
  })) }));
  return { kind: 'verified', value: token };
}
