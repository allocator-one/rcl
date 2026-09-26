import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
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
import { scrubText } from '../telemetry/scrub.js';

const completionSchema = z.object({
  runId: z.string().uuid(),
  reportJsonSha256: z.string().regex(/^[a-f0-9]{64}$/),
  successfulReviews: z.number().int().nonnegative().safe(),
  totalReviews: z.number().int().positive().safe(),
  deliveryPending: z.boolean(),
  hardFailure: z.boolean().optional(),
}).refine(value => value.successfulReviews <= value.totalReviews);

export const launchSchema = z.object({
  status: z.enum(['pending', 'completed', 'failed']),
  attempt: z.number().int().positive().safe(),
  round: z.number().int().positive().safe(),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().datetime(),
  pid: z.number().int().positive().safe(),
  retryReason: z.string().min(1).max(500).optional(),
  runId: z.string().uuid().optional(),
  reportJsonSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  successfulReviews: z.number().int().nonnegative().safe().optional(),
  totalReviews: z.number().int().positive().safe().optional(),
  deliveryPending: z.boolean().optional(),
  hardFailure: z.boolean().optional(),
}).strict().refine(value => value.status !== 'completed' || completionSchema.safeParse(value).success);

export type GuardedLaunchState = z.infer<typeof launchSchema>;
export type GuardedLaunchCompletion = z.infer<typeof completionSchema>;

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
  validate: () => Promise<void>;
  /** Authenticated exact-run receipt check; no local delivery flag is trusted on its own. */
  confirmDelivery?: (previous: GuardedLaunchState) => Promise<boolean>;
  onClaim?: (claim: ConvergeAttemptClaim) => Promise<void>;
  run: (context: ConvergeContext) => Promise<GuardedLaunchCompletion>;
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

