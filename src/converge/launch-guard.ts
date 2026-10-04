import { terminalRejectionForLaunch, verifyTerminalRejections } from './terminal-rejection.js';
import { inspectLegacyRetry, retainLegacyRetry, type LegacyRetrySelection } from './legacy-launch-health.js';
import { hasSuccessfulQuorum } from '../dispatch/quorum.js';
import { completionSchema, launchSchema, ordinaryLaunchInputsBindingSchema,
  type GuardedLaunchState, type GuardedLaunchCompletion, type OrdinaryLaunchInputsBinding } from './launch-record.js';
export { launchSchema, type GuardedLaunchState, type GuardedLaunchCompletion, type OrdinaryLaunchInputsBinding } from './launch-record.js';
import { isDeepStrictEqual } from 'node:util';
import { assertNoPendingFreshReview, freshReviewCompletionPending, freshReviewRequestVersion, prepareFreshReview, finishFreshReview, verifyReviewCycle } from './fresh-review.js';
import type { ReviewCycleRemote } from './review-cycle.js';
import { withNativeTarget, type NativeTargetOwnership } from './target-ownership.js';
import { RegistryCleanupError } from '../coordination/registry-lock.js';
import { convergeAttemptStatePath } from './attempt-budget.js';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  claimConvergeAttempt, previewConvergeAttemptState, ConvergeAttemptBudgetExceededError,
  type ConvergeAttemptClaim,
} from './attempt-budget.js';
import {
  initialConvergeRunState, loadConvergeRunState, resolveRoundResolution, validateRoundCap,
  writeState, ConvergeRoundCapError, type ConvergeRunState,
} from './run-state.js';
import type { ConvergeContext } from '../report/run-header.js';
import { staleManifest, StaleReportAuditError } from './stale-report-schema.js';
import { verifyStaleReportReceipts } from './stale-report.js';
import { canonicalStaleRetryReason } from './stale-retry-reason.js';
import { scrubText } from '../telemetry/scrub.js';
import { verifyBoundFixRecovery, type BoundFixRecoverySelection } from './bound-fix-recovery.js';
import { boundFixRecoverySourceSchema, type BoundFixRecoverySource } from './bound-fix-recovery-source.js';
import { createOriginalLaunch, encodeOriginalLaunch, remainingOriginalBudget,
  type OriginalLaunch, type OriginalLaunchInput } from '../dispatch/original-launch.js';
import { captureCurrentProcessIdentity } from './process-identity.js';

/** Canonical original descriptor prepared under target ownership, before its claim is spent. */
export interface PreparedOriginalLaunch {
  readonly launch: OriginalLaunch;
  readonly launchBytes: string;
}
export interface OriginalLaunchPreflight {
  input: Omit<OriginalLaunchInput, 'target' | 'originalNativeClaim'>;
  /** Persist the immutable package while the target is exclusively owned, before spending the claim. */
  beforeClaim: (value: PreparedOriginalLaunch, ownership: NativeTargetOwnership) => Promise<void>;
  nowMs?: () => number;
}

export interface GuardedLaunchOptions {
  gitCommonDir: string;
  target: string;
  headSha: string;
  inputSha256: string;
  round?: number;
  maxAttempts?: number;
  maxRounds?: number;
  intent?: 'review' | 'stop-upstream' | 'stop-review' | 'retry-delivery';
  retryReason?: string;
  legacyRetry?: LegacyRetrySelection;
  boundFixRecovery?: BoundFixRecoverySelection;
  startOver?: boolean;
  cycleRemote?: ReviewCycleRemote;
  validate: () => Promise<void>;
  /** Optional retained execution only; ordinary launch behavior is unchanged. */
  originalLaunch?: OriginalLaunchPreflight;
  /** Retain authenticated launch inputs under ownership after validation, before spending the native claim. */
  beforeClaim?: (context: ConvergeContext, ownership: NativeTargetOwnership) => Promise<void | {
    ordinaryInputs: OrdinaryLaunchInputsBinding;
  }>;
  onClaim?: (claim: ConvergeAttemptClaim) => Promise<void>;
  /** Reuse this ownership for durable reviewer checkpoints; never take a second target lock. */
  run: (context: ConvergeContext, ownership: NativeTargetOwnership, original?: PreparedOriginalLaunch) => Promise<GuardedLaunchCompletion>;
}

