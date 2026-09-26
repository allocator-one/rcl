import { assertNativeTargetOwnership, type NativeTargetOwnership } from '../converge/target-ownership.js';
import type { CheckpointJournal } from './checkpoint.js';
import { parseVerificationAnswer, snapshotVerificationEvent, type VerificationResult } from './checkpoint-verification.js';

export interface VerificationLateAudit {
  accept(result: VerificationResult): Promise<void>;
  flushAfterFinalization(): Promise<void>;
  drain(): Promise<void>;
}

/** Caller-owned verifier audit lifetime; it never changes the sealed phase or proof. */
export function createVerificationLateAudit(options: {
  commonDir: string;
  journal: CheckpointJournal;
  ownership: NativeTargetOwnership;
  onError: (error: unknown, batchIndex: number) => void;
}): VerificationLateAudit {
  const { commonDir, journal, ownership, onError } = options;
  if (typeof onError !== 'function') throw new Error('Late verification audit requires an error sink');
  const buffered: VerificationResult[] = [], pending = new Set<Promise<void>>(), errors: unknown[] = [];
  let active = false;
  const retain = (error: unknown, index: number): void => { errors.push(error); try { onError(error, index); } catch (sink) { errors.push(sink); } };
  const track = (operation: Promise<void>, index: number): Promise<void> => {
    const completion = operation.then(() => {}, error => { retain(error, index); });
    pending.add(completion); void completion.then(() => pending.delete(completion)); return operation;
  };
  const write = (result: VerificationResult): Promise<void> => track(journal.recordLateVerificationResult(result, ownership), result.batchIndex);
  const validate = async (input: VerificationResult): Promise<VerificationResult> => {
    const event = snapshotVerificationEvent({ type: 'result', result: input });
    if (event.type !== 'result') throw new Error('late_verification_audit_invalid_result');
    const result = event.result, phase = await journal.readVerification();
    if (!phase) throw new Error('late_verification_audit_missing_phase');
    parseVerificationAnswer(result.answerBytes, phase.plan);
    const intent = phase.intents.find(item => item.batchIndex === result.batchIndex && item.attemptId === result.attemptId);
    if (!intent || result.finishedAtMs < intent.startedAtMs) throw new Error('late_verification_audit_invalid_result');
    return result;
  };
  async function drain(): Promise<void> {
    while (pending.size) await Promise.all([...pending]);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError([...errors], 'late_verification_audit_failed');
    if (buffered.length) throw new Error('late_verification_audit_requires_terminal');
  }
  return Object.freeze({
    accept(input: VerificationResult): Promise<void> {
      const index = input?.batchIndex;
      try {
        if (!Number.isSafeInteger(index) || index < 0) throw new Error('late_verification_audit_invalid_batch');
        return track((async () => {
          const result = await validate(input);
          if (active) return journal.recordLateVerificationResult(result, ownership);
          await assertNativeTargetOwnership(ownership, commonDir, journal.getPlan().target);
          if (active) return journal.recordLateVerificationResult(result, ownership);
          buffered.push(result);
        })(), index);
      } catch (error) { return track(Promise.reject(error), typeof index === 'number' ? index : -1); }
    },
    async flushAfterFinalization(): Promise<void> {
      await assertNativeTargetOwnership(ownership, commonDir, journal.getPlan().target);
      const phase = await journal.readVerification();
      if (!phase?.terminal) throw new Error('late_verification_audit_requires_terminal');
      active = true;
      for (const result of buffered.splice(0)) void write(result);
      await drain();
    },
    drain,
  });
}
