import { validateCheckpointAsync } from '../dispatch/checkpoint-async-context.js';
import type { AsyncProof } from '../dispatch/checkpoint-async.js';
import { createHash } from 'node:crypto';
import { planGating, replayGating, type GatingPlan, type VerificationStats } from '../consensus/gating.js';
import type { ConsensusFinding } from '../consensus/types.js';
import { decodeCapturedInputs } from '../dispatch/captured-inputs.js';
import { decodeVerificationProof, parseVerificationAnswer, type VerificationState } from '../dispatch/checkpoint-verification.js';
import { verificationContextForCheckpointProof } from '../dispatch/checkpoint-verification-context.js';
import { detectProvider } from '../roles/dispatcher.js';
import { deriveCheckpointConsensus, type CheckpointAssemblyInput, type CheckpointConsensusResult } from './checkpoint-consensus.js';
import { stableStringify } from './run-header.js';

export interface SealedVerificationProof { bytes: string; digest: string }
export interface CheckpointGatingProjection {
  derived: CheckpointConsensusResult;
  plan?: GatingPlan;
  findings: ConsensusFinding[];
  appendix: ConsensusFinding[];
  verification?: VerificationStats;
  phase?: { proof: SealedVerificationProof; state: VerificationState };
  asyncExecution?: AsyncProof;
  disposition: 'plain' | 'deterministic' | 'replayed' | 'strict_fallback';
}
const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
const equal = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
const gatedAppendix = (findings: ConsensusFinding[]): ConsensusFinding[] =>
  findings.map(finding => ({ ...structuredClone(finding), gating: { reason: 'none' as const } }));

/**
 * Pure retained-checkpoint verifier projection. It validates local structural
 * evidence only; callers retain source, native, server, producer and provider
 * authority. It performs no IO or live ask.
 */
export function prepareCheckpointGating(assembly: CheckpointAssemblyInput): {
  derived: CheckpointConsensusResult; plan?: GatingPlan; originalAsync: number; currentReviewerCalls: number; asyncExecution?: AsyncProof;
} {
  const derived = deriveCheckpointConsensus(assembly);
  const successor = assembly.projection.proofs.at(-1)!;
  const capture = successor.proof.bindings['captured-inputs'];
  if (capture === undefined) throw new Error('checkpoint_gating_missing_capture');
  const captured = decodeCapturedInputs(capture, successor.proof.plan);
  const aggregation = captured.aggregation;
  if (!aggregation) throw new Error('checkpoint_gating_missing_aggregation');
  const currentReviewerCalls = successor.proof.state.records.filter(row => row.type === 'intent').length;
  const root = assembly.projection.proofs[0]!;
  const asyncExecution = validateCheckpointAsync(root.proof, assembly.asyncExecution);
  if (asyncExecution && asyncExecution.context.runId !== root.runId) throw new Error('checkpoint_gating_async_run_mismatch');
  const allIds = new Set(assembly.projection.allPhysicalAttempts.map(row => row.attemptId));
  if (asyncExecution?.state.intents.some(row => allIds.has(row.attemptId))) throw new Error('checkpoint_gating_duplicate_attempt');
  if (assembly.supplementalAsync.asyncLaunched > 0 && asyncExecution === undefined) {
    throw new Error('checkpoint_gating_unbound_async_launches');
  }
  if (captured.async && assembly.supplementalAsync.asyncLaunched > captured.async.calls.length) {
    throw new Error('checkpoint_gating_async_launch_count');
  }
  // Prior-round voting arrivals do not imply current paid calls. A genuine
  // legacy no-launch capture stays optional; never fabricate an empty proof.
  const originalAsync = assembly.projection.proofs.length === 1 ? asyncExecution?.state.intents.length ?? 0 : 0;
  if (currentReviewerCalls + originalAsync > 500) throw new Error('checkpoint_gating_call_cap');
  if (aggregation.gating.mode !== 'verified-consensus' || !assembly.projection.health.conclusive) {
    return { derived, asyncExecution, originalAsync, currentReviewerCalls };
  }
  const plan = planGating(derived.consensus.reportFindings, {
    minModels: aggregation.gating.minModels,
    verificationModel: aggregation.gating.verificationModel,
    verificationTimeoutMs: aggregation.gating.verificationTimeoutMs,
    verificationPassTimeoutMs: aggregation.gating.verificationPassTimeoutMs,
    diffFiles: assembly.diff.files,
    ...(aggregation.modelWeights === undefined ? {} : { modelWeights: new Map(aggregation.modelWeights.map(row => [row.model, row.weight])) }),
  });
  return { derived, asyncExecution, plan, originalAsync, currentReviewerCalls };
}

