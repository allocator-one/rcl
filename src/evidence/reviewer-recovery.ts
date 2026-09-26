import { retainedPaidCutoff } from './retained-time-budget.js';
import { abortSignalWithTimeout } from '../telemetry/abort-signal.js';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ConvergeAttemptClaim } from '../converge/attempt-budget.js';
import { guardReviewerRecoveryLaunch, guardReviewerRecoveryResume,
  type ReviewerRecoveryLaunchOptions } from '../converge/recovery-launch.js';
import { retainedLaunchInputSha256 } from '../converge/retained-report.js';
import { CheckpointJournal, checkpointPath, exportCheckpointProof } from '../dispatch/checkpoint.js';
import { decodeCapturedInputs } from '../dispatch/captured-inputs.js';
import { createCheckpointLateAudit } from '../dispatch/late-audit.js';
import { executeCheckpointGating } from '../dispatch/checkpoint-gating-execution.js';
import { defaultAdapterFactory } from '../dispatch/runner.js';
import { recoverCapturedAssignments, type CapturedRecoveryOptions } from '../dispatch/recovery.js';
import { decodeRecoveryOperation, encodeRecoveryOperation, type RecoveryOperation } from '../dispatch/recovery-operation.js';
import { renderReportArtifacts } from '../output/artifacts.js';
import type { AssemblyDependencies } from '../report/assembly.js';
import { assembleCheckpointReview, type CheckpointAssemblyInput } from '../report/checkpoint-assembly.js';
import { projectCheckpointReport } from '../report/checkpoint-projection.js';
import { inspectReviewerArtifact, serializeReviewerArtifact, type ReviewerArtifact } from '../report/reviewer-artifact.js';
import { describeReviewerEvidence } from '../report/reviewer-evidence.js';
import type { ReviewerHealth } from '../report/reviewer-health.js';
import { sha256Hex, type RunHeaderInput } from '../report/run-header.js';
import { detectProvider } from '../roles/dispatcher.js';
import { sanitizeForDelivery } from '../telemetry/envelope.js';
import { UUID } from '../telemetry/recovery/source.js';
import { loadReviewerLineage, type ReviewerLineage } from './reviewer-lineage.js';

/** Immutable references for the caller's actual-credential capability/owner check. */
export interface ReviewerRecoveryPreflight {
  target: string;
  headSha: string;
  successorRunId: string;
  source: { runId: string; reportSha256: string; reviewerArtifactSha256: string };
  lineage: Array<{ runId: string; reportSha256: string; reviewerArtifactSha256: string }>;
}

interface CommonRecoveryOptions extends Pick<CapturedRecoveryOptions,
  'adapterFactory' | 'onPhysicalReviewComplete' | 'signal' | 'nowMs'> {
  commonDir: string;
  target: string;
  successorRunId: string;
  currentHeadSha: string;
  /** Recomputed from current effective inputs, retaining the original frozen model weights. */
  freshCaptureBytes: string;
  currentRunBindings: Pick<RunHeaderInput, 'target' | 'roster' | 'spec'>;
  rclVersion: string;
  runner: RunHeaderInput['runner'];
  /** Must verify server support and the exact source under the actual producer credential. */
  preflight: (request: ReviewerRecoveryPreflight, operationBytes: string) => Promise<void>;
  onLateAuditError: (error: unknown, callIndex: number) => void;
  onStage?: AssemblyDependencies['onStage'];
}

export interface ApplyReviewerRecoveryOptions extends CommonRecoveryOptions {
  sourceRunId: string;
  operationId: string;
  startedAtMs: number;
  expiresAtMs: number;
  maxAdditionalCalls: number;
  maxAttemptsPerCell: number;
  maxAttempts?: number;
}
export type ResumeReviewerRecoveryOptions = CommonRecoveryOptions;

export interface CompletedReviewerRecovery {
  kind: 'completed';
  claim: ConvergeAttemptClaim;
  operation: RecoveryOperation;
  reusedTerminal: boolean;
  /** PRIVATE in-process result; never print this object as CLI status or telemetry. */
  terminal: NonNullable<Awaited<ReturnType<CheckpointJournal['readTerminalReport']>>>;
  health: ReviewerHealth;
  gate: ReviewerArtifact['validation']['gate'];
}
export type ApplyReviewerRecoveryResult = CompletedReviewerRecovery |
  { kind: 'already_quorate'; sourceRunId: string };

type BoundExecution = Parameters<ReviewerRecoveryLaunchOptions['run']>[0];
function fail(code: string): never { throw new Error(`reviewer_recovery_${code}`); }

