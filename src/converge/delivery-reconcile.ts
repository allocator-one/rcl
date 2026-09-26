import { createHash } from 'node:crypto';
import { getRun } from '../evidence/reads.js';
import type { RunDetail } from '../evidence/types.js';
import { openReadSink, type ReadSinkOptions } from '../telemetry/read-sink.js';
import type { HarnessSink, SinkOutcome } from '../telemetry/sink.js';
import type { GuardedLaunchState } from './launch-guard.js';

export interface GuardedDeliveryIdentity {
  runId: string;
  target: string;
  round: number;
  attempt: number;
  headSha: string;
  reportJsonSha256: string;
}

interface DeliveryReadSink {
  getArtifact(runId: string, kind: 'report_json', limit: number): Promise<SinkOutcome<{ bytes: Buffer; sha256: string }>>;
}

export interface DeliveryConfirmationDependencies {
  openReadSink: (options: ReadSinkOptions) => Promise<{ sink: DeliveryReadSink | null }>;
  getRun: (sink: DeliveryReadSink, runId: string) => Promise<SinkOutcome<RunDetail>>;
}

export interface GuardedDeliveryConfirmationOptions {
  target: string;
  rclVersion: string;
  cwd: string;
  dependencies?: DeliveryConfirmationDependencies;
}

const defaultDependencies: DeliveryConfirmationDependencies = {
  openReadSink: async options => {
    const opened = await openReadSink(options);
    return { sink: opened.sink };
  },
  getRun: (sink, runId) => getRun(sink as HarnessSink, runId),
};

/** Build the exact-run delivery receipt check used by guarded review launches. */
export function createGuardedDeliveryConfirmer(options: GuardedDeliveryConfirmationOptions):
  (previous: GuardedLaunchState) => Promise<boolean> {
  const dependencies = options.dependencies ?? defaultDependencies;
  return async previous => {
    if (!previous.runId || !previous.reportJsonSha256) return false;
    const opened = await dependencies.openReadSink({ rclVersion: options.rclVersion, cwd: options.cwd });
    if (!opened.sink) return false;
    const outcome = await dependencies.getRun(opened.sink, previous.runId);
    if (outcome.kind !== 'ok') return false;
    return verifyGuardedDelivery(outcome.value, {
      runId: previous.runId, target: options.target, round: previous.round, attempt: previous.attempt,
      headSha: previous.headSha, reportJsonSha256: previous.reportJsonSha256,
    }, async (runId, limit) => {
      const artifact = await opened.sink!.getArtifact(runId, 'report_json', limit);
      return artifact.kind === 'ok' ? artifact.value.bytes : null;
    });
  };
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
  const artifact = run!.artifacts!.find(item => item.kind === 'report_json' && item.stored === true &&
    item.declared_sha256 === expected.reportJsonSha256);
  const bytes = artifact?.declared_bytes;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 25_000_000) return false;
  try {
    const report = await readReport(expected.runId, bytes);
    return report !== null && report.length === bytes &&
      createHash('sha256').update(report).digest('hex') === expected.reportJsonSha256;
  } catch { return false; }
}
