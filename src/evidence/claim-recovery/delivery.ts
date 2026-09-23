import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HarnessSink } from '../../telemetry/sink.js';
import type { WireEvent } from '../../telemetry/events.js';
import { platformPath, readStable, sha256 } from '../../telemetry/recovery/files.js';
import { assertRecoveryTargetOwnership, withOwnedNativeOperation, type NativeTargetOwnership } from '../../converge/target-ownership.js';
import { matchesPreparedEventReceipt, readEventReceipts, type StoredEventReceipt, type EventReceiptScope } from '../event-receipts.js';
import { MAX_RECOVERY_DOCUMENT_BYTES, writeExclusive, type Journal } from '../original-run/journal.js';
import { inspectRecoveryDirectory } from '../original-run/lock-path.js';
import { decodeOriginalReport } from '../original-run/decode.js';
import { object } from '../original-run/remote.js';
import { uuidSchema } from '../original-run/source.js';

export interface ClaimEventDeliveryOptions {
  gitCommonDir: string;
  target: string;
  ownership: NativeTargetOwnership;
  operationId: string;
  manifestSha256: string;
  packetPath: string;
  mode: 'apply' | 'resume';
  /** An adopted receipt is read-only: its disappearance never authorizes POST. */
  allowPost?: boolean;
  scope: EventReceiptScope;
  actor: string;
  /** Already prepared assertion; recovery must never regenerate its UUID/time. */
  eventJson: string;
  sink: HarnessSink;
  journal: Journal;
  /** Fresh source, capability and authenticated-actor checks before delivery. */
  verifyContext: () => Promise<void>;
}

/** Retain a prepared claim event, deliver it once, and require exact readback. */
export function deliverPreparedClaimEvent(options: ClaimEventDeliveryOptions): Promise<StoredEventReceipt> {
  // Pin caller-owned objects before the first await. Every replay compares the
  // retained packet, not a newly generated event or an acknowledgment counter.
  const scope = structuredClone(options.scope);
  const { actor, eventJson, operationId, manifestSha256, target, mode, gitCommonDir, sink, journal, verifyContext } = options;
  const path = platformPath(options.packetPath);
  return withOwnedNativeOperation(options.ownership, gitCommonDir, target, async ownership => {
    await assertRecoveryTargetOwnership(ownership, gitCommonDir, target);
    if (!uuidSchema.safeParse(operationId).success || !/^[a-f0-9]{64}$/.test(manifestSha256) ||
        !['apply', 'resume'].includes(mode) || sink.credentialSource === 'attest') {
      throw new Error('claim_event_input_conflict');
    }
    if (sink.baseUrl !== scope.base_url) throw new Error('claim_event_destination_conflict');
    const decoded = decodeOriginalReport(eventJson, { exactNumbers: true });
    const event = decoded.value;
    if (decoded.transformations.length || !object(event) || !['finding_claim_split', 'finding_obligation_transferred', 'finding_claim_disposition'].includes(event.kind as string) ||
        event.converge_target !== target || !matchesPreparedEventReceipt({
          ...event, org_id: scope.org_id, repo: scope.repo, pr_number: scope.pr_number,
          actor_user_id: actor, attempt: event.attempt ?? null,
        }, eventJson, scope, actor)) throw new Error('claim_event_input_conflict');
    const packet = { kind: 'rcl-prepared-claim-event', version: 1, operation_id: operationId,
      manifest_sha256: manifestSha256, destination: scope, actor_user_id: actor, target,
      event_json: eventJson, event_sha256: sha256(eventJson) };
    await inspectRecoveryDirectory(dirname(path), true);
    await verifyContext();
    if (mode === 'apply') await writeExclusive(path, packet, MAX_RECOVERY_DOCUMENT_BYTES);
    const retained = await readStable(path, MAX_RECOVERY_DOCUMENT_BYTES);
    const parsed = decodeOriginalReport(retained.text, { exactNumbers: true });
    if (parsed.transformations.length || !isDeepStrictEqual(parsed.value, packet)) {
      throw new Error('claim_event_packet_conflict');
    }
    const audit = { operation_id: operationId, manifest_sha256: manifestSha256,
      packet_sha256: retained.sha256, event_id: event.id, event_sha256: packet.event_sha256 };
    const verifyPinnedContext = async (): Promise<void> => {
      await verifyContext();
      if (sink.baseUrl !== scope.base_url) throw new Error('claim_event_destination_conflict');
      const current = await readStable(path, MAX_RECOVERY_DOCUMENT_BYTES);
      if (current.sha256 !== retained.sha256) throw new Error('claim_event_packet_conflict');
    };
    await journal.append('claim_event_prepared', audit);
    const readReceipt = async (): Promise<StoredEventReceipt | undefined> => {
      await verifyPinnedContext();
      const outcome = await readEventReceipts(sink, scope, [event.id as string]);
      if (outcome.kind !== 'ok') throw new Error('claim_event_receipt_unanswered');
      const receipt = outcome.value.receipts[0];
      if (receipt && !matchesPreparedEventReceipt(receipt, eventJson, scope, actor)) {
        throw new Error('claim_event_receipt_conflict');
      }
      return receipt;
    };
    let receipt = await readReceipt();
    if (!receipt) {
      if(options.allowPost===false) throw new Error('claim_adopted_receipt_unavailable');
      await journal.append('claim_event_post_intent', audit);
      // Any quota wait precedes the final authenticated source/packet proof.
      const permit = await sink.reserveRecoveryWrite();
      let outcome: { kind: string; httpStatus?: number; retryAfterMs?: number };
      try {
        await verifyPinnedContext();
        // Transport failures remain uncertain; their prose never enters audit.
        try { outcome = await sink.postEvents([event as unknown as WireEvent], { recoveryWritePermit: permit }); }
        catch { outcome = { kind: 'unknown' }; }
      } finally { sink.releaseRecoveryWrite(permit); }
      await journal.append('claim_event_post_outcome', { ...audit, kind: outcome.kind,
        ...(Number.isInteger(outcome.httpStatus) ? { http_status: outcome.httpStatus } : {}),
        ...(Number.isInteger(outcome.retryAfterMs) ? { retry_after_ms: outcome.retryAfterMs } : {}) });
      receipt = await readReceipt();
      if (!receipt) throw new Error('claim_event_delivery_unverified');
    }
    await journal.append('claim_event_verified', { ...audit, receipt });
    return receipt;
  });
}
