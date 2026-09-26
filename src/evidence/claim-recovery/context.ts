import type { HarnessSink, SinkOutcome } from '../../telemetry/sink.js';
import { normalizeUrl } from '../../telemetry/credentials.js';
import type { EventReceiptScope } from '../event-receipts.js';
import { object } from '../original-run/remote.js';
import { uuidSchema } from '../original-run/source.js';

export interface ClaimRecoverySelection {
  scope: EventReceiptScope;
  target: string;
  round: number;
  reportSha256: string;
  headSha: string;
}

export interface ClaimRecoveryContext { actorUserId: string; eventSequence: number }

/** Read the current operator and recovery capability against one exact source. */
export async function readClaimRecoveryContext(sink: HarnessSink, selection: ClaimRecoverySelection,
  expectedActor?: string): Promise<SinkOutcome<ClaimRecoveryContext>> {
  const { scope, target, round, reportSha256, headSha } = structuredClone(selection);
  if (!uuidSchema.safeParse(scope.org_id).success || !uuidSchema.safeParse(scope.run_id).success ||
      normalizeUrl(scope.base_url) !== scope.base_url || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repo) ||
      !Number.isSafeInteger(scope.pr_number) || scope.pr_number <= 0 ||
      !Number.isSafeInteger(round) || round <= 0 || !target || target.trim() !== target ||
      !/^[a-f0-9]{64}$/.test(reportSha256) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(headSha) ||
      expectedActor !== undefined && !uuidSchema.safeParse(expectedActor).success) {
    throw new Error('invalid_claim_recovery_selection');
  }
  if (sink.credentialSource === 'attest') throw new Error('unsupported_attested_recovery');
  if (sink.baseUrl !== scope.base_url) throw new Error('claim_recovery_destination_conflict');
  return sink.getJson(`/api/v1/reviews/runs/${scope.run_id}`, (data, meta) => {
    if (!object(meta) || meta.org_id !== scope.org_id || meta.evidence_protocol_version !== 2 ||
        meta.claim_recovery_version !== 1 || !uuidSchema.safeParse(meta.actor_user_id).success ||
        expectedActor !== undefined && meta.actor_user_id !== expectedActor ||
        !object(meta.recovery) || meta.recovery.truncated !== false ||
        !Number.isSafeInteger(meta.recovery.event_sequence) || (meta.recovery.event_sequence as number) < 0 ||
        !object(data) || data.id !== scope.run_id || !object(data.target) ||
        !['pr', 'patch'].includes(data.target.kind as string) || data.target.repo !== scope.repo ||
        data.target.pr_number !== scope.pr_number || data.target.head_sha !== headSha ||
        !object(data.converge) || data.converge.target !== target || data.converge.round !== round ||
        !Array.isArray(data.artifacts)) return null;
    const originals = data.artifacts.filter(a => object(a) && a.kind === 'report_json');
    if (originals.length !== 1 || originals[0].declared_sha256 !== reportSha256 || originals[0].stored !== true) return null;
    return { actorUserId: meta.actor_user_id as string, eventSequence: meta.recovery.event_sequence as number };
  }, { requireCompleteRead: true });
}