function snapshot(input: CommonRecoveryOptions): CommonRecoveryOptions {
  if (!input || typeof input.commonDir !== 'string' || !input.commonDir ||
    typeof input.target !== 'string' || !input.target.trim() || !UUID.test(input.successorRunId ?? '') ||
    !/^[a-f0-9]{40}$/.test(input.currentHeadSha ?? '') || typeof input.freshCaptureBytes !== 'string' ||
    typeof input.preflight !== 'function' || typeof input.onLateAuditError !== 'function' ||
    typeof input.rclVersion !== 'string' || !input.rclVersion || !input.runner ||
    !['agent', 'ci', 'human'].includes(input.runner.kind)) fail('invalid_input');
  // Do not let an awaiting preflight replace the caller's effective inputs or callbacks.
  return { commonDir: input.commonDir, target: input.target.trim(), successorRunId: input.successorRunId,
    currentHeadSha: input.currentHeadSha, freshCaptureBytes: input.freshCaptureBytes,
    currentRunBindings: structuredClone(input.currentRunBindings), rclVersion: input.rclVersion,
    runner: structuredClone(input.runner), preflight: input.preflight, onLateAuditError: input.onLateAuditError,
    adapterFactory: input.adapterFactory, onPhysicalReviewComplete: input.onPhysicalReviewComplete,
    signal: input.signal, nowMs: input.nowMs, onStage: input.onStage };
}

function preflightRequest(options: CommonRecoveryOptions, source: ReviewerLineage): ReviewerRecoveryPreflight {
  const references = source.runs.map(run => ({ runId: run.runId,
    reportSha256: run.terminal.reportSha256,
    reviewerArtifactSha256: sha256Hex(run.terminal.reviewerArtifactBytes) }));
  return { target: options.target, headSha: options.currentHeadSha,
    successorRunId: options.successorRunId, source: { ...references.at(-1)! },
    lineage: references.map(reference => ({ ...reference })) };
}

async function prepare(input: CommonRecoveryOptions, sourceRunId: string) {
  if (!UUID.test(sourceRunId ?? '') || sourceRunId === input.successorRunId) fail('invalid_source');
  const commonDir = await realpath(resolve(input.commonDir));
  const options = { ...input, commonDir };
  const source = await loadReviewerLineage({ commonDir, target: options.target, runId: sourceRunId });
  const inspected = source.latest.inspected;
  const inputSha256 = retainedLaunchInputSha256(inspected.captured.digest, inspected.assembly.run);
  if (options.currentHeadSha !== source.plan.headSha ||
    retainedLaunchInputSha256(inspected.captured.digest, options.currentRunBindings) !== inputSha256) fail('input_mismatch');
  const fresh = decodeCapturedInputs(options.freshCaptureBytes, source.plan);
  if (fresh.bytes !== inspected.captured.bytes || fresh.digest !== inspected.captured.digest) fail('input_mismatch');
  if (!fresh.aggregation) fail('aggregation_required');
  return { options, source, inputSha256 };
}

async function executeBoundSuccessor(options: CommonRecoveryOptions, source: ReviewerLineage,
  { journal, operation, claim, ownership }: BoundExecution): Promise<void> {
  // Historical tiny operations can still finalize locally, but never gain a
  // paid window. New operations are refused before their native claim below.
  const executionExpiresAtMs = operation.expiresAtMs - operation.startedAtMs < 4
    ? operation.startedAtMs : retainedPaidCutoff(operation);
  const remaining = executionExpiresAtMs - (options.nowMs ?? Date.now)();
  const paidLease = remaining > 0 ? abortSignalWithTimeout(options.signal, remaining) : undefined;
  const paidSignal = paidLease?.signal ?? options.signal;
  const late = createCheckpointLateAudit({ commonDir: options.commonDir, journal, ownership,
    onError: options.onLateAuditError });
  try {
    // A crash between sealing and report retention must not execute the runner
    // again. An unsealed resume derives remaining spend/time from this same
    // operation and its durable intents, never from a new command-line budget.
    if (!(await journal.read()).finalized) {
      await recoverCapturedAssignments({ commonDir: options.commonDir, journal, ownership, operation,
        expectedPlan: source.plan, sourceAttempts: source.attempts, nowMs: options.nowMs, runtimeBounds: { expiresAtMs: executionExpiresAtMs },
        adapterFactory: options.adapterFactory, onPhysicalReviewComplete: options.onPhysicalReviewComplete,
        signal: paidSignal, auditLateAttempt: late.accept, onLateAuditError: options.onLateAuditError });
      await journal.finalize(ownership);
    }
    await late.flushAfterFinalization();
    const proof = await exportCheckpointProof(journal);
    const original = source.latest.inspected;
    const assembly: CheckpointAssemblyInput = {
      projection: projectCheckpointReport({ sources: source.runs.map(run => ({ runId: run.runId, proof: run.proof })),
        successor: { runId: operation.successorRunId, proof }, policy: original.captured.policy }),
      // This operation supplements the frozen blocking roster. It never drains
      // the current async queue or erases the source's already accepted snapshot.
      supplementalAsync: original.supplementalAsync,
      ...(original.asyncExecution ? { asyncExecution: original.asyncExecution } : {}),
      diff: structuredClone(original.assembly.diff), startTime: operation.startedAtMs,
      run: { ...structuredClone(original.assembly.run), id: operation.successorRunId,
        rclVersion: options.rclVersion, runner: structuredClone(options.runner),
        startedAt: new Date(operation.startedAtMs),
        converge: { target: options.target, attempt: claim.attempt, round: operation.successorNativeClaim!.round } },
    };
    const gated = await executeCheckpointGating({ assembly, commonDir: options.commonDir, ownership, journal,
      beforeLaunch: () => options.preflight(preflightRequest(options, source), encodeRecoveryOperation(operation)),
      askFactory: model => {
        const adapter = (options.adapterFactory ?? defaultAdapterFactory)(detectProvider(model));
        return (model, system, user, request) => adapter.ask(model, system, user, request);
      },
      onLateAuditError: options.onLateAuditError, signal: paidSignal, nowMs: options.nowMs, executionExpiresAtMs,
    });
    const completed = await assembleCheckpointReview(assembly, { onStage: options.onStage,
      verificationProof: gated.verificationProof });
    completed.report.run.reviewer_evidence = describeReviewerEvidence(proof, assembly.supplementalAsync);
    const representation = original.representation;
    const reportBytes = renderReportArtifacts(sanitizeForDelivery(completed.report, representation)).report_json!;
    const preliminary = serializeReviewerArtifact({ assembly, reportBytes, representation, verificationProof: gated.verificationProof });
    const current = inspectReviewerArtifact(preliminary.bytes, { expectedReportBytes: reportBytes, expectedRunId: operation.successorRunId,
      expectedTarget: options.target, expectedPlan: source.plan });
    const artifact = serializeReviewerArtifact({ assembly, reportBytes, representation,
      verificationProof: gated.verificationProof, lineage: [...source.runs.map(run => run.inspected), current] });
    await journal.retainTerminalReport({ reportBytes, reviewerArtifactBytes: artifact.bytes }, ownership);
  } finally {
    paidLease?.dispose();
    // Wait for observations already received, never for a hanging provider.
    if ((await journal.read()).finalized) await late.drain();
  }
}

