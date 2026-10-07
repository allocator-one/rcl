import { isDeepStrictEqual } from 'node:util';
import { loadConvergeAttemptState, recordConvergeAttemptLaunch, resolveGitCommonDir } from './attempt-budget.js';
import { loadConvergeRunState, writeState, type ConvergeRunState } from './run-state.js';
import { launchSchema, strongDeliveryReconciliationSchema, type GuardedLaunchState } from './launch-record.js';
import { assertNoPendingFreshReview } from './fresh-review.js';
import { mergedBlockingHealth } from './legacy-launch-health.js';
import { withNativeTarget } from './target-ownership.js';
import { hasSuccessfulQuorum } from '../dispatch/quorum.js';
import { assertAdmissibleReportHealth } from '../report/blocking-health.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import type { RunDetail } from '../evidence/types.js';
import type { HarnessSink } from '../telemetry/sink.js';
import { getRun } from '../evidence/reads.js';
import type { FlushSummary } from '../telemetry/outbox.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';
import { originalRunReportSchema } from '../telemetry/recovery/source.js';
import { sha256 } from '../telemetry/recovery/files.js';

type FlushReconciliationSummary = Pick<FlushSummary, 'remaining' | 'failed' | 'dropped'>;
type ReconcileOptions = Parameters<typeof reconcileDeliveredRun>[2];

/** Prove the legacy omission from the original claim and authenticated report, never an inferred exit code. */
async function supportsMissingLegacyExit(common: string, state: ConvergeRunState,
  launch: GuardedLaunchState, detail: RunDetail, sink: HarnessSink): Promise<boolean> {
  const parsed = launchSchema.safeParse(launch);
  if (state.version !== 1 || state.cycle !== undefined || !parsed.success ||
    Object.hasOwn(launch, 'exitCode') || launch.status !== 'completed' || launch.deliveryPending !== false ||
    launch.hardFailure !== true || launch.deliveryFailure !== undefined || launch.deliveryReconciliation !== undefined ||
    launch.ordinaryInputs !== undefined || launch.retainedOriginal !== undefined || launch.recovery !== undefined ||
    launch.pendingResume !== undefined || launch.pendingRecovery !== undefined || !launch.reviewerHealth ||
    !hasSuccessfulQuorum(launch.reviewerHealth.policy, launch.reviewerHealth.successfulSeats)) return false;
  try {
    await assertNoPendingFreshReview(common, state.target);
    const attempts = await loadConvergeAttemptState(common, state.target);
    const claim = attempts?.attempts.find(item => item.attempt === launch.attempt);
    const nextRound = state.rounds.reduce((latest, round) => Math.max(latest, round.round), 0) + 1;
    if (!attempts || attempts.version !== 2 || attempts.cycle !== undefined || attempts.lastLaunch !== undefined ||
      attempts.attemptsUsed !== launch.attempt || !claim || claim.source !== 'claim' || claim.pid !== launch.pid ||
      !isDeepStrictEqual(claim.processIdentity, launch.processIdentity) || claim.handoff !== undefined ||
      claim.retrySource !== undefined || claim.boundFixRecoverySource !== undefined || claim.pendingRecoverySource !== undefined ||
      !Number.isSafeInteger(nextRound) || nextRound > state.roundCap || launch.round !== nextRound ||
      state.rounds.some(round => round.runId === launch.runId)) return false;

    const artifact = await sink.getArtifact(launch.runId!, 'report_json', MAX_ARTIFACT_BYTES);
    if (artifact.kind !== 'ok' || artifact.value.bytes.length > MAX_ARTIFACT_BYTES ||
      artifact.value.sha256 !== launch.reportJsonSha256 || sha256(artifact.value.bytes) !== launch.reportJsonSha256) return false;
    const text = artifact.value.bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(artifact.value.bytes)) return false;
    const report = originalRunReportSchema.parse(decodeOriginalReport(text).value);
    const originalTarget = report.run.target, serverTarget = detail.target;
    const sameTargetKind = serverTarget.kind === originalTarget.kind ||
      (originalTarget.kind === 'pr' && serverTarget.kind === 'pull_request');
    const declaration = detail.artifacts!.find(item => item.kind === 'report_json')!;
    if (report.run.id !== launch.runId || report.run.cycle_id !== undefined ||
      report.run.target.head_sha !== launch.headSha || report.run.converge?.target !== state.target ||
      report.run.converge.round !== launch.round || report.run.converge.attempt !== launch.attempt ||
      report.run.provenance === 'backfill' || report.run.gating.mode !== 'verified-consensus' ||
      ![0, 1].includes(report.run.ci_exit_code) || !sameTargetKind ||
      (serverTarget.repo != null && serverTarget.repo.toLowerCase() !== originalTarget.repo?.toLowerCase()) ||
      (serverTarget.pr_number != null && serverTarget.pr_number !== originalTarget.pr_number) ||
      (serverTarget.base_sha != null && serverTarget.base_sha !== originalTarget.base_sha) ||
      (serverTarget.diff_sha256 != null && serverTarget.diff_sha256 !== originalTarget.diff_sha256) ||
      (declaration.declared_bytes != null && declaration.declared_bytes !== artifact.value.bytes.length) ||
      report.stats.totalReviews !== launch.totalReviews || report.stats.successfulReviews !== launch.successfulReviews ||
      report.reviews.length !== launch.totalReviews ||
      report.reviews.filter(review => review.status === 'success').length !== launch.successfulReviews ||
      !isDeepStrictEqual(mergedBlockingHealth(report, launch.reviewerHealth.policy.fraction), launch.reviewerHealth)) return false;
    // The source schema validates the roster, rows and stats this reader uses;
    // presentation-only finding/spec types are deliberately not reconstructed.
    assertAdmissibleReportHealth(report as unknown as Parameters<typeof assertAdmissibleReportHealth>[0]);
    return true;
  } catch {
    // A refused/unreadable source leaves optional flush bookkeeping untouched.
    return false;
  }
}

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
    const missingLegacyExit = state?.version === 1 && state.cycle === undefined && launch?.exitCode === undefined;
    const markerlessLegacy = launch?.deliveryPending === false && launch.hardFailure === true &&
      (launch.exitCode === 4 || missingLegacyExit) && launch.deliveryReconciliation === undefined;
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
    if (markerlessLegacy && missingLegacyExit && !await supportsMissingLegacyExit(common, state, launch, detail, sink)) {
      return 'unchanged';
    }
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