async function requireLaunch(options: GuardedLaunchOptions, state: ConvergeRunState, attemptsUsed: number): Promise<number> {
  const intent = options.intent ?? 'review';
  if (!['review', 'stop-upstream', 'stop-review', 'retry-delivery'].includes(intent)) {
    refuse('invalid_intent', 'Choose review, stop-upstream, stop-review, or retry-delivery.');
  }
  if (intent === 'stop-review') refuse('review_stopped', 'No review will launch. Stop only the recorded host task when cancellation was requested.');
  if (intent === 'retry-delivery') refuse('delivery_only', 'Retry evidence delivery with rcl telemetry flush, not another review.');
  if (!/^[a-f0-9]{40}$/.test(options.headSha) || !/^[a-f0-9]{64}$/.test(options.inputSha256)) {
    refuse('invalid_input_identity', 'A guarded launch needs an exact head and effective-input SHA256.');
  }
  if (options.retryReason !== undefined && (options.retryReason.trim() === '' || options.retryReason.length > 500)) {
    refuse('invalid_retry_reason', 'An explicit bounded retry needs a nonempty reason of at most 500 characters.');
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
  if (!previous) {
    if (attemptsUsed > 0 && !options.retryReason) {
      refuse('legacy_dispatch_unknown', 'Existing claims remain spent; supply an explicit retry reason after checking their original outcomes.');
    }
    return round;
  }
  if (state.staleReportAudit?.some(e => staleManifest(e).attempt === previous.attempt) && previous.attempt !== attemptsUsed) {
    refuse('stale_report_attempt_mismatch', 'Attempt accounting changed after the inspected stale disposition.');
  }
  if (previous.attempt !== attemptsUsed) {
    if (!options.retryReason) refuse('untracked_claim', 'Native attempt accounting changed outside the guard; reconcile the original claim and provide an explicit retry reason.');
    return round;
  }
  if (previous.status !== 'completed') {
    if (!options.retryReason) refuse('dispatch_unknown', 'Previous dispatch is unknown; no automatic retry. Supply a bounded retry reason only after recovery.');
    return round;
  }
  const previousRoundAdmitted = state.rounds.some(entry => entry.round === previous.round && entry.runId === previous.runId);
  const sameInputs = previous.headSha === options.headSha && previous.inputSha256 === options.inputSha256;
  if (previous.deliveryPending && (!previousRoundAdmitted || sameInputs)) {
    if (!sameInputs) {
      refuse('delivery_pending', `Run ${previous.runId} already completed; reconcile its delivery before reviewing different inputs.`);
    }
    const delivered = previous.runId && previous.reportJsonSha256 && options.confirmDelivery
      ? await options.confirmDelivery(previous).catch(() => false) : false;
    if (!delivered) {
      refuse('delivery_pending', `Run ${previous.runId} already completed; retry delivery with rcl telemetry flush --run ${previous.runId}.`);
    }
    if (!options.retryReason) {
      refuse('retry_reason_required', 'A received run needs an explicit bounded retry reason before another review.');
    }
  }
  const healthy = hasHealthyGuardedLaunch(previous);
  let disposed = false;
  if (healthy && !previousRoundAdmitted) {
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

  }
  if (healthy && !disposed && previous.headSha === options.headSha && previous.inputSha256 === options.inputSha256) {
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
  return round;
}

/** Shared launch-health decision; recovery paths must use the guard's policy. */
export function hasHealthyGuardedLaunch(previous: GuardedLaunchState): boolean {
  return previous.successfulReviews! >= Math.max(2, Math.ceil(2 * previous.totalReviews! / 3));
}

export async function guardReviewLaunch(input: GuardedLaunchOptions): Promise<ConvergeAttemptClaim> {
  const options = { ...input, target: input.target.trim() };
  options.gitCommonDir = await realpath(resolve(options.gitCommonDir));
  let state: ConvergeRunState;
  let failure: { error: unknown } | undefined;
  const claim = await claimConvergeAttempt({
    gitCommonDir: options.gitCommonDir,
    target: options.target,
    maxAttempts: options.maxAttempts,
    targetLockTimeoutMs: 5_000,
    beforeClaim: async () => {
      try {
        state = await loadConvergeRunState(options.gitCommonDir, options.target) ?? initialConvergeRunState(options.target);
        await verifyStaleReportReceipts(options.gitCommonDir,state.staleReportAudit ?? []);
      }
      catch (error) {
        if (!(error instanceof StaleReportAuditError)) throw error;
        refuse('stale_report_audit_invalid','Retained stale-report evidence is missing or inconsistent; no attempt was claimed.');
      }
      if (options.maxRounds !== undefined) state.roundCap = validateRoundCap(options.maxRounds);
      const attempts = await previewConvergeAttemptState(options.gitCommonDir, options.target);
      const round = await requireLaunch(options, state, attempts?.attemptsUsed ?? 0);
      const cap = options.maxAttempts ?? attempts?.cap;
      if (cap !== undefined && attempts && attempts.attemptsUsed >= cap) {
        throw new ConvergeAttemptBudgetExceededError(options.target, attempts.attemptsUsed, cap);
      }
      await options.validate();
      state.lastLaunch = {
        status: 'pending', attempt: (attempts?.attemptsUsed ?? 0) + 1, round,
        headSha: options.headSha, inputSha256: options.inputSha256,
        startedAt: new Date().toISOString(), pid: process.pid,
        ...(options.retryReason ? { retryReason: scrubText(options.retryReason.trim(), 500) } : {}),
      };
    },
    afterClaim: async (claimed, ownership) => {
      state.lastLaunch!.attempt = claimed.attempt;
      await writeState(options.gitCommonDir, state, ownership);
      try {
        await options.onClaim?.(claimed);
        const completion = completionSchema.parse(await options.run({
          target: options.target, round: state.lastLaunch!.round, attempt: claimed.attempt,
        }));
        state.lastLaunch = { ...state.lastLaunch!, ...completion, status: 'completed' };
      } catch (error) {
        state.lastLaunch!.status = 'failed';
        failure = { error };
      }
      state.updatedAt = new Date().toISOString();
      await writeState(options.gitCommonDir, state, ownership);
    },
  });
  if (failure) throw failure.error;
  return claim;
}