export class ReviewLaunchRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ReviewLaunchRefused';
  }
}

function refuse(code: string, message: string): never {
  throw new ReviewLaunchRefused(code, message);
}

function nextRound(state: ConvergeRunState): number {
  validateRoundCap(state.roundCap);
  if (state.rounds.some(entry => !Number.isSafeInteger(entry.round) || entry.round < 1)) {
    refuse('invalid_round_state', 'Native admitted rounds are invalid; refusing to reset them.');
  }
  return state.rounds.reduce((latest, entry) => Math.max(latest, entry.round), 0) + 1;
}

async function requireLaunch(options: GuardedLaunchOptions, state: ConvergeRunState, attemptsUsed: number): Promise<{
  round: number;
  retryProof?: Awaited<ReturnType<typeof inspectLegacyRetry>>;
  boundFixRecoverySource?: BoundFixRecoverySource;
}> {
  const intent = options.intent ?? 'review';
  if (!['review', 'stop-upstream', 'stop-review', 'retry-delivery'].includes(intent)) {
    refuse('invalid_intent', 'Choose review, stop-upstream, stop-review, or retry-delivery.');
  }
  if (intent === 'stop-review') refuse('review_stopped', 'No review will launch. Stop only the recorded host task when cancellation was requested.');
  if (intent === 'retry-delivery') refuse('delivery_only', 'Retry evidence delivery with rcl telemetry flush, not another review.');
  if (!/^[a-f0-9]{40}$/.test(options.headSha) || !/^[a-f0-9]{64}$/.test(options.inputSha256)) {
    refuse('invalid_input_identity', 'A guarded launch needs an exact head and effective-input SHA256.');
  }
  if (options.retryReason !== undefined) {
    try { options.retryReason = canonicalStaleRetryReason(options.retryReason); }
    catch { refuse('invalid_retry_reason', 'An explicit bounded retry needs a nonempty reason of at most 500 characters.'); }
  }
  const round = nextRound(state);
  if (options.round !== undefined && options.round !== round) {
    refuse('wrong_round', `Native admitted state requires round ${round}, not ${options.round}.`);
  }
  if (round > state.roundCap) throw new ConvergeRoundCapError(options.target, round, state.roundCap);
  const resolution = round > 1 ? resolveRoundResolution(state, round - 1) : undefined;
  if (round > 1 && (!resolution || resolution.status === 'unresolved')) {
    refuse('triage_required', 'Resolve the existing native gating findings before another launch.');
  }
  const previous = state.lastLaunch === undefined ? undefined : launchSchema.parse(state.lastLaunch);
  const terminalRejected = previous?.status === 'completed' && await terminalRejectionForLaunch(options.gitCommonDir, state);
  if (previous?.deliveryFailure === 'local-invalid' && !terminalRejected) {
    refuse('terminal_rejection_proof_required', 'Inspect the original quarantine and preview rcl converge-rejected; a local-invalid marker is not recovery proof.');
  }
  let boundFixRecoverySource: BoundFixRecoverySource | undefined;
  if (options.boundFixRecovery) {
    const recovery = options.boundFixRecovery;
    if (options.startOver || options.legacyRetry || options.originalLaunch ||
      options.retryReason !== undefined || intent !== 'review') {
      refuse('bound_fix_recovery_incompatible', 'Bound fix recovery cannot be combined with a fresh review or another retry mode.');
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(recovery.runId) ||
      !/^[^/\s]{1,100}\/[^/\s]{1,100}$/.test(recovery.repo) || !Number.isSafeInteger(recovery.prNumber) || recovery.prNumber < 1 ||
      !previous || previous.status !== 'completed' || previous.attempt !== attemptsUsed ||
      previous.round !== round - 1 || previous.runId !== recovery.runId || previous.headSha !== options.headSha ||
      previous.inputSha256 !== options.inputSha256 || previous.deliveryPending || previous.hardFailure ||
      !hasHealthyGuardedLaunch(previous) ||
      !state.rounds.some(entry => entry.round === previous.round && entry.runId === recovery.runId) ||
      resolution?.status !== 'converged-dismissal-only' || resolution.fixedThisRound !== 0) {
      refuse('bound_fix_recovery_ineligible', 'Recovery requires the latest completed, healthy, delivered and admitted native dismissal-only round on these exact inputs.');
    }
    try {
      const proof = await verifyBoundFixRecovery(recovery, options.target, options.headSha, previous.round);
      boundFixRecoverySource = boundFixRecoverySourceSchema.parse({
        version: 1, runId: recovery.runId, target: options.target, repo: recovery.repo,
        prNumber: recovery.prNumber, headSha: options.headSha, inputSha256: options.inputSha256,
        round: previous.round, attempt: previous.attempt, ...proof,
      });
    }
    catch { refuse('bound_fix_recovery_invalid', 'Live Harness evidence did not prove the selected exact-head bound fix obligation; no attempt was claimed.'); }
  }
  if (options.legacyRetry && (!options.retryReason || options.startOver || intent !== 'review' ||
    !previous || previous.status !== 'completed' || previous.attempt !== attemptsUsed)) {
    refuse('retry_report_ineligible_launch', 'Select a completed original legacy launch and provide its explicit bounded retry reason.');
  }
  if (!previous) {
    if (attemptsUsed > 0 && !options.retryReason) {
      refuse('legacy_dispatch_unknown', 'Existing claims remain spent; supply an explicit retry reason after checking their original outcomes.');
    }
    return { round };
  }
  if (state.staleReportAudit?.some(e => staleManifest(e).attempt === previous.attempt) && previous.attempt !== attemptsUsed) {
    refuse('stale_report_attempt_mismatch', 'Attempt accounting changed after the inspected stale disposition.');
  }
  if (previous.attempt !== attemptsUsed) {
    if (!options.retryReason) refuse('untracked_claim', 'Native attempt accounting changed outside the guard; reconcile the original claim and provide an explicit retry reason.');
    return { round };
  }
  if (previous.status !== 'completed') {
    if (!options.retryReason) refuse('dispatch_unknown', 'Previous dispatch is unknown; no automatic retry. Supply a bounded retry reason only after recovery.');
    return { round };
  }
  if (terminalRejected && !options.retryReason) refuse('terminal_rejection_retry_reason', 'The rejected attempt remains spent; provide an explicit bounded retry reason.');
  if (previous.deliveryPending && ((previous.headSha === options.headSha && previous.inputSha256 === options.inputSha256) ||
    !state.rounds.some(entry => entry.round === previous.round && entry.runId === previous.runId))) {
    refuse('delivery_pending', `Run ${previous.runId} already completed; retry delivery with rcl telemetry flush --run ${previous.runId}.`);
  }
  let retryProof: Awaited<ReturnType<typeof inspectLegacyRetry>> | undefined;
  if (options.legacyRetry) {
    try { retryProof = await inspectLegacyRetry(options.legacyRetry, options.gitCommonDir, state, previous, attemptsUsed, round); }
    catch { refuse('retry_report_invalid', 'The original report does not prove an inconclusive launch under its bound policy.'); }
  }
  const healthy = retryProof ? hasSuccessfulQuorum(retryProof.binding.reviewerHealth.policy,
    retryProof.binding.reviewerHealth.successfulSeats) : hasHealthyGuardedLaunch(previous);
  let disposed = terminalRejected;
  if (healthy && !terminalRejected && !state.rounds.some(entry => entry.round === previous.round && entry.runId === previous.runId)) {
    const candidates = (state.staleReportAudit ?? []).filter(e => staleManifest(e).attempt === previous.attempt);
    const entry = candidates.find(e => {
      const m = staleManifest(e);
      return m.headSha === options.headSha && m.inputSha256 === options.inputSha256;
    });
    if (candidates.length > 0 && !entry) refuse('stale_report_input_mismatch', `Inspect these replacement inputs, then preview rcl converge-stale with --head ${options.headSha} --input-sha256 ${options.inputSha256}.`);
    if (!entry) refuse('report_not_admitted', `Process the existing report for run ${previous.runId}. If materially stale, preview rcl converge-stale with current --head ${options.headSha} --input-sha256 ${options.inputSha256}; never admit stale findings.`);
    const disposition = staleManifest(entry);
    disposed = true;
    if (disposition.runId !== previous.runId || disposition.reportSha256 !== previous.reportJsonSha256 ||
      disposition.previousHeadSha !== previous.headSha || disposition.previousInputSha256 !== previous.inputSha256 ||
      disposition.round !== previous.round) refuse('stale_report_launch_mismatch', 'The audited original launch changed.');
    if (disposition.headSha !== options.headSha || disposition.inputSha256 !== options.inputSha256) {
      refuse('stale_report_input_mismatch', 'The stale disposition is bound to different current review inputs.');
    }
    if (previous.hardFailure) {
      const reconciliation = previous.deliveryReconciliation;
      const shared = disposition.version !== 1 && disposition.outcome === 'delivered-hard-failure' &&
        disposition.retryReason === options.retryReason && disposition.cycleId === (state.cycle?.id ?? null) &&
        isDeepStrictEqual(disposition.reviewerHealth,previous.reviewerHealth) && reconciliation?.version === 2;
      const binding = shared && (disposition.version === 3
        ? isDeepStrictEqual(disposition.deliveryReconciliation,reconciliation)
        : disposition.deliveryReconciliation.version === 1 &&
          disposition.deliveryReconciliation.runId === reconciliation.runId &&
          disposition.deliveryReconciliation.reportJsonSha256 === reconciliation.reportJsonSha256 &&
          disposition.deliveryReconciliation.headSha === reconciliation.headSha &&
          disposition.deliveryReconciliation.attempt === reconciliation.attempt &&
          disposition.deliveryReconciliation.round === reconciliation.round);
      if (!binding) refuse('stale_report_continuation_mismatch',
        'The audited stale disposition does not authorize this exact delivered hard-failure retry.');
    } else if (disposition.version !== 1) {
      refuse('stale_report_launch_mismatch', 'A delivered hard-failure disposition cannot authorize ordinary stale work.');
    }

  }
  if (healthy && !disposed && !boundFixRecoverySource && previous.headSha === options.headSha && previous.inputSha256 === options.inputSha256) {
    refuse('inputs_unchanged', (resolution?.fixedThisRound ?? 0) > 0
      ? 'A real fix needs changed review inputs and a fresh resulting head.'
      : 'These inputs were already reviewed; upstream tip movement alone needs no new council.');
  }
  // A disposed unadmitted report may already follow the fixed round's commit.
  if (healthy && !disposed && (resolution?.fixedThisRound ?? 0) > 0 && previous.headSha === options.headSha) {
    refuse('fix_head_unchanged', 'Commit and push the real fix before reviewing its resulting head.');
  }
  if ((previous.hardFailure || !healthy) && !options.retryReason) {
    refuse('infrastructure_failure', 'A head change cannot cure the previous infrastructure failure; supply an explicit bounded retry reason after recovery.');
  }
  if (!healthy && !previous.reviewerHealth && !retryProof) {
    refuse('legacy_health_unknown', 'Aggregate counts do not prove blocking health. Select the original report with --retry-report and preserve its original inputs.');
  }
  return { round, retryProof, boundFixRecoverySource };
}

