import { getGateStatus } from '../evidence/reads.js';
import { isGateStatus, isRunDetail } from '../evidence/types.js';
import type { HarnessSink } from '../telemetry/sink.js';
import { createHash } from 'node:crypto';
import type { BoundFixRecoverySource } from './bound-fix-recovery-source.js';

/** Live evidence reads are performed inside the native launch lock, before claiming. */
export interface BoundFixRecoverySelection {
  runId: string;
  repo: string;
  prNumber: number;
  read: () => Promise<{ status: unknown; run: unknown }>;
}

export function createBoundFixRecovery(
  sink: HarnessSink, repo: string, prNumber: number, runId: string,
): BoundFixRecoverySelection {
  return {
    repo, prNumber, runId,
    read: async () => {
      const [owner, name] = repo.split('/');
      const status = await getGateStatus(sink, owner, name, prNumber, { requireCompleteRead: true });
      if (status.kind !== 'ok') throw new Error('The live Harness PR status could not be read.');
      const run = await sink.getJson(`/api/v1/reviews/runs/${encodeURIComponent(runId)}`, (data, meta) => {
        if (!isRunDetail(data, runId)) return null;
        if (meta && typeof meta === 'object' && 'bound_classification_protocol' in meta &&
          meta.bound_classification_protocol !== 1) return null;
        return data;
      }, { requireCompleteRead: true });
      if (run.kind !== 'ok') throw new Error('The live Harness run could not be read.');
      return { status: status.value, run: run.value };
    },
  };
}

/** Only an exact, conclusive server projection with no remaining triage qualifies. */
export async function verifyBoundFixRecovery(
  selection: BoundFixRecoverySelection, target: string, headSha: string, round: number,
): Promise<Pick<BoundFixRecoverySource, 'verifiedAt' | 'serverProof'>> {
  const { status, run } = await selection.read();
  if (!isGateStatus(status, selection.repo, selection.prNumber) || !isRunDetail(run, selection.runId)) {
    throw new Error('Harness returned malformed or mismatched recovery evidence.');
  }
  const advisory = status.advisory;
  if (status.head?.merged !== false || status.head.sha !== headSha ||
    advisory.status !== 'fixes_pending' || advisory.conclusive !== true ||
    advisory.actionable.length !== 0 || advisory.head_sha !== headSha || advisory.run_id !== selection.runId ||
    ('classification_pending' in advisory && advisory.classification_pending !== false) ||
    ('legacy_pending_identities' in advisory &&
      (!Array.isArray(advisory.legacy_pending_identities) || advisory.legacy_pending_identities.length !== 0))) {
    throw new Error('The live PR does not have the selected conclusive, exact-head bound fix obligation.');
  }
  if (run.id !== selection.runId || run.target.repo?.toLowerCase() !== selection.repo.toLowerCase() ||
    run.target.pr_number !== selection.prNumber || run.target.head_sha !== headSha ||
    run.converge?.target !== target || run.converge.round !== round) {
    throw new Error('The selected Harness run does not match the latest native target, head and round.');
  }
  // Older serializers omit gating; an explicitly exposed protocol must agree.
  if (run.gating !== undefined && (run.gating === null || typeof run.gating !== 'object' || Array.isArray(run.gating))) {
    throw new Error('Harness returned malformed run gating evidence.');
  }
  if ((run.bound_classification_protocol !== undefined && run.bound_classification_protocol !== 1) ||
    (run.gating && 'bound_classification_protocol' in run.gating && run.gating.bound_classification_protocol !== 1)) {
    throw new Error('The selected run does not use bound classification protocol 1.');
  }
  return {
    verifiedAt: new Date().toISOString(),
    serverProof: {
      status: 'fixes_pending', conclusive: true, actionableCount: 0,
      classificationPending: advisory.classification_pending === false ? false : null,
      legacyPendingCount: Array.isArray(advisory.legacy_pending_identities) ? 0 : null,
      statusSha256: createHash('sha256').update(JSON.stringify(status)).digest('hex'),
      runSha256: createHash('sha256').update(JSON.stringify(run)).digest('hex'),
    },
  };
}
