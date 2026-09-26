import type { ClaimSplitInput } from './claim-split.js';
import type { RetainedNativeEvidence } from './native-state.js';
import type { EventReceiptScope, StoredEventReceipt } from './receipts.js';

/** Supplied read results; content validation does not authenticate their transport. */
export interface OccurrenceSource {
  scope: EventReceiptScope;
  reportJson: string;
  storedRun: Record<string, unknown>;
  classification: StoredEventReceipt;
  corrections: StoredEventReceipt[];
}

/** Pin the selection alongside the result of a fresh current-actor/context read. */
export interface OccurrenceContext {
  scope: EventReceiptScope;
  target: string;
  round: number;
  headSha: string;
  reportSha256: string;
  actorUserId: string;
  eventSequence: number;
}

export interface AcceptedSplitEvidence {
  selection: ClaimSplitInput;
  receipt: StoredEventReceipt;
  actorUserId: string;
  native: RetainedNativeEvidence;
  source: OccurrenceSource;
}

interface Preparation {
  eventId: string;
  occurredAt: string;
  /** Pinned current operator, distinct from historical classification/split actors. */
  actorUserId: string;
  split: AcceptedSplitEvidence;
  sourceContext: OccurrenceContext;
}

export interface ObligationTransferInput extends Preparation {
  carrier: OccurrenceSource;
  carrierContext: OccurrenceContext;
  carrierKind: 'classified_group' | 'legacy_pending';
  carrierIdentity: string;
  reason: string;
}

export type ClaimSeverity = 'critical' | 'important' | 'minor' | 'nitpick';
export interface ClaimDispositionInput extends Preparation {
  mode: 'fresh' | 'preserved';
  verdict: 'fixed' | 'dismissed';
  severity: ClaimSeverity;
  reason: string;
  /** A server CAS precondition; this supplied view cannot prove no newer decision exists. */
  previousDispositionEventId: string | null;
  previousDisposition?: StoredEventReceipt;
  /** Exact later classified batches; never an asserted effective severity alone.
   * The authoritative backend still checks history not present in this selection. */
  laterSources?: OccurrenceSource[];
  originalVerdict?: StoredEventReceipt;
  originalVerdictActorUserId?: string;
}

export interface RecoveryOccurrenceEvent {
  id: string;
  kind: 'finding_obligation_transferred' | 'finding_claim_disposition';
  run_id: string;
  converge_target: string;
  round: number;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface ReceiptAttribution {
  eventId: string;
  actorUserId: string | null;
  occurredAt: string;
  receivedAt: string;
  sequence: number;
}

export interface PreparedOccurrenceEvent {
  event: RecoveryOccurrenceEvent;
  qualification: 'content-only';
  assertingActorUserId: string;
  splitAttribution: ReceiptAttribution;
  originalVerdictAttribution?: ReceiptAttribution;
  /** Fresh assertion time cannot exist until the server accepts the event. */
  assertionReceipt: { kind: 'pending-server-receipt' } | { kind: 'preserved'; receipt: ReceiptAttribution };
  /** Only the selected occurrence is transferred; this is never key retirement. */
  coverage: 'one-occurrence';
  /** Unknown mappings stay explicit. Unselected known members are also untouched;
   * this is not a complete carrier residual inventory or a closure assertion. */
  unresolvedMembers: Array<{
    runId: string; target: string; reportSha256: string; findingRef: string; reportKey: string;
    reason: 'classification-unavailable' | 'classification-ambiguous';
  }>;
}