/** Shared launch-health decision; recovery paths must use the guard's policy. */
export function hasHealthyGuardedLaunch(previous: GuardedLaunchState): boolean {
  return previous.reviewerHealth
    ? hasSuccessfulQuorum(previous.reviewerHealth.policy, previous.reviewerHealth.successfulSeats)
    : previous.successfulReviews! >= Math.max(2, Math.ceil(2 * previous.totalReviews! / 3));
}

export interface GuardedLaunchClaim extends ConvergeAttemptClaim {
  resumedCompletion?: GuardedLaunchCompletion;
}

export async function guardReviewLaunch(input: GuardedLaunchOptions): Promise<GuardedLaunchClaim> {
  const original = input.originalLaunch;
  if (original !== undefined && (!original || typeof original.beforeClaim !== 'function' ||
    original.nowMs !== undefined && typeof original.nowMs !== 'function')) {
    refuse('invalid_original_preflight', 'Original launch preflight must be callable.');
  }
  let retryReason = input.retryReason;
  if (retryReason !== undefined) {
    try { retryReason = canonicalStaleRetryReason(retryReason); }
    catch { refuse('invalid_retry_reason', 'An explicit bounded retry needs a nonempty reason of at most 500 characters.'); }
  }
  const options = { ...input, retryReason, target: input.target.trim(), originalLaunch: original === undefined ? undefined : {
    input: structuredClone(original.input), beforeClaim: original.beforeClaim, nowMs: original.nowMs,
  },
    ...(input.legacyRetry ? { legacyRetry: { ...structuredClone(input.legacyRetry), reportPath: resolve(input.legacyRetry.reportPath) } } : {}) };
  options.gitCommonDir = await realpath(resolve(options.gitCommonDir));
  const requestVersion = options.startOver ? await freshReviewRequestVersion(options.gitCommonDir, options.target) : undefined;
  let completed: GuardedLaunchClaim | undefined;
  try {
    return await withNativeTarget(options.gitCommonDir, options.target, async ownership => {
      if (options.startOver && await freshReviewRequestVersion(options.gitCommonDir, options.target) !== requestVersion) {
        refuse('fresh_review_request_changed', 'Another launch handled the pending fresh request; inspect its outcome before requesting another cycle.');
      }
      completed = await guardReviewLaunchOwned(options, ownership);
      return completed;
    }, { lockTimeoutMs: 5_000 });
  } catch (error) {
    if (!(error instanceof RegistryCleanupError) || !completed || error.result !== completed) throw error;
    completed.warning = `Attempt ${completed.attempt}/${completed.cap} is durably recorded; target lock cleanup failed. Do not repeat the claim: ${error.message}`;
    return completed;
  }
}

