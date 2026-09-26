import { resolveGitCommonDir } from './attempt-budget.js';
import { loadConvergeRunState, writeState } from './run-state.js';
import { withNativeTarget } from './target-ownership.js';
import type { HarnessSink } from '../telemetry/sink.js';
import { getRun } from '../evidence/reads.js';
import type { FlushSummary } from '../telemetry/outbox.js';

type FlushReconciliationSummary = Pick<FlushSummary, 'remaining' | 'failed' | 'dropped'>;
type ReconcileOptions = Parameters<typeof reconcileDeliveredRun>[2];

export function shouldReconcileDeliveredRun(runId: string | undefined, summary: FlushReconciliationSummary): runId is string {
  return runId !== undefined && summary.remaining.length === 0 && summary.failed.length === 0 && summary.dropped.length === 0;
}

export async function reconcileDeliveredRun(runId: string, sink: HarnessSink, options: { cwd?: string; gitCommonDir?: string; getRun?: typeof getRun } = {}): Promise<'reconciled' | 'unchanged'> {
  const read = await (options.getRun ?? getRun)(sink, runId);
  if (read.kind !== 'ok') return 'unchanged';
  const detail = read.value, target = detail.converge?.target;
  if (!target || target === '.' || target === '..' || !/^[A-Za-z0-9._-]+$/.test(target) || detail.id.toLowerCase() !== runId.toLowerCase()) return 'unchanged';
  let common: string;
  try {
    common = options.gitCommonDir ?? await resolveGitCommonDir(options.cwd);
  } catch {
    return 'unchanged';
  }
  return withNativeTarget(common, target, async ownership => {
    const state = await loadConvergeRunState(common, target), launch = state?.lastLaunch;
    const round = detail.converge?.round, attempt = detail.converge?.attempt, headSha = detail.target.head_sha;
    if (!state || !launch || launch.status !== 'completed' || !launch.deliveryPending ||
      typeof launch.runId !== 'string' || typeof launch.reportJsonSha256 !== 'string' ||
      !Number.isSafeInteger(launch.round) || !Number.isSafeInteger(launch.attempt) || typeof launch.headSha !== 'string' ||
      !Number.isSafeInteger(round) || !Number.isSafeInteger(attempt) || typeof headSha !== 'string' ||
      launch.runId.toLowerCase() !== runId.toLowerCase() ||
      round !== launch.round || attempt !== launch.attempt || headSha !== launch.headSha ||
      !detail.artifacts?.some(artifact => artifact.kind === 'report_json' && artifact.stored &&
        typeof artifact.declared_sha256 === 'string' && artifact.declared_sha256 === launch.reportJsonSha256)) return 'unchanged';
    state.lastLaunch = { ...launch, deliveryPending: false };
    state.updatedAt = new Date().toISOString();
    await writeState(common, state, ownership);
    return 'reconciled';
  });
}

/** Reconciliation is optional local bookkeeping after a successful flush. */
export async function reconcileFlushedRun(
  runId: string | undefined,
  summary: FlushReconciliationSummary,
  sink: HarnessSink,
  options: ReconcileOptions & { reconcile?: typeof reconcileDeliveredRun; onError?: (error: unknown) => void } = {}
): Promise<'reconciled' | 'unchanged'> {
  if (!shouldReconcileDeliveredRun(runId, summary)) return 'unchanged';
  const { reconcile = reconcileDeliveredRun, onError, ...reconcileOptions } = options;
  try {
    return await reconcile(runId, sink, reconcileOptions);
  } catch (error) {
    onError?.(error);
    return 'unchanged';
  }
}
