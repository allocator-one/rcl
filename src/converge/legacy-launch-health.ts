import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { configIdentity, sha256Hex, type RosterEntry } from '../report/run-header.js';
import { deriveBlockingHealth } from '../report/blocking-health.js';
import { originalRunReportSchema } from '../telemetry/recovery/source.js';
import { readStable } from '../telemetry/recovery/files.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { prepareLockRoot } from '../evidence/original-run/lock-path.js';
import { retainStaleFile } from './stale-report-storage.js';
import { convergeRunStatePath, type ConvergeRunState } from './run-state.js';
import { convergeAttemptStatePath, validateConvergeAttemptState } from './attempt-budget.js';
import { launchSchema, type GuardedLaunchState, type GuardedReviewerHealth } from './launch-record.js';
import { retrySourceSchema, type RetrySource } from './retry-source.js';
import { authenticHistoricalRoster } from './legacy-roster.js';

type OriginalReport = ReturnType<typeof originalRunReportSchema.parse>;

/**
 * 4.1.10 is the last guarded-launch producer before review cycles were added.
 * It already bound the exact roster, config digest, converge ordinals and
 * per-seat outcomes used below, but it cannot truthfully carry cycle state.
 */
function supportedLegacyRetryProducer(report: OriginalReport, state: ConvergeRunState,
  attempts: ReturnType<typeof validateConvergeAttemptState>): boolean {
  if (report.run.rcl_version === '4.1.10') {
    return report.run.cycle_id === undefined && state.cycle === undefined && attempts.cycle === undefined;
  }
  return ['4.1.11', '4.1.12'].includes(report.run.rcl_version);
}

/** Known original producers merge a blocking seat successfully only when all chunks succeed. */
export function mergedBlockingHealth(report: OriginalReport, fraction: number): GuardedReviewerHealth {
  const roster = report.run.roster.filter(seat => seat.lane === 'blocking');
  const keys = new Set<string>();
  const outcomes = new Map<string, OriginalReport['reviews'][number]>();
  const key = (value: { model: string; role: string; provider: string }) => JSON.stringify([value.model, value.role, value.provider]);
  // The historical merger grouped by model/role, so duplicate pairs (even via
  // another route) cannot prove distinct original seat instances from this artifact.
  for (const seat of report.run.roster) {
    const pair = JSON.stringify([seat.model, seat.role]);
    if (keys.has(pair)) throw new Error('retry_report_ambiguous_roster');
    keys.add(pair);
  }
  const allowed = new Map(report.run.roster.map(seat => [key(seat), seat]));
  for (const review of report.reviews) {
    if (review.async === true) continue;
    const identity = key(review);
    const seat = allowed.get(identity);
    if (!seat) throw new Error('retry_report_ambiguous_reviews');
    if (seat.lane !== 'blocking') continue;
    if (outcomes.has(identity)) throw new Error('retry_report_ambiguous_reviews');
    outcomes.set(identity, review);
  }
  if (roster.length === 0 || outcomes.size !== roster.length) throw new Error('retry_report_incomplete_roster');
  // The shared report reader counts only blocking lanes. Legacy provenance
  // checks above additionally refuse ambiguous assignment-instance coverage.
  const health = deriveBlockingHealth({ roster: report.run.roster, fraction,
    reviews: report.reviews.map(review => ({ ...review, findings: [] })) });
  return { version: 1, policy: health.policy, successfulSeats: health.successfulSeats.length };
}

export interface LegacyRetrySelection {
  reportPath: string;
  config: Config;
  roster: RosterEntry[];
  historicalPlan?: boolean;
}

/** Re-authenticate the immutable legacy source retained on an already-spent retry claim. */
export async function inspectPendingLegacyRetry(input: LegacyRetrySelection, common: string,
  state: ConvergeRunState, pending: GuardedLaunchState,
  attempts: ReturnType<typeof validateConvergeAttemptState>) {
  if (pending.status !== 'pending' || attempts.attemptsUsed !== pending.attempt) {
    throw new Error('retry_pending_ineligible_launch');
  }
  const claim = attempts.attempts.find(item => item.attempt === pending.attempt);
  const binding = claim?.retrySource;
  if (!claim || claim.pid !== pending.pid || !binding || pending.round !== binding.round) {
    throw new Error('retry_pending_binding_mismatch');
  }
  const sourceDir = join(common, 'rcl-converge-attempts', 'sources');
  const [reportBytes, configBytes, nativeBytes, attemptBytes] = await Promise.all([
    readStable(join(sourceDir, binding.reportJsonSha256)),
    readStable(join(sourceDir, binding.configSha256)),
    readStable(join(sourceDir, binding.nativeStateSha256)),
    readStable(join(sourceDir, binding.attemptStateSha256)),
  ]);
  const report = originalRunReportSchema.parse(decodeOriginalReport(reportBytes.text).value);
  const sourceNative = decodeOriginalReport(nativeBytes.text).value as ConvergeRunState;
  const sourceAttempts = validateConvergeAttemptState(
    decodeOriginalReport(attemptBytes.text).value, state.target, 'pending retry source'
  );
  const sourceLaunch = launchSchema.parse(sourceNative.lastLaunch);
  if (reportBytes.sha256 !== binding.reportJsonSha256 || configBytes.sha256 !== binding.configSha256 ||
    nativeBytes.sha256 !== binding.nativeStateSha256 || attemptBytes.sha256 !== binding.attemptStateSha256 ||
    configBytes.text !== configIdentity(input.config) ||
    report.run.id !== binding.runId || report.run.target.head_sha !== binding.headSha ||
    report.run.converge?.target !== state.target || report.run.converge?.attempt !== binding.attempt ||
    report.run.converge?.round !== binding.round || report.run.config_sha256 !== binding.configSha256 ||
    !isDeepStrictEqual(report.run.roster, input.roster) ||
    (input.historicalPlan === true && !authenticHistoricalRoster(report.run, input.config)) ||
    sourceLaunch.status !== 'completed' || sourceLaunch.runId !== binding.runId ||
    sourceLaunch.reportJsonSha256 !== binding.reportJsonSha256 || sourceLaunch.attempt !== binding.attempt ||
    sourceLaunch.round !== binding.round || sourceLaunch.headSha !== binding.headSha ||
    sourceLaunch.inputSha256 !== binding.inputSha256 || sourceAttempts.attemptsUsed !== binding.attempt ||
    !sourceAttempts.attempts.some(item => item.attempt === binding.attempt && item.pid === sourceLaunch.pid) ||
    !isDeepStrictEqual(mergedBlockingHealth(report, input.config.quorumFraction!), binding.reviewerHealth) ||
    pending.headSha !== binding.headSha || !supportedLegacyRetryProducer(report, sourceNative, sourceAttempts)) {
    throw new Error('retry_pending_binding_mismatch');
  }
  return { binding, report, sourceLaunch };
}