async function guardReviewLaunchOwned(options: GuardedLaunchOptions, ownership: NativeTargetOwnership): Promise<GuardedLaunchClaim> {
  let preparedOriginal: PreparedOriginalLaunch | undefined;
  const assertOriginalLive = () => {
    if (preparedOriginal && remainingOriginalBudget(preparedOriginal.launch,
      (options.originalLaunch?.nowMs ?? Date.now)()).remainingMs === 0) {
      refuse('original_launch_expired', 'The original launch deadline expired before its claim was spent.');
    }
  };
  let state: ConvergeRunState;
  let failure: { error: unknown } | undefined;
  let freshOperation: string | undefined;
  if (options.startOver) {
    if (!options.cycleRemote) refuse('fresh_review_remote_required', 'A fresh review needs a connected Harness PR.');
    if (options.round !== undefined) refuse('fresh_review_ordinal', 'A fresh review assigns its own round.');
    await requireLaunch(options, initialConvergeRunState(options.target), 0);
    const completionPending = await freshReviewCompletionPending(options.gitCommonDir, options.target);
    if (!completionPending) await options.validate();
    const fresh = await prepareFreshReview({ ...options, remote: options.cycleRemote, ownership });
    freshOperation = fresh.operationId;
    const resumed = await loadConvergeRunState(options.gitCommonDir, options.target);
    const attempts = await previewConvergeAttemptState(options.gitCommonDir, options.target);
    if (resumed?.lastLaunch?.status === 'completed' && attempts?.cycle?.id === fresh.cycle.id &&
      resumed.lastLaunch.attempt === attempts.attemptsUsed) {
      await finishFreshReview(options.gitCommonDir, options.target, freshOperation, ownership);
      return { target: options.target, attempt: attempts.attemptsUsed, attemptsUsed: attempts.attemptsUsed,
        cap: attempts.cap, cycle: fresh.cycle, stateFile: convergeAttemptStatePath(options.gitCommonDir, options.target),
        resumedCompletion: completionSchema.parse(resumed.lastLaunch) };
    }
    if (completionPending) await options.validate();
    if (attempts && attempts.attemptsUsed > 0 && options.retryReason === undefined) {
      options.retryReason = 'Resuming an explicitly requested fresh review after interrupted local dispatch; previous attempts remain spent.';
    }
  } else {
    await assertNoPendingFreshReview(options.gitCommonDir, options.target);
  }
  const processIdentity = process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32'
    ? await captureCurrentProcessIdentity()
    : undefined;
  const claim = await claimConvergeAttempt({
    gitCommonDir: options.gitCommonDir,
    target: options.target,
    maxAttempts: options.maxAttempts,
    ownership,
    freshReviewOperation: freshOperation,
    beforeClaim: async () => {
      try {
        state = await loadConvergeRunState(options.gitCommonDir, options.target) ?? initialConvergeRunState(options.target);
        await verifyStaleReportReceipts(options.gitCommonDir,state.staleReportAudit ?? []);
        const { verifyHistoricalDeliveryReconciliations } = await import('./historical-delivery-reconciliation.js');
        await verifyHistoricalDeliveryReconciliations(options.gitCommonDir,state);
        await verifyTerminalRejections(options.gitCommonDir, state);
      }
      catch (error) {
        if (!(error instanceof StaleReportAuditError)) throw error;
        refuse('stale_report_audit_invalid','Retained stale-report evidence is missing or inconsistent; no attempt was claimed.');
      }
      if (options.maxRounds !== undefined) state.roundCap = validateRoundCap(options.maxRounds);
      const attempts = await previewConvergeAttemptState(options.gitCommonDir, options.target);
      const recovery = options.boundFixRecovery;
      if (recovery && attempts?.attempts.some(({ boundFixRecoverySource: source }) =>
        source && source.target === options.target && source.repo.toLowerCase() === recovery.repo.toLowerCase() &&
        source.prNumber === recovery.prNumber && source.headSha === options.headSha)) {
        refuse('bound_fix_recovery_already_claimed', 'A bound fix recovery attempt was already claimed for this target, PR and head; inspect the server obligation before requesting further review.');
      }
      if (!isDeepStrictEqual(state.cycle, attempts?.cycle)) refuse('fresh_review_state_pair_mismatch', 'The native cycle files disagree.');
      if (state.cycle) {
        await verifyReviewCycle(options.gitCommonDir, options.target, state.cycle);
        const remote = options.cycleRemote;
        if (!remote || remote.repo.toLowerCase() !== state.cycle.repo || remote.prNumber !== state.cycle.prNumber || remote.url !== state.cycle.url) {
          refuse('fresh_review_remote_mismatch', 'Continue this cycle against its original Harness PR.');
        }
        if ((await remote.current())?.id !== state.cycle.id) refuse('fresh_review_superseded', 'This review cycle has been replaced.');
      }
      const { round, retryProof, boundFixRecoverySource } = await requireLaunch(options, state, attempts?.attemptsUsed ?? 0);
      const cap = options.maxAttempts ?? attempts?.cap;
      if (cap !== undefined && attempts && attempts.attemptsUsed >= cap) {
        throw new ConvergeAttemptBudgetExceededError(options.target, attempts.attemptsUsed, cap);
      }
      if (!options.startOver) await options.validate();
      if (options.originalLaunch) {
        const launch = createOriginalLaunch({ ...options.originalLaunch.input, target: options.target,
          originalNativeClaim: { attempt: (attempts?.attemptsUsed ?? 0) + 1, round } });
        preparedOriginal = Object.freeze({ launch, launchBytes: encodeOriginalLaunch(launch) });
        assertOriginalLive();
        await options.originalLaunch.beforeClaim(preparedOriginal, ownership);
        assertOriginalLive();
      }
      // Pending-package export covers ordinary launches only. Special launch
      // modes keep their own recovery contract and must not inherit this
      // capture's size or storage requirements.
      const ordinaryLaunch = !options.startOver && !state.cycle && !options.originalLaunch &&
        !options.legacyRetry && !options.boundFixRecovery;
      const retained = ordinaryLaunch ? await options.beforeClaim?.(Object.freeze({ target: options.target, round,
        attempt: (attempts?.attemptsUsed ?? 0) + 1 }), ownership) : undefined;
      const ordinaryInputs = retained === undefined ? undefined : ordinaryLaunchInputsBindingSchema.parse(retained.ordinaryInputs);
      if (retryProof) await retainLegacyRetry(options.gitCommonDir, retryProof);
      assertOriginalLive();
      state.lastLaunch = {
        status: 'pending', attempt: (attempts?.attemptsUsed ?? 0) + 1, round,
        headSha: options.headSha, inputSha256: options.inputSha256,
        startedAt: new Date().toISOString(), pid: process.pid,
        ...(processIdentity ? { processIdentity } : {}),
        ...(ordinaryInputs ? { ordinaryInputs } : {}),
        ...(preparedOriginal ? { retainedOriginal: { version: 1 as const, runId: preparedOriginal.launch.runId,
          planDigest: preparedOriginal.launch.planDigest, capturedInputsSha256: preparedOriginal.launch.capturedInputsSha256 } } : {}),
        ...(options.retryReason ? { retryReason: scrubText(options.retryReason.trim(), 500) } : {}),
        ...(options.boundFixRecovery ? { retryReason: `Bound fix recovery from conclusive dismissal-only run ${options.boundFixRecovery.runId} for ${options.boundFixRecovery.repo}#${options.boundFixRecovery.prNumber}.` } : {}),
      };
      return retryProof ? { retrySource: retryProof.binding }
        : boundFixRecoverySource ? { boundFixRecoverySource } : undefined;
    },
    afterClaim: async (claimed, ownership) => {
      if (preparedOriginal && (preparedOriginal.launch.originalNativeClaim.attempt !== claimed.attempt ||
        preparedOriginal.launch.originalNativeClaim.round !== state.lastLaunch!.round)) {
        refuse('original_launch_claim_mismatch', 'The spent claim differs from the prepared original launch.');
      }
      state.lastLaunch!.attempt = claimed.attempt;
      await writeState(options.gitCommonDir, state, ownership);
      try {
        await options.onClaim?.(claimed);
        const context = { target: options.target, round: state.lastLaunch!.round, attempt: claimed.attempt,
          ...(state.cycle ? { cycleId: state.cycle.id } : {}) };
        const completion = completionSchema.parse(await (preparedOriginal
          ? options.run(context, ownership, preparedOriginal) : options.run(context, ownership)));
        if (preparedOriginal && completion.runId !== preparedOriginal.launch.runId) {
          refuse('original_launch_run_mismatch', 'The completion differs from the prepared original run.');
        }
        state.lastLaunch = { ...state.lastLaunch!, ...completion, status: 'completed' };
      } catch (error) {
        state.lastLaunch!.status = 'failed';
        failure = { error };
      }
      state.updatedAt = new Date().toISOString();
      await writeState(options.gitCommonDir, state, ownership);
      if (freshOperation) await finishFreshReview(options.gitCommonDir, options.target, freshOperation, ownership);
    },
  }).catch(async (error: unknown) => {
    if (freshOperation && error instanceof ConvergeAttemptBudgetExceededError) {
      // End only this exhausted operation; the spent/unknown dispatch stays intact.
      // A later deliberate fresh request may allocate another cycle.
      await finishFreshReview(options.gitCommonDir, options.target, freshOperation, ownership);
    }
    throw error;
  });
  if (failure) throw failure.error;
  return claim;
}
