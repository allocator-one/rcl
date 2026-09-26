import { readAsyncPhase } from './checkpoint-async-store.js';
import { encodeAsyncProof } from './checkpoint-async.js';
import type { AskFn } from '../consensus/gating.js';
import { withOwnedNativeOperation, type NativeTargetOwnership } from '../converge/target-ownership.js';
import type { CheckpointAssemblyInput } from '../report/checkpoint-consensus.js';
import { deriveCheckpointGating, prepareCheckpointGating, type CheckpointGatingProjection,
  type SealedVerificationProof } from '../report/checkpoint-gating.js';
import { stableStringify } from '../report/run-header.js';
import { detectProvider } from '../roles/dispatcher.js';
import type { CheckpointJournal } from './checkpoint.js';
import { verificationContextForCheckpointProof } from './checkpoint-verification-context.js';
import { executeVerification } from './verification-execution.js';
import { createVerificationLateAudit } from './verification-late-audit.js';

export interface CheckpointGatingExecutionOptions {
  assembly: CheckpointAssemblyInput;
  commonDir: string;
  ownership: NativeTargetOwnership;
  journal: CheckpointJournal;
  askFactory: (model: string) => AskFn;
  /** Caller authenticates the original launch or the complete recovery source chain. */
  beforeLaunch: () => Promise<void>;
  onLateAuditError: (error: unknown, batchIndex: number) => void;
  signal?: AbortSignal;
  /** Runtime tightening only; existing phase bytes are never replaced on resume. */
  executionExpiresAtMs?: number;
  nowMs?: () => number;
  monotonicNow?: () => number;
}

/** Execute under the caller's ownership, then reconstruct output from the sealed private phase. */
export function executeCheckpointGating(input: CheckpointGatingExecutionOptions): Promise<{
  projection: CheckpointGatingProjection;
  verificationProof?: SealedVerificationProof;
  newPhysicalCalls: number;
}> {
  const options = { ...input, assembly: { ...input.assembly,
    diff: structuredClone(input.assembly.diff), run: structuredClone(input.assembly.run) } };
  return withOwnedNativeOperation(options.ownership, options.commonDir, options.journal.getPlan().target, async ownership => {
    const { plan, originalAsync, currentReviewerCalls } = prepareCheckpointGating(options.assembly);
    const expected = options.assembly.projection.proofs.at(-1)!.proof;
    const actual = await options.journal.exportProof();
    if (actual.bytes !== expected.bytes || actual.digest !== expected.digest) {
      throw new Error('checkpoint_gating_execution_journal_mismatch');
    }
    if (options.assembly.asyncExecution && options.assembly.projection.proofs.length === 1) {
      const phase = await readAsyncPhase({ commonDir: options.commonDir, namespace: options.assembly.projection.proofs.at(-1)!.runId, plan: options.journal.getPlan() });
      const sealed = encodeAsyncProof(phase.plan, phase.state.records);
      if (sealed.bytes !== options.assembly.asyncExecution.bytes || sealed.digest !== options.assembly.asyncExecution.digest) {
        throw new Error('checkpoint_gating_execution_async_mismatch');
      }
    }
    const existing = await options.journal.readVerification();
    if (plan === undefined || plan.batches.length === 0) {
      if (existing !== undefined) throw new Error('checkpoint_gating_phase_not_applicable');
      return { projection: deriveCheckpointGating(options.assembly), newPhysicalCalls: 0 };
    }
    const context = verificationContextForCheckpointProof(actual);
    if (context.runId !== options.assembly.run.id) throw new Error('checkpoint_gating_run_mismatch');
    const now = (options.nowMs ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('checkpoint_gating_execution_invalid_clock');
    const executionExpiresAtMs = options.executionExpiresAtMs ?? context.expiresAtMs;
    if (!Number.isSafeInteger(executionExpiresAtMs) || executionExpiresAtMs < context.startedAtMs || executionExpiresAtMs > context.expiresAtMs) {
      throw new Error('checkpoint_gating_execution_invalid_deadline');
    }
    const startedAtMs = Math.min(Math.max(now, context.startedAtMs), executionExpiresAtMs);
    const request = {
      runId: context.runId, gatingPlanBytes: stableStringify(plan), model: plan.model,
      provider: detectProvider(plan.model),
      batches: plan.batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })),
      verificationTimeoutMs: plan.verificationTimeoutMs,
      verificationPassTimeoutMs: plan.verificationPassTimeoutMs,
    };
    if (existing !== undefined) {
      for (const key of Object.keys(request) as Array<keyof typeof request>) {
        if (stableStringify(existing.plan[key]) !== stableStringify(request[key])) {
          throw new Error('checkpoint_gating_plan_mismatch');
        }
      }
    }
    const retainedPlan = existing?.plan ?? { ...request, startedAtMs,
      expiresAtMs: Math.min(startedAtMs + plan.verificationPassTimeoutMs, executionExpiresAtMs),
      maxPhysicalCalls: Math.min(plan.batches.length, 500 - currentReviewerCalls - originalAsync),
    };
    const audit = createVerificationLateAudit({ commonDir: options.commonDir, journal: options.journal,
      ownership, onError: options.onLateAuditError });
    try {
      const result = await executeVerification({ ...options, ownership, regeneratedPlan: plan,
        retainedPlan, executionExpiresAtMs: Math.min(executionExpiresAtMs, retainedPlan.expiresAtMs), otherPhysicalCalls: originalAsync, askFactory: () => options.askFactory(plan.model),
        auditLateAnswer: audit.accept });
      await audit.flushAfterFinalization();
      return { projection: deriveCheckpointGating(options.assembly, result.proof),
        verificationProof: result.proof, newPhysicalCalls: result.newPhysicalCalls };
    } finally {
      // Preserve observed late answers before releasing ownership; a hanging
      // provider cannot extend the original operation's absolute lifetime.
      if ((await options.journal.readVerification())?.terminal) await audit.flushAfterFinalization();
      await audit.drain();
    }
  });
}
