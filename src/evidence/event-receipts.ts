import type { HarnessSink, SinkOutcome } from '../telemetry/sink.js';
import {
  isEventReceipt,
  isEventReceiptScope,
  positiveCounter,
  type EventReceipt,
  type EventReceiptScope,
} from './claim-recovery/validation/receipts.js';
import { instant, object, uuidSchema } from './claim-recovery/validation/primitives.js';

export { matchesPreparedEventReceipt } from './claim-recovery/validation/receipts.js';
export type { EventReceipt, EventReceiptScope } from './claim-recovery/validation/receipts.js';

/** Server acceptance metadata is separate from the original wire assertion. */
export interface StoredEventReceipt extends EventReceipt {
  /** Positive safe-integer position in this run's stored event stream. */
  sequence: number;
  /** Exact server timestamp, retaining all supplied microsecond precision. */
  received_at: string;
}

export interface SelectedEventReceipts {
  receipts: StoredEventReceipt[];
  missing: string[];
}

export const MAX_SELECTED_EVENT_RECEIPTS = 50;

export { isEventReceipt } from './claim-recovery/validation/receipts.js';

/** Validate a selected API receipt, including its server-owned chronology. */
export function isStoredEventReceipt(raw: unknown, scope: EventReceiptScope): raw is StoredEventReceipt {
  if (!object(raw) || !isEventReceipt(raw, scope) || !Object.hasOwn(raw, 'sequence') ||
      !Object.hasOwn(raw, 'received_at') || !positiveCounter(raw.sequence)) return false;
  try { instant(raw.received_at); return true; } catch { return false; }
}

/**
 * Read only explicitly selected receipts. A successful empty result proves
 * none of these IDs were returned; a failed read makes no absence claim.
 */
export async function readEventReceipts(
  sink: HarnessSink, scope: EventReceiptScope, ids: readonly string[]
): Promise<SinkOutcome<SelectedEventReceipts>> {
  if (!isEventReceiptScope(scope) || ids.length < 1 || ids.length > MAX_SELECTED_EVENT_RECEIPTS ||
      !ids.every(id => uuidSchema.safeParse(id).success) || new Set(ids).size !== ids.length) throw new Error('invalid_event_receipt_selection');
  if (sink.credentialSource === 'attest') throw new Error('unsupported_attested_recovery');
  if (sink.baseUrl !== scope.base_url) throw new Error('event_receipt_destination_conflict');
  const selected = new Set(ids);
  const query = new URLSearchParams({ ids: ids.join(',') });
  return sink.getJson(`/api/v1/reviews/runs/${scope.run_id}/events?${query}`, (data, meta) => {
    if (!object(meta) || meta.org_id !== scope.org_id || meta.run_id !== scope.run_id ||
        Object.keys(meta).some(key => !['org_id', 'run_id', 'claim_recovery_version'].includes(key)) ||
        meta.claim_recovery_version !== 1 || !Array.isArray(data) || data.length > ids.length) return null;
    const receipts: StoredEventReceipt[] = [];
    const seen = new Set<string>();
    for (const raw of data) {
      if (!isStoredEventReceipt(raw, scope) || !selected.has(raw.id) || seen.has(raw.id)) return null;
      seen.add(raw.id); receipts.push(raw);
    }
    return { receipts, missing: ids.filter(id => !seen.has(id)) };
  }, { requireCompleteRead: true });
}
