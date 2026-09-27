import type { ModelReview } from '../consensus/types.js';
import { assertNativeTargetOwnership, type NativeTargetOwnership } from '../converge/target-ownership.js';
import { blockingCheckpointReviewSchema, type CheckpointJournal, type PaidAttempt } from './checkpoint.js';

export interface CheckpointLateAudit {
  /** Snapshot an observed response; buffering does not mean it is durable yet. */
  accept(review: ModelReview, callIndex: number, paidAttempt: PaidAttempt): Promise<void>;
  /** Activate only after sealing, then persist every response already observed. */
  flushAfterFinalization(): Promise<void>;
  /** Wait only for observed writes, never for a provider that has not returned. */
  drain(): Promise<void>;
}

/**
 * Caller-owned audit lifetime over the existing journal and original ownership.
 * Nothing here acquires ownership, finalizes a journal or changes its proof.
 * The caller must flush/drain before releasing authority. A later callback is
 * still reported to the required error sink when that original token refuses it.
 */
export function createCheckpointLateAudit(options: {
  commonDir: string;
  journal: CheckpointJournal;
  ownership: NativeTargetOwnership;
  onError: (error: unknown, callIndex: number) => void;
}): CheckpointLateAudit {
  const { commonDir, journal, ownership, onError } = options;
  if (typeof onError !== 'function') throw new Error('Late review audit requires an error sink');
  const plan = journal.getPlan();
  type Observation = { cell: string; index: number; attempt: PaidAttempt; bytes: string };
  const buffered: Observation[] = [];
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let active = false;

  function retain(error: unknown, index: number): void {
    errors.push(error);
    try { onError(error, index); }
    catch (sinkError) { errors.push(sinkError); }
  }
  function track(operation: Promise<void>, index: number): Promise<void> {
    // Attach the rejection handler immediately, even if accept's caller ignores
    // its promise. The original rejection is also available to an awaiting caller.
    const completion = operation.then(() => {}, error => { retain(error, index); });
    pending.add(completion);
    void completion.then(() => { pending.delete(completion); });
    return operation;
  }
  function write(observation: Observation): Promise<void> {
    // recordLateResult synchronously registers with the original owned queue.
    // Do not defer registration to a new promise chain that could outlive it.
    return track(journal.recordLateResult(observation.cell, observation.attempt, observation.bytes, ownership), observation.index);
  }
  async function drain(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError([...errors], 'late_audit_failed');
    if (buffered.length > 0) throw new Error('late_audit_requires_finalization');
  }
  return Object.freeze({
    accept(review: ModelReview, callIndex: number, paidAttempt: PaidAttempt): Promise<void> {
      try {
        if (!Number.isSafeInteger(callIndex) || callIndex < 0 || callIndex >= plan.cells.length) {
          throw new Error('late_audit_invalid_call_index');
        }
        const raw = structuredClone(review), attempt = structuredClone(paidAttempt), cell = plan.cells[callIndex]!;
        blockingCheckpointReviewSchema.parse(raw);
        if (raw.model !== cell.model || raw.role !== cell.role || raw.provider !== cell.route) {
          throw new Error('late_audit_review_identity_mismatch');
        }
        const bytes = JSON.stringify(raw);
        if (Buffer.byteLength(bytes, 'utf8') > 8 * 1024 * 1024) throw new Error('checkpoint_file_too_large');
        const observation = { cell: cell.id, index: callIndex, attempt, bytes };
        if (active) return write(observation);
        return track(assertNativeTargetOwnership(ownership, commonDir, plan.target).then(() => {
          // Activation may have completed while ownership was being checked.
          if (active) return journal.recordLateResult(observation.cell, attempt, bytes, ownership);
          buffered.push(observation);
        }), callIndex);
      } catch (error) { return track(Promise.reject(error), callIndex); }
    },
    async flushAfterFinalization(): Promise<void> {
      // Check even an empty queue: activation is not permission to write before
      // the caller's main history has been sealed. Failed early flush can retry.
      await assertNativeTargetOwnership(ownership, commonDir, plan.target);
      if (!(await journal.read()).finalized) throw new Error('late_audit_requires_finalization');
      active = true;
      for (const observation of buffered.splice(0)) void write(observation);
      await drain();
    },
    drain,
  });
}
