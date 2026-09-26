import type { AcceptedOccurrenceTransfer, CarrierProjectionInput, OccurrenceCarrierProjection, OccurrenceCarrierSelector } from './carrier-types.js';
import type { ClaimDispositionInput, ReceiptAttribution } from './occurrence-types.js';
import type { EventReceiptScope, StoredEventReceipt } from './receipts.js';

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
