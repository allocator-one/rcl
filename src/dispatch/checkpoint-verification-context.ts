import { createHash } from 'node:crypto';
import { isCheckpointProof } from './checkpoint.js';
import type { CheckpointProof, FrozenCheckpointPlan } from './checkpoint.js';
import { decodeOriginalLaunch } from './original-launch.js';
import { decodeRecoveryOperation } from './recovery-operation.js';
import type { VerificationContext } from './checkpoint-verification.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Derive the existing verifier-record context from caller-validated checkpoint
 * state. This is an internal structural helper: callers must already have
 * validated `plan`, `state`, and `bindings` as one coherent checkpoint. It
 * performs no IO and establishes no source, producer, native, server, or
 * provider authority.
 */
export function verificationContextFromValidatedCheckpoint(
  plan: Pick<FrozenCheckpointPlan, 'digest' | 'target'>,
  main: Pick<CheckpointProof, 'state' | 'bindings'>,
): VerificationContext {
  if (!main.state.finalized) throw new Error('checkpoint_verification_requires_finalization');
  const capture = main.bindings['captured-inputs'];
  const hasLaunch = main.bindings.launch !== undefined;
  const hasOperation = main.bindings.operation !== undefined;
  if (capture === undefined || hasLaunch === hasOperation) throw new Error('checkpoint_verification_missing_binding');
  const operationBytes = (main.bindings.launch ?? main.bindings.operation)!;
  const parent = hasLaunch ? decodeOriginalLaunch(operationBytes) : decodeRecoveryOperation(operationBytes);
  if (parent.planDigest !== plan.digest || parent.target !== plan.target ||
      parent.capturedInputsSha256 !== sha256(capture) ||
      ('successorRunId' in parent && !parent.successorNativeClaim)) {
    throw new Error('checkpoint_verification_binding_mismatch');
  }
  return Object.freeze({
    planDigest: plan.digest,
    finalizationDigest: main.state.records.at(-1)!.digest,
    capturedInputsSha256: sha256(capture),
    operationSha256: sha256(operationBytes),
    runId: 'runId' in parent ? parent.runId : parent.successorRunId,
    startedAtMs: parent.startedAtMs,
    expiresAtMs: parent.expiresAtMs,
    reviewerAttemptIds: Object.freeze(main.state.records.filter(row => row.type === 'intent').map(row => row.paidAttempt!.id)),
  });
}

/**
 * Derive verifier-record context from a branded, sealed checkpoint proof.
 * The proof brand is required before delegating to the validated-state helper.
 */
export function verificationContextForCheckpointProof(proof: CheckpointProof): VerificationContext {
  if (!isCheckpointProof(proof)) throw new Error('checkpoint_verification_unvalidated_proof');
  return verificationContextFromValidatedCheckpoint(proof.plan, { state: proof.state, bindings: proof.bindings });
}
