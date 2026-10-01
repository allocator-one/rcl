import type { ClaimDescriptor } from './claims.js';
import { prepareClaimSplit, type ClaimSplitInput, type PreparedClaimSplit } from './claim-split.js';
import { matchesPreparedEventReceipt, type EventReceipt, type EventReceiptScope } from './receipts.js';
import { uuidSchema } from './primitives.js';

export interface NativeCorrectionAnchor {
  version: 1;
  operationId: string;
  destination: EventReceiptScope;
  identity: string;
  descriptor: ClaimDescriptor;
  source: PreparedClaimSplit['source'];
  nativeSource: { version: 1 | 2 | 3; sha256: string };
  /** Preserve exact prepared bytes separately from normalized stored fields. */
  eventJson: string;
  receipt: EventReceipt;
}

/** Receipt-backed recovery metadata is separate from original producer history. */
export function correctionAnchor(input: ClaimSplitInput, receipt: EventReceipt, actor: string, operationId: string): NativeCorrectionAnchor {
  try {
    if (!uuidSchema.safeParse(operationId).success) throw new Error('invalid_operation');
    const prepared = prepareClaimSplit(input);
    const eventJson = JSON.stringify(prepared.event);
    if (!matchesPreparedEventReceipt(receipt, eventJson, input.scope, actor)) throw new Error('receipt_mismatch');
    const evidence = prepared.event.payload.native_evidence as { state_version: 1 | 2 | 3; state_sha256: string };
    return structuredClone({ version: 1, operationId, destination: input.scope, identity: input.identity, descriptor: input.descriptor,
      source: prepared.source, nativeSource: { version: evidence.state_version, sha256: evidence.state_sha256 },
      eventJson, receipt });
  } catch { throw new Error('correction_anchor_source_conflict'); }
}
