import { loadConvergeAttemptState, recordConvergeAttemptLaunch, resolveGitCommonDir } from './attempt-budget.js';
import { loadConvergeRunState, writeState } from './run-state.js';
import { strongDeliveryReconciliationSchema } from './launch-record.js';
import { withNativeTarget } from './target-ownership.js';
import type { HarnessSink } from '../telemetry/sink.js';
import { getRun } from '../evidence/reads.js';
import type { FlushSummary } from '../telemetry/outbox.js';

type FlushReconciliationSummary = Pick<FlushSummary, 'remaining' | 'failed' | 'dropped'>;
type ReconcileOptions = Parameters<typeof reconcileDeliveredRun>[2];

export function shouldReconcileDeliveredRun(runId: string | undefined, summary: FlushReconciliationSummary): runId is string {
  return runId !== undefined && summary.remaining.length === 0 && summary.failed.length === 0 && summary.dropped.length === 0;
}

export async function reconcileDeliveredRun(runId: string, sink: HarnessSink, deps: { cwd?: string; gitCommonDir?: string; getRun?: typeof getRun; now?: () => Date } = {}): Promise<'reconciled' | 'unchanged'> {
  const read = await (deps.getRun ?? getRun)(sink, runId);
  if (read.kind !== 'ok') return 'unchanged';
  const detail = read.value, target = detail.converge?.target;
  if (!target || target === '.' || target === '..' || !/^[A-Za-z0-9._-]+$/.test(target) || detail.id.toLowerCase() !== runId.toLowerCase()) return 'unchanged';
  let common: string;
  try {
    common = deps.gitCommonDir ?? await resolveGitCommonDir(deps.cwd);
  } catch {
    return 'unchanged';
  }
  return withNativeTarget(common, target, async ownership => {
    const state = await loadConvergeRunState(common, target);
    const attempts = state?.version === 3 ? await loadConvergeAttemptState(common, target) : undefined;
    const launch = state?.version === 3 ? attempts?.lastLaunch : state?.lastLaunch;
    const round = detail.converge?.round, attempt = detail.converge?.attempt, headSha = detail.target.head_sha;
    const marker = launch?.deliveryReconciliation;
    const markerlessLegacy = launch?.deliveryPending === false && launch.hardFailure === true &&
      launch.exitCode === 4 && launch.deliveryReconciliation === undefined;
    const weakMarker = marker?.version === 1 && launch?.hardFailure === true && launch.deliveryPending === false &&
      launch.exitCode === 4 && marker.runId === launch.runId && marker.reportJsonSha256 === launch.reportJsonSha256 &&
      marker.headSha === launch.headSha && marker.attempt === launch.attempt && marker.round === launch.round;
    const needsStrongMarker = launch?.hardFailure === true &&
      (launch.deliveryPending === true || markerlessLegacy || weakMarker);
    const reports = detail.artifacts?.filter(artifact => artifact.kind === 'report_json') ?? [];
    const reconciledAt = (deps.now ?? (() => new Date()))().toISOString();
    const strongMarker = needsStrongMarker ? strongDeliveryReconciliationSchema.safeParse({ version: 2,
      runId: launch.runId, reportJsonSha256: launch.reportJsonSha256, headSha: launch.headSha,
      inputSha256: launch.inputSha256, attempt: launch.attempt, round: launch.round,
      claimPid: launch.pid, cycleId: state?.cycle?.id ?? null, reconciledAt }) : undefined;
    if (!state || !launch || launch.status !== 'completed' ||
      (!launch.deliveryPending && !markerlessLegacy && !weakMarker) ||
      (launch.deliveryReconciliation !== undefined && !weakMarker) || launch.deliveryFailure === 'local-invalid' ||
      typeof launch.runId !== 'string' || typeof launch.reportJsonSha256 !== 'string' ||
      !Number.isSafeInteger(launch.round) || !Number.isSafeInteger(launch.attempt) || typeof launch.headSha !== 'string' ||
      !Number.isSafeInteger(round) || !Number.isSafeInteger(attempt) || typeof headSha !== 'string' ||
      launch.runId.toLowerCase() !== runId.toLowerCase() ||
      round !== launch.round || attempt !== launch.attempt || headSha !== launch.headSha ||
      reports.length !== 1 || reports[0]!.stored !== true ||
      reports[0]!.declared_sha256 !== launch.reportJsonSha256 ||
      (strongMarker && (!strongMarker.success || detail.provenance !== 'live' ||
        (detail.cycle_id ?? null) !== (state.cycle?.id ?? null) ||
        (state.cycle !== undefined && (detail.target.repo?.toLowerCase() !== state.cycle.repo.toLowerCase() ||
          detail.target.pr_number !== state.cycle.prNumber))))) return 'unchanged';
    const reconciled = { ...launch, deliveryPending: false,
      ...(strongMarker?.success ? { deliveryReconciliation: strongMarker.data } : {}) };
    if (state.version === 3) {
      await recordConvergeAttemptLaunch(common, target, reconciled, ownership, 'delivery');
    } else {
      state.lastLaunch = reconciled;
      state.updatedAt = reconciledAt;
      await writeState(common, state, ownership);
    }
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
