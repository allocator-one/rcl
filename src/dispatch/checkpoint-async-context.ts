import { decodeCapturedInputs, type CapturedReviewerInputs } from './captured-inputs.js';
import { asyncRefuse, decodeAsyncProof, type AsyncContext, type AsyncPlan, type AsyncProof } from './checkpoint-async.js';
import { isCheckpointProof, type CheckpointProof, type FrozenCheckpointPlan } from './checkpoint.js';
import { decodeOriginalLaunch } from './original-launch.js';
import { sha256Hex, stableStringify } from '../report/run-header.js';
import { decodeAsyncOutcomeUnknown, isAsyncOutcomeUnknown, type AsyncOutcomeUnknown } from './checkpoint-async-unknown.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';

export interface SealedAsyncProof { bytes: string; digest: string }
export type CheckpointAsyncExecution = AsyncProof | AsyncOutcomeUnknown;

/** Structural original/capture binding; ownership and complete ancestry remain caller obligations. */
export function asyncContextForBindings(plan: FrozenCheckpointPlan | CheckpointProof['plan'], bindings: Readonly<Record<string, string>>) {
  asyncRefuse(bindings.launch && bindings['captured-inputs'] && !bindings.source && !bindings.operation, 'original_required');
  const captured = decodeCapturedInputs(bindings['captured-inputs'], plan), launch = decodeOriginalLaunch(bindings.launch);
  asyncRefuse(launch.target === plan.target && launch.planDigest === plan.digest && launch.capturedInputsSha256 === captured.digest, 'parent_binding');
  const context: AsyncContext = { runId: launch.runId, target: launch.target, planDigest: plan.digest,
    capturedInputsSha256: captured.digest, launchSha256: sha256Hex(bindings.launch), startedAtMs: launch.startedAtMs,
    expiresAtMs: launch.expiresAtMs, reviewerReservedCalls: launch.maxPhysicalCalls };
  return { captured, context };
}

/** A supplied async matrix cannot replace the exact pre-dispatch capture. */
export function assertCapturedAsyncPlan(plan: AsyncPlan, captured: CapturedReviewerInputs): void {
  const async = captured.async;
  asyncRefuse(async && stableStringify(plan.calls) === stableStringify(async.calls.map(call => call.ref)) &&
    plan.maxPhysicalCalls === async.maxPhysicalCalls && plan.maxAttemptsPerCall === async.maxAttemptsPerCall, 'capture_mismatch');
}

/** Re-decode an original-owned sealed proof. Successors inherit these bytes, never this spending. */
export function validateCheckpointAsync(root: CheckpointProof, sealed?: SealedAsyncProof): CheckpointAsyncExecution | undefined {
  asyncRefuse(isCheckpointProof(root), 'unvalidated_checkpoint');
  const bytes = root.bindings['captured-inputs']; asyncRefuse(bytes, 'missing_capture');
  const captured = decodeCapturedInputs(bytes, root.plan);
  if (sealed === undefined) { asyncRefuse(captured.async === undefined, 'missing_proof'); return undefined; }
  asyncRefuse(captured.async && sha256Hex(sealed.bytes) === sealed.digest, 'proof_mismatch');
  const { context } = asyncContextForBindings(root.plan, root.bindings);
  asyncRefuse(Buffer.byteLength(sealed.bytes, 'utf8') <= MAX_ARTIFACT_BYTES &&
    Buffer.from(sealed.bytes, 'utf8').toString('utf8') === sealed.bytes, 'invalid_proof');
  let raw: unknown;
  try { raw = JSON.parse(sealed.bytes); } catch { throw new Error('checkpoint_async_invalid_proof'); }
  if (isAsyncOutcomeUnknown(raw)) return decodeAsyncOutcomeUnknown(sealed.bytes, root, context, captured);
  const proof = decodeAsyncProof(sealed.bytes, context);
  assertCapturedAsyncPlan(proof.plan, captured);
  return proof;
}