async function completed(options: CommonRecoveryOptions,
  result: { claim: ConvergeAttemptClaim; operation: RecoveryOperation }, reusedTerminal: boolean): Promise<CompletedReviewerRecovery> {
  const lineage = await loadReviewerLineage({ commonDir: options.commonDir, target: options.target, runId: options.successorRunId });
  return { kind: 'completed', claim: result.claim, operation: result.operation, reusedTerminal, terminal: lineage.latest.terminal,
    health: lineage.latest.inspected.artifact.health, gate: lineage.latest.inspected.artifact.validation.gate };
}

/**
 * Compose guarded missing-assignment execution and immutable terminal retention.
 * This internal service requires caller-owned server preflight; it does not
 * implement that authority, deliver evidence, admit a native round, or triage it.
 */
export async function applyReviewerRecovery(input: ApplyReviewerRecoveryOptions): Promise<ApplyReviewerRecoveryResult> {
  const options = snapshot(input);
  const bounds = { sourceRunId: input.sourceRunId, operationId: input.operationId, startedAtMs: input.startedAtMs,
    expiresAtMs: input.expiresAtMs, maxAdditionalCalls: input.maxAdditionalCalls,
    maxAttemptsPerCell: input.maxAttemptsPerCell, maxAttempts: input.maxAttempts };
  const executionExpiresAtMs = retainedPaidCutoff(bounds);
  const prepared = await prepare(options, bounds.sourceRunId);
  const result = await guardReviewerRecoveryLaunch({ ...bounds, gitCommonDir: prepared.options.commonDir,
    target: options.target, successorRunId: options.successorRunId, headSha: options.currentHeadSha,
    inputSha256: prepared.inputSha256, nowMs: options.nowMs,
    beforeClaim: async ({ operationBytes }) => {
      if ((options.nowMs ?? Date.now)() >= executionExpiresAtMs) fail('execution_deadline');
      await options.preflight(preflightRequest(prepared.options, prepared.source), operationBytes);
      if ((options.nowMs ?? Date.now)() >= executionExpiresAtMs) fail('execution_deadline');
    },
    run: context => executeBoundSuccessor(prepared.options, prepared.source, context) });
  return result.kind === 'already_quorate' ? result : completed(prepared.options, result, false);
}

/** Resume the exact saved operation; caller-supplied replacement budgets are not part of this API. */
export async function resumeReviewerRecovery(input: ResumeReviewerRecoveryOptions): Promise<CompletedReviewerRecovery> {
  const options = snapshot(input);
  options.commonDir = await realpath(resolve(options.commonDir));
  const journal = await CheckpointJournal.inspectRead(checkpointPath(options.commonDir, options.target, options.successorRunId));
  const bindings = await journal.readBindings();
  if (!bindings.operation) fail('resume_operation_missing');
  const operation = decodeRecoveryOperation(bindings.operation);
  const prepared = await prepare(options, operation.sourceRunId);
  const result = await guardReviewerRecoveryResume({ gitCommonDir: prepared.options.commonDir,
    target: options.target, successorRunId: options.successorRunId, headSha: options.currentHeadSha,
    inputSha256: prepared.inputSha256, nowMs: options.nowMs,
    beforeResume: ({ operationBytes }) => options.preflight(preflightRequest(prepared.options, prepared.source), operationBytes),
    run: context => executeBoundSuccessor(prepared.options, prepared.source, context) });
  return completed(prepared.options, result, result.reusedTerminal);
}
