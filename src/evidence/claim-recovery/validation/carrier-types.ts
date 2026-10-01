import type { ObligationTransferInput, OccurrenceContext } from './occurrence-types.js';
import type { StoredEventReceipt } from './receipts.js';

export type OccurrenceRunSelector = Omit<OccurrenceContext, 'actorUserId' | 'eventSequence'>;
export interface OccurrenceCarrierSelector extends OccurrenceRunSelector {
  kind: 'classified_group' | 'legacy_pending';
  classificationId: string;
  identity: string;
}

/** Null names unavailable evidence. Empty arrays mean no supplied entries,
 * not an authenticated proof that the server has no others. */
export interface CarrierSourceInventory {
  selector: OccurrenceRunSelector;
  reportJson: string | null;
  storedRun: Record<string, unknown> | null;
  classifications: StoredEventReceipt[] | null;
  correctionIds: string[] | null;
  corrections: StoredEventReceipt[] | null;
}

export interface AcceptedOccurrenceTransfer {
  preparation: ObligationTransferInput;
  receipt: StoredEventReceipt;
  actorUserId: string;
}

export interface NativePredecessorInventory {
  sourceJson: string;
  nativeSourceJsons?: string[];
}

export interface CarrierProjectionInput {
  carrier: OccurrenceCarrierSelector;
  inventoryStatus: 'complete' | 'incomplete' | 'truncated';
  sources: CarrierSourceInventory[];
  transfers: AcceptedOccurrenceTransfer[];
  nativePredecessors: NativePredecessorInventory[];
}

export interface CarrierOccurrenceSelector {
  source: OccurrenceRunSelector;
  classificationId: string;
  correctionId: string | null;
  findingRef: string;
  reportKey: string;
}

export type CarrierResidualReason =
  | 'legacy-original-occurrence-unavailable'
  | 'inventory-incomplete' | 'inventory-truncated' | 'inventory-limit' | 'prefix-limit'
  | 'round-missing' | 'round-conflict' | 'source-conflict' | 'source-unlisted'
  | 'run-unavailable' | 'artifact-unavailable' | 'classification-unavailable' | 'classification-conflict'
  | 'correction-unavailable' | 'correction-conflict' | 'carrier-unavailable' | 'carrier-conflict'
  | 'classification-ambiguous' | 'untransferred-occurrence' | 'transfer-invalid' | 'transfer-conflict'
  | 'transfer-source-conflict' | 'source-mapping-changed'
  | 'native-source-invalid' | 'native-source-unlisted' | 'native-run-id-unavailable';

export interface CarrierResidual {
  reason: CarrierResidualReason;
  source?: OccurrenceRunSelector;
  occurrence?: CarrierOccurrenceSelector;
  round?: number;
  runIds?: string[];
  eventIds?: string[];
  nativeSha256?: string;
  nativeRunId?: string;
}

export interface ProjectedCarrierTransfer {
  occurrence: CarrierOccurrenceSelector;
  eventId: string;
  splitEventId: string;
  claimIdentity: string;
  actorUserId: string;
  splitActorUserId: string;
  sequence: number;
  receivedAt: string;
}

export interface OccurrenceCarrierProjection {
  qualification: 'supplied-inventory-content-only';
  carrier: OccurrenceCarrierSelector;
  coverage: 'residuals-present' | 'no-residuals-in-supplied-content';
  inspectedRounds: Array<{ round: number; runIds: string[] }>;
  occurrences: Array<{ selector: CarrierOccurrenceSelector; identity: string;
    severity: string; gating: string; transferEventId: string | null }>;
  /** Previously accepted transfers survive newly discovered/missing source evidence. */
  transfers: ProjectedCarrierTransfer[];
  residuals: CarrierResidual[];
  ignoredTransferEventIds: string[];
  ignoredSources: OccurrenceRunSelector[];
}