/** Replay a complete or failed sealed phase, never a live provider request. */
export function deriveCheckpointGating(assembly: CheckpointAssemblyInput, sealed?: SealedVerificationProof): CheckpointGatingProjection {
  const { derived, plan, originalAsync, currentReviewerCalls, asyncExecution } = prepareCheckpointGating(assembly);
  if (plan === undefined) {
    if (sealed !== undefined) throw new Error('checkpoint_gating_phase_not_applicable');
    return { derived, asyncExecution, findings: structuredClone(derived.consensus.reportFindings),
      appendix: structuredClone(derived.consensus.droppedFindings), disposition: 'plain' };
  }
  if (plan.batches.length === 0) {
    if (sealed !== undefined) throw new Error('checkpoint_gating_phase_not_applicable');
    const replay = replayGating(plan, [], 0);
    return { derived, asyncExecution, plan, findings: replay.findings, appendix: gatedAppendix(derived.consensus.droppedFindings), ...(replay.verification ? { verification: replay.verification } : {}), disposition: 'deterministic' };
  }
  if (sealed === undefined) throw new Error('checkpoint_gating_missing_phase');
  if (typeof sealed.bytes !== 'string' || !/^[a-f0-9]{64}$/.test(sealed.digest) || sha256(sealed.bytes) !== sealed.digest) throw new Error('checkpoint_gating_invalid_phase');
  const context = verificationContextForCheckpointProof(assembly.projection.proofs.at(-1)!.proof);
  if (context.runId !== assembly.run.id) throw new Error('checkpoint_gating_run_mismatch');
  const state = decodeVerificationProof(sealed.bytes, context);
  const expected = { runId: context.runId, gatingPlanBytes: stableStringify(plan), model: plan.model, provider: detectProvider(plan.model), batches: plan.batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })), verificationTimeoutMs: plan.verificationTimeoutMs, verificationPassTimeoutMs: plan.verificationPassTimeoutMs };
  const actual = state.plan;
  if (!equal({ runId: actual.runId, gatingPlanBytes: actual.gatingPlanBytes, model: actual.model, provider: actual.provider, batches: actual.batches, verificationTimeoutMs: actual.verificationTimeoutMs, verificationPassTimeoutMs: actual.verificationPassTimeoutMs }, expected)) throw new Error('checkpoint_gating_plan_mismatch');
  const ids = new Set([...(asyncExecution?.state.intents.map(row => row.attemptId) ?? []), ...assembly.projection.allPhysicalAttempts.map(row => row.attemptId)]);
  if (state.intents.some(row => ids.has(row.attemptId))) throw new Error('checkpoint_gating_duplicate_attempt');
  if (currentReviewerCalls + state.plan.maxPhysicalCalls + originalAsync > 500) throw new Error('checkpoint_gating_call_cap');
  const phase = { proof: Object.freeze({ bytes: sealed.bytes, digest: sealed.digest }), state };
  if (state.terminal!.status === 'failed') return { derived, asyncExecution, plan, findings: structuredClone(derived.consensus.reportFindings), appendix: structuredClone(derived.consensus.droppedFindings), phase, disposition: 'strict_fallback' };
  const replay = replayGating(plan, state.outcomes.map(row => ({ batchIndex: row.batchIndex, kind: 'answer' as const, answer: parseVerificationAnswer(row.answerBytes, state.plan) })), state.terminal!.finishedAtMs - state.plan.startedAtMs);
  return { derived, asyncExecution, plan, findings: replay.findings, appendix: gatedAppendix(derived.consensus.droppedFindings), ...(replay.verification ? { verification: replay.verification } : {}), phase, disposition: 'replayed' };
}
