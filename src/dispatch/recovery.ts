import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelReview } from '../consensus/types.js';
import { assertNativeTargetOwnership, withOwnedNativeOperation, type NativeTargetOwnership } from '../converge/target-ownership.js';
import type { BuiltPrompt } from '../prepare/prompt-builder.js';
import type { ReviewAssignment } from '../roles/types.js';
import { CheckpointJournal, freezeCheckpointPlan, type CheckpointState, type FrozenCheckpointPlan, type PaidAttempt } from './checkpoint.js';
import { previewReviewerRecovery, type RecoveryAttempt, type RecoveryPreview } from './recovery-policy.js';
import { resolveQuorumPolicy } from './quorum.js';
import { reviewCallIdentity, runReviews, type RunnerOptions } from './runner.js';
import { retryDelay } from './utils.js';
import { DEFAULT_CONCURRENCY, DEFAULT_REASONING_EFFORT, DEFAULT_TIMEOUT_MS } from '../config/defaults.js';
import { decodeCapturedInputs } from './captured-inputs.js';
import { decodeRecoveryOperation, encodeRecoveryOperation, remainingRecoveryBudget,
  type RecoveryOperation, type RecoveryRuntimeBounds } from './recovery-operation.js';

export interface ReviewerRecoveryOptions {
  commonDir: string;
  ownership: NativeTargetOwnership;
  /** New successor journal; original terminal journals are read-only sources. */
  journal: CheckpointJournal;
  plan: FrozenCheckpointPlan;
  expectedPlan: FrozenCheckpointPlan;
  assignments: ReviewAssignment[];
  prompts: BuiltPrompt[];
  /** Validated immutable source history, excluding the successor's own attempts. */
  sourceAttempts: readonly RecoveryAttempt[];
  fraction: number;
  maxAdditionalCalls: number;
  maxAttemptsPerCell: number;
  /** Remaining time from the persisted operation, not a new budget on resume. */
  remainingMs: number;
  timeoutMs: number;
  concurrency: number;
  adapterFactory?: RunnerOptions['adapterFactory'];
  reasoningEffort?: RunnerOptions['reasoningEffort'];
  signal?: AbortSignal;
  auditLateReview?: RunnerOptions['auditLateReview'];
  /** Audit-only callback pinned to the durable physical intent from its wave. */
  auditLateAttempt?: (review: ModelReview, callIndex: number, paidAttempt: PaidAttempt) => void | Promise<void>;
  onLateAuditError?: RunnerOptions['onLateAuditError'];
}

export interface ReviewerRecoveryResult {
  preview: RecoveryPreview;
  /** Complete original matrix order, with unstarted/uncertain cells explicit. */
  reviews: ModelReview[];
  /** All attempts charged to this successor, including earlier interrupted invocations. */
  newAttempts: number;
  stoppedBy?: 'canceled' | 'no_dispatch';
  /** Setup failures are diagnostics, never newly billed or successful attempts. */
  setupFailures?: Array<{ cell: string; review: ModelReview }>;
}

export type CapturedRecoveryOptions = Omit<ReviewerRecoveryOptions,
  'plan' | 'assignments' | 'prompts' | 'fraction' | 'maxAdditionalCalls' | 'maxAttemptsPerCell' | 'remainingMs' |
  'timeoutMs' | 'concurrency' | 'reasoningEffort'> & {
  /** Exact operation already claimed and bound by the outer source/authority validator. */
  operation: RecoveryOperation;
  runtimeBounds?: RecoveryRuntimeBounds;
  nowMs?: () => number;
};

/**
 * Internal execution boundary for saved inputs and limits. This is not a CLI
 * admission path: the caller still validates source report/lineage, server
 * support, producer authority and the native launch claim before invoking it.
 * Only the existing journal supplies prompts and persisted spend/time caps.
 */
