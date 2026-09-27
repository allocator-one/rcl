import { DEFAULT_CONCURRENCY, DEFAULT_MAX_RETRIES, DEFAULT_REASONING_EFFORT, DEFAULT_TIMEOUT_MS } from '../config/defaults.js';
import { withOwnedNativeOperation, type NativeTargetOwnership } from '../converge/target-ownership.js';
import { decodeCapturedInputs, type CapturedReviewerInputs } from './captured-inputs.js';
import { CheckpointJournal, freezeCheckpointPlan, type FrozenCheckpointPlan } from './checkpoint.js';
import { decodeOriginalLaunch, encodeOriginalLaunch, remainingOriginalBudget,
  type OriginalLaunch, type OriginalRuntimeBounds } from './original-launch.js';
import { recoverReviewerAssignments, type ReviewerRecoveryOptions, type ReviewerRecoveryResult } from './recovery.js';

export interface BindOriginalCouncilOptions {
  commonDir: string;
  ownership: NativeTargetOwnership;
  captured: CapturedReviewerInputs;
  launch: OriginalLaunch;
}

function assertOriginalRetryBounds(launch: OriginalLaunch, captured: CapturedReviewerInputs): void {
  const attempts = (captured.config.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
  if (launch.maxAttemptsPerCell > attempts || launch.maxPhysicalCalls > captured.plan.cells.length * attempts) {
    throw new Error('original_execution_retry_policy_raise');
  }
}

/**
 * Persist original inputs and limits under the launch guard's existing ownership,
 * before any physical request. A duplicate run must reopen its existing journal;
 * it cannot create another run identity or replace the saved budget here.
 * The caller still establishes the native claim and provider/server authority.
 */
export async function bindOriginalCouncil(input: BindOriginalCouncilOptions): Promise<CheckpointJournal> {
  input = { ...input };
  const launchBytes = encodeOriginalLaunch(input.launch), launch = decodeOriginalLaunch(launchBytes);
  const captured = decodeCapturedInputs(input.captured.bytes, input.captured.plan);
  if (launch.target !== captured.plan.target || launch.planDigest !== captured.plan.digest ||
    launch.capturedInputsSha256 !== captured.digest) throw new Error('original_execution_capture_mismatch');
  assertOriginalRetryBounds(launch, captured);
  return withOwnedNativeOperation(input.ownership, input.commonDir, launch.target, async ownership => {
    const journal = await CheckpointJournal.create({ commonDir: input.commonDir, ownership,
      namespace: launch.runId, plan: captured.plan });
    await journal.bind('captured-inputs', captured.bytes, ownership);
    await journal.bind('launch', launchBytes, ownership);
    return journal;
  });
}

export interface OriginalExecutionOptions extends Pick<ReviewerRecoveryOptions,
  'commonDir' | 'ownership' | 'journal' | 'expectedPlan' | 'adapterFactory' | 'signal' |
  'auditLateReview' | 'auditLateAttempt' | 'onLateAuditError' | 'onPhysicalReviewComplete'> {
  launch: OriginalLaunch;
  runtimeBounds?: OriginalRuntimeBounds;
  nowMs?: () => number;
}

/**
 * Run the original matrix through the same bounded, durable request engine used
 * for missing-reviewer recovery. There is no invented source run and no reused
 * source call in its accounting. Seal and assemble only after this returns;
 * finalized journals require a new supported successor rather than more calls.
 */
export async function executeCapturedOriginal(input: OriginalExecutionOptions): Promise<ReviewerRecoveryResult> {
  const launchBytes = encodeOriginalLaunch(input.launch);
  const expectedPlan: FrozenCheckpointPlan = freezeCheckpointPlan(input.expectedPlan);
  const runtimeBounds = input.runtimeBounds === undefined ? undefined : structuredClone(input.runtimeBounds);
  const options = { ...input };
  return withOwnedNativeOperation(options.ownership, options.commonDir, expectedPlan.target, async ownership => {
    const bindings = await options.journal.readBindings();
    if (bindings['captured-inputs'] === undefined || bindings.launch === undefined) throw new Error('original_execution_missing_bindings');
    if (bindings.source !== undefined || bindings.operation !== undefined) throw new Error('original_execution_successor_binding');
    const launch = decodeOriginalLaunch(bindings.launch);
    if (bindings.launch !== launchBytes || launch.target !== expectedPlan.target ||
      launch.planDigest !== expectedPlan.digest) throw new Error('original_execution_launch_mismatch');
    const captured = decodeCapturedInputs(bindings['captured-inputs'], expectedPlan);
    if (launch.capturedInputsSha256 !== captured.digest) throw new Error('original_execution_capture_mismatch');
    assertOriginalRetryBounds(launch, captured);
    if ((await options.journal.read()).finalized) throw new Error('original_execution_finalized');
    const budget = remainingOriginalBudget(launch, (options.nowMs ?? Date.now)(), runtimeBounds);
    return recoverReviewerAssignments({ commonDir: options.commonDir, ownership, journal: options.journal,
      expectedPlan, plan: captured.plan, assignments: captured.assignments, prompts: captured.prompts,
      sourceAttempts: [], fraction: captured.policy.fraction, remainingMs: budget.remainingMs,
      maxAdditionalCalls: budget.maxPhysicalCalls, maxAttemptsPerCell: budget.maxAttemptsPerCell,
      timeoutMs: captured.config.timeout ?? DEFAULT_TIMEOUT_MS,
      concurrency: captured.config.concurrency ?? DEFAULT_CONCURRENCY,
      reasoningEffort: captured.config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
      adapterFactory: options.adapterFactory, signal: options.signal,
      onPhysicalReviewComplete: options.onPhysicalReviewComplete,
      auditLateReview: options.auditLateReview, auditLateAttempt: options.auditLateAttempt,
      onLateAuditError: options.onLateAuditError });
  });
}
