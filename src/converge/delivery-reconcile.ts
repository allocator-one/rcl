import { createHash } from 'node:crypto';
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

/** Check the actual artifact bytes, not only the server's declared digest. */
export async function verifyGuardedDelivery(
  run: RunDetail | null,
  expected: GuardedDeliveryIdentity,
  readReport: (runId: string, limit: number) => Promise<Buffer | null>
): Promise<boolean> {
  if (!matchesGuardedDelivery(run, expected)) return false;
  const artifact = run!.artifacts!.find(item => item.kind === 'report_json');
  const bytes = artifact?.declared_bytes;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 25_000_000) return false;
  try {
    const report = await readReport(expected.runId, bytes);
    return report !== null && report.length === bytes &&
      createHash('sha256').update(report).digest('hex') === expected.reportJsonSha256;
  } catch { return false; }
}