export async function recoverCapturedAssignments(options: CapturedRecoveryOptions): Promise<ReviewerRecoveryResult> {
  const expectedOperation = encodeRecoveryOperation(options.operation);
  const expectedPlan = freezeCheckpointPlan(options.expectedPlan);
  const sourceAttempts = structuredClone(options.sourceAttempts);
  const runtimeBounds = options.runtimeBounds === undefined ? undefined : structuredClone(options.runtimeBounds);
  const capturedOptions = { ...options, expectedPlan, sourceAttempts, runtimeBounds };
  return withOwnedNativeOperation(options.ownership, options.commonDir, expectedPlan.target, async ownership => {
    const bindings = await capturedOptions.journal.readBindings();
    if (bindings['captured-inputs'] === undefined || bindings.operation === undefined) throw new Error('recovery_missing_bindings');
    const operation = decodeRecoveryOperation(bindings.operation);
    if (bindings.operation !== expectedOperation || operation.target !== expectedPlan.target ||
      operation.planDigest !== expectedPlan.digest) throw new Error('recovery_operation_mismatch');
    const captured = decodeCapturedInputs(bindings['captured-inputs'], expectedPlan);
    if (captured.digest !== operation.capturedInputsSha256) throw new Error('recovery_captured_inputs_mismatch');
    const budget = remainingRecoveryBudget(operation, (capturedOptions.nowMs ?? Date.now)(), runtimeBounds);
    return recoverReviewerAssignments({ ...capturedOptions, ownership, plan: captured.plan,
      assignments: captured.assignments, prompts: captured.prompts, fraction: captured.policy.fraction,
      timeoutMs: captured.config.timeout ?? DEFAULT_TIMEOUT_MS,
      concurrency: captured.config.concurrency ?? DEFAULT_CONCURRENCY,
      reasoningEffort: captured.config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      remainingMs: budget.remainingMs, maxAdditionalCalls: budget.maxAdditionalCalls,
      maxAttemptsPerCell: budget.maxAttemptsPerCell });
  });
}

/** Read physical attempts without counting a reused source success as a new call. */
export function recoveryAttemptsFromCheckpoint(state: CheckpointState): RecoveryAttempt[] {
  const outcomes = new Map(state.outcomes.map(outcome => [outcome.paidAttempt.id, outcome]));
  return state.records.filter(record => record.type === 'intent').map(record => {
    const outcome = outcomes.get(record.paidAttempt!.id);
    if (outcome && outcome.cell !== record.cell) throw new Error('recovery_attempt_cell_mismatch');
    return { id: record.paidAttempt!.id, cell: record.cell!,
      ...(outcome ? { outcome: JSON.parse(outcome.result.reviewBytes) as ModelReview } : {}) };
  });
}

/**
 * Execute the missing portion under the guard's existing ownership. The caller
 * must first validate the source report/lineage, server capability and producer
 * authority, then claim the native attempt and provide its persisted bounds.
 * This engine never performs delivery, native admission or an approval decision.
 */