/** Read-only proof under native ownership, before either accounting file changes. */
export async function inspectLegacyRetry(input: LegacyRetrySelection, common: string, state: ConvergeRunState,
  previous: GuardedLaunchState, attemptsUsed: number, nextRound: number) {
  const admitted = state.rounds.filter(round => round.runId === previous.runId);
  const sourceRoundMatches = admitted.length === 0
    ? previous.round === nextRound
    : admitted.length === 1 && previous.round === nextRound - 1 && admitted[0]!.round === previous.round &&
      state.rounds.filter(round => round.round === previous.round).length === 1;
  if (previous.status !== 'completed' || previous.reviewerHealth !== undefined || previous.deliveryPending ||
    previous.attempt !== attemptsUsed ||
    !sourceRoundMatches || input.config.quorumFraction === undefined) throw new Error('retry_report_ineligible_launch');
  const [reportBytes, nativeBytes, attemptBytes] = await Promise.all([
    readStable(input.reportPath), readStable(convergeRunStatePath(common, state.target)),
    readStable(convergeAttemptStatePath(common, state.target)),
  ]);
  const original = decodeOriginalReport(reportBytes.text).value;
  const report = originalRunReportSchema.parse(original);
  const native = decodeOriginalReport(nativeBytes.text).value as ConvergeRunState;
  const attempts = validateConvergeAttemptState(decodeOriginalReport(attemptBytes.text).value, state.target, 'retry source');
  if (!isDeepStrictEqual(native, state) || attempts.attemptsUsed !== attemptsUsed ||
    !attempts.attempts.some(claim => claim.attempt === previous.attempt && claim.pid === previous.pid && claim.source === 'claim') ||
    !isDeepStrictEqual(state.cycle, attempts.cycle)) throw new Error('retry_report_state_changed');
  const configBytes = Buffer.from(configIdentity(input.config));
  if (reportBytes.sha256 !== previous.reportJsonSha256 || report.run.id !== previous.runId ||
    report.run.target.head_sha !== previous.headSha || report.run.converge?.target !== state.target ||
    report.run.converge?.round !== previous.round || report.run.converge?.attempt !== previous.attempt ||
    report.run.cycle_id !== state.cycle?.id || report.run.config_sha256 !== sha256Hex(configBytes) ||
    !isDeepStrictEqual(report.run.roster, input.roster) ||
    (input.historicalPlan === true && !authenticHistoricalRoster(report.run, input.config)) ||
    report.run.provenance === 'backfill' ||
    !supportedLegacyRetryProducer(report, state, attempts) ||
    report.stats.totalReviews !== previous.totalReviews || report.stats.successfulReviews !== previous.successfulReviews ||
    report.reviews.length !== previous.totalReviews ||
    report.reviews.filter(review => review.status === 'success').length !== previous.successfulReviews) {
    throw new Error('retry_report_binding_mismatch');
  }
  const reviewerHealth = mergedBlockingHealth(report, input.config.quorumFraction);
  const binding = retrySourceSchema.parse({ version: 1, runId: previous.runId, reportJsonSha256: reportBytes.sha256,
    configSha256: sha256Hex(configBytes), nativeStateSha256: nativeBytes.sha256, attemptStateSha256: attemptBytes.sha256,
    headSha: previous.headSha, inputSha256: previous.inputSha256, attempt: previous.attempt, round: previous.round,
    reviewerHealth });
  return { binding, objects: [reportBytes.raw, configBytes, nativeBytes.raw, attemptBytes.raw] };
}

/** Immutable source objects for the canonical claim, not another recovery journal. */
export async function retainLegacyRetry(common: string, proof: { binding: RetrySource; objects: Buffer[] }): Promise<void> {
  const directory = await prepareLockRoot(join(common, 'rcl-converge-attempts', 'sources'));
  for (const bytes of proof.objects) await retainStaleFile(join(directory, sha256Hex(bytes)), bytes);
  // Recheck both source snapshots immediately before the claim. Cooperative writers
  // are already excluded by the same native target ownership as ordinary launches.
  const original = decodeOriginalReport(proof.objects[2]!.toString('utf8')).value as ConvergeRunState;
  if ((await readStable(convergeRunStatePath(common, original.target))).sha256 !== proof.binding.nativeStateSha256 ||
    (await readStable(convergeAttemptStatePath(common, original.target))).sha256 !== proof.binding.attemptStateSha256) {
    throw new Error('retry_report_state_changed');
  }
}
