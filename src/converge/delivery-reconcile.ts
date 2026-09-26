import type { RunDetail } from '../evidence/types.js';

export interface GuardedDeliveryIdentity {
  runId: string;
  target: string;
  round: number;
  attempt: number;
  headSha: string;
  reportJsonSha256: string;
}

/** A delivered run must match the guarded launch and its stored report bytes. */
export function matchesGuardedDelivery(run: RunDetail | null, expected: GuardedDeliveryIdentity): boolean {
  return run !== null && run.id === expected.runId && typeof run.received_at === 'string' &&
    Number.isFinite(Date.parse(run.received_at)) && run.repo_verified === true &&
    run.target.head_sha === expected.headSha && run.converge?.target === expected.target &&
    run.converge.round === expected.round && run.converge.attempt === expected.attempt &&
    run.artifacts?.some(artifact => artifact.kind === 'report_json' && artifact.stored === true &&
      artifact.declared_sha256 === expected.reportJsonSha256) === true;
}