export async function recoverReviewerAssignments(input: ReviewerRecoveryOptions): Promise<ReviewerRecoveryResult> {
  const startedAt = performance.now();
  input = { ...input };
  if ((input.auditLateAttempt || input.auditLateReview) && typeof input.onLateAuditError !== 'function') {
    throw new Error('Late review audit requires an error sink');
  }
  const plan = freezeCheckpointPlan(input.plan);
  if (plan.digest !== input.plan.digest || plan.digest !== input.expectedPlan.digest ||
    JSON.stringify(plan.cells) !== JSON.stringify(input.plan.cells) ||
    JSON.stringify(plan.cells) !== JSON.stringify(input.expectedPlan.cells) ||
    input.journal.getPlan().digest !== plan.digest) throw new Error('recovery_plan_mismatch');
  const assignments = structuredClone(input.assignments), prompts = structuredClone(input.prompts);
  const sourceAttempts = structuredClone(input.sourceAttempts);
  if (assignments.length !== plan.cells.length || prompts.length !== plan.cells.length) throw new Error('recovery_matrix_mismatch');
  for (const [index, cell] of plan.cells.entries()) {
    const assignment = assignments[index]!, prompt = prompts[index]!;
    if (assignment.model !== cell.model || assignment.provider !== cell.route || assignment.role.name !== cell.role) {
      throw new Error('recovery_assignment_mismatch');
    }
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    if (digest(prompt.systemPrompt) !== cell.systemPromptSha256 || digest(prompt.userPrompt) !== cell.userPromptSha256) {
      throw new Error('recovery_prompt_mismatch');
    }
  }
  if (!Number.isFinite(input.remainingMs) || input.remainingMs < 0 || input.remainingMs > 2_147_483_647) {
    throw new Error('recovery_invalid_deadline');
  }
  const deadline = startedAt + input.remainingMs;
  await assertNativeTargetOwnership(input.ownership, input.commonDir, plan.target);
  // Serialize whole invocations using the guard's existing ownership. A second
  // resume must see the first one's completed writes, not a partially published
  // record. Child operations below remain reentrant without another target lock.
  return withOwnedNativeOperation(input.ownership, input.commonDir, plan.target, async ownership => {
    input = { ...input, ownership };
    const policy = resolveQuorumPolicy(plan.roster.length, input.fraction);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, deadline - performance.now()));
    let waves = 0;
    const setupFailuresByIndex = new Map<number, ModelReview>();

    function preview(attempts: RecoveryAttempt[], newAttempts: number): RecoveryPreview {
      return previewReviewerRecovery(plan.cells, attempts, policy, {
        maxAttemptsPerCell: input.maxAttemptsPerCell,
        maxAdditionalCalls: input.maxAdditionalCalls,
        additionalCallsUsed: newAttempts,
        remainingMs: Math.max(0, deadline - performance.now()),
      }, [...setupFailuresByIndex.keys()].map(index => plan.cells[index]!.id));
    }
    async function capture() {
      const state = await input.journal.read();
      const own = recoveryAttemptsFromCheckpoint(state);
      const attempts = [...sourceAttempts, ...own];
      return { state, attempts, own, preview: preview(attempts, own.length) };
    }
    function finish(snapshot: Awaited<ReturnType<typeof capture>>, stoppedBy?: ReviewerRecoveryResult['stoppedBy']): ReviewerRecoveryResult {
      const last = new Map(snapshot.attempts.map(attempt => [attempt.cell, attempt]));
      const reviews = plan.cells.map((cell, index) => setupFailuresByIndex.get(index) ?? last.get(cell.id)?.outcome ?? {
        model: cell.model, role: cell.role, provider: cell.route, status: 'canceled' as const,
        findings: [], durationMs: 0,
        error: last.has(cell.id) ? 'Provider outcome is uncertain and possibly billed.' : 'Original assignment has not been started.',
      });
      return { preview: snapshot.preview, reviews, newAttempts: snapshot.own.length,
        ...(setupFailuresByIndex.size ? { setupFailures: [...setupFailuresByIndex].map(([index, review]) => ({ cell: plan.cells[index]!.id, review })) } : {}),
        ...(stoppedBy ? { stoppedBy } : {}) };
    }
    try {
      while (true) {
        const before = await capture();
        if (before.preview.nextAction !== 'retry_missing_assignments') return finish(before);
        if (controller.signal.aborted) return finish(before, 'canceled');
        if (before.state.finalized) throw new Error('recovery_successor_finalized');
        const selected = new Map(before.attempts.filter(attempt => attempt.outcome?.status === 'success')
          .map(attempt => [attempt.cell, attempt.outcome!]));
        const inFlight = new Map<number, PaidAttempt>();
        const pendingIntentWrites: Promise<unknown>[] = [];
        const returned = await runReviews(assignments, prompts, {
          timeoutMs: input.timeoutMs, concurrency: input.concurrency,
          // Every physical call has a durable intent; SDK/adapter retries cannot
          // happen invisibly inside this accounting boundary.
          maxRetries: 0, reasoningEffort: input.reasoningEffort,
          adapterFactory: input.adapterFactory, quorum: { fraction: policy.fraction },
          seatIds: plan.cells.map(cell => cell.seat), signal: controller.signal,
          retainedReviews: before.preview.retainedCallIndices.map(callIndex => ({ callIndex,
            callIdentity: reviewCallIdentity(assignments[callIndex]!, prompts[callIndex]!, callIndex, plan.cells[callIndex]!.seat),
            review: selected.get(plan.cells[callIndex]!.id)!,
          })),
          eligibleCallIndices: before.preview.eligibleCallIndices.filter(index => !setupFailuresByIndex.has(index)),
          beforeReview: (index, signal) => {
            const operation = withOwnedNativeOperation(input.ownership, input.commonDir, plan.target, async ownership => {
              if (signal.aborted) return false;
              const current = await capture();
              // Our own running calls still have a chance to succeed. Treat their
              // pending intents as reserved work, not uncertain previous invocations,
              // when deciding whether another missing cell could complete quorum.
              const activeIds = new Set([...inFlight.values()].map(attempt => attempt.id));
              const planning = current.attempts.filter(attempt => attempt.outcome !== undefined || !activeIds.has(attempt.id));
              const now = preview(planning, current.own.length);
              if (now.nextAction !== 'retry_missing_assignments' || controller.signal.aborted ||
                !now.eligibleCallIndices.includes(index)) return false;
              const attempt: PaidAttempt = { id: randomUUID(), kind: 'paid' };
              await input.journal.recordIntent(plan.cells[index]!.id, attempt, ownership);
              inFlight.set(index, attempt);
            });
            pendingIntentWrites.push(operation);
            return operation;
          },
          acceptReview: async (review, index) => {
            const attempt = inFlight.get(index);
            if (!attempt) throw new Error('recovery_missing_paid_intent');
            const cell = plan.cells[index]!;
            if (review.status === 'canceled') {
              await input.journal.recordUncertain(cell.id, attempt, review.error ?? 'Provider canceled with an unknown outcome.', input.ownership);
            } else {
              const result = review.status === 'success'
                ? { kind: 'success' as const, chunk: cell.chunk, reviewBytes: JSON.stringify(review) }
                : { kind: 'failure' as const, chunk: cell.chunk, reviewBytes: JSON.stringify(review), possiblyBilled: true };
              await input.journal.recordResult(cell.id, attempt, result, input.ownership);
            }
          },
          auditLateReview: input.auditLateAttempt ? async (review, index) => {
            // This closure retains this wave's map, so a later retry can never
            // substitute its new paid intent for a delayed earlier response.
            const attempt = inFlight.get(index);
            if (!attempt) throw new Error('recovery_missing_late_paid_intent');
            const callbacks = [Promise.resolve().then(() => input.auditLateAttempt!(structuredClone(review), index, { ...attempt }))];
            if (input.auditLateReview) callbacks.push(Promise.resolve().then(() => input.auditLateReview!(structuredClone(review), index)));
            const failures = (await Promise.allSettled(callbacks)).filter(result => result.status === 'rejected').map(result => result.reason);
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) throw new AggregateError(failures, 'late_audit_callbacks_failed');
          } : input.auditLateReview,
          onLateAuditError: input.onLateAuditError,
        });
        // Provider cancellation can win while an already-started intent fsync
        // finishes. Drain those owned writes before reading the terminal state.
        await Promise.all(pendingIntentWrites);
        returned.forEach((review, index) => {
          if (review.status === 'error' && !inFlight.has(index)) setupFailuresByIndex.set(index, review);
        });
        const after = await capture();
        if (after.preview.nextAction !== 'retry_missing_assignments') return finish(after);
        if (after.own.length === before.own.length) {
          const stopped = finish(after, 'no_dispatch');
          return { ...stopped,
            preview: { ...stopped.preview, nextAction: 'inspect_blocked_assignments', eligibleCallIndices: [] },
          };
        }
        if (controller.signal.aborted) return finish(after, 'canceled');
        try { await delay(Math.min(retryDelay(waves++), Math.max(0, deadline - performance.now())), undefined, { signal: controller.signal }); }
        catch (error) { if (!controller.signal.aborted) throw error; }
      }
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
  });
}
