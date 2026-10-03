import { resolveGitCommonDir } from './attempt-budget.js';
import { loadConvergeRunState, writeState } from './run-state.js';
import { deliveryReconciliationSchema } from './launch-record.js';
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
    const legacyReconciledHardFailure = launch?.deliveryPending === false && launch.hardFailure === true &&
      launch.exitCode === 4 && launch.deliveryReconciliation === undefined;
    const reports = detail.artifacts?.filter(artifact => artifact.kind === 'report_json') ?? [];
    const reconciledAt = new Date().toISOString();
    const marker = launch?.hardFailure === true ? deliveryReconciliationSchema.safeParse({ version: 1,
      runId: launch.runId, reportJsonSha256: launch.reportJsonSha256, headSha: launch.headSha,
      inputSha256: launch.inputSha256, attempt: launch.attempt, round: launch.round,
      claimPid: launch.pid, cycleId: state?.cycle?.id ?? null, reconciledAt }) : undefined;
    if (!state || !launch || launch.status !== 'completed' ||
      (!launch.deliveryPending && !legacyReconciledHardFailure) || launch.deliveryFailure === 'local-invalid' ||
      typeof launch.runId !== 'string' || typeof launch.reportJsonSha256 !== 'string' ||
      !Number.isSafeInteger(launch.round) || !Number.isSafeInteger(launch.attempt) || typeof launch.headSha !== 'string' ||
      !Number.isSafeInteger(round) || !Number.isSafeInteger(attempt) || typeof headSha !== 'string' ||
      launch.runId.toLowerCase() !== runId.toLowerCase() ||
      round !== launch.round || attempt !== launch.attempt || headSha !== launch.headSha ||
      reports.length !== 1 || reports[0]!.stored !== true ||
      reports[0]!.declared_sha256 !== launch.reportJsonSha256 ||
      (marker && (!marker.success || detail.provenance !== 'live' ||
        (detail.cycle_id ?? null) !== (state.cycle?.id ?? null) ||
        (state.cycle !== undefined && (detail.target.repo?.toLowerCase() !== state.cycle.repo.toLowerCase() ||
          detail.target.pr_number !== state.cycle.prNumber))))) return 'unchanged';
    state.lastLaunch = { ...launch, deliveryPending: false,
      ...(marker?.success ? { deliveryReconciliation: marker.data } : {}) };
    state.updatedAt = reconciledAt;
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
