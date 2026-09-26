import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { replayGating, type AskFn, type GatingPlan } from '../consensus/gating.js';
import { withOwnedNativeOperation, type NativeTargetOwnership } from '../converge/target-ownership.js';
import { stableStringify } from '../report/run-header.js';
import type { CheckpointJournal } from './checkpoint.js';
import { parseVerificationAnswer, snapshotVerificationEvent, type VerificationPlanInput, type VerificationResult, type VerificationState } from './checkpoint-verification.js';

export interface VerificationExecutionOptions {
  commonDir: string;
  ownership: NativeTargetOwnership;
  journal: CheckpointJournal;
  /** Independently regenerated from validated captured consensus/config/diff, never an uploaded plan. */
  regeneratedPlan: GatingPlan;
  /** Existing phase on resume; first launch is bounded by the original operation expiry. */
  retainedPlan: VerificationPlanInput;
  /** Other calls charged to this run (e.g. new async launches), excluding checkpoint and verifier intents. */
  otherPhysicalCalls: number;
  askFactory: () => AskFn;
  /** Caller establishes source/principal/producer authority before any new physical intent. */
  beforeLaunch: () => Promise<void>;
  signal?: AbortSignal;
  nowMs?: () => number;
  monotonicNow?: () => number;
  /** Caller buffers until sealing and retains with its original ownership; never alters the phase proof. */
  auditLateAnswer: (result: VerificationResult) => Promise<void>;
  onLateAuditError: (error: unknown, batchIndex: number) => void;
}

export type VerificationExecutionResult = ({ ok: true } & ReturnType<typeof replayGating> | {
  ok: false; findings: GatingPlan['findings']; failure: Error;
}) & { proof: { bytes: string; digest: string }; newPhysicalCalls: number };

/**
 * Execute one already-authorized verifier phase. This is a request engine, not
 * source authentication or report admission. The caller regenerates the plan,
 * accounts for non-checkpoint calls and holds original ownership through late
 * audit flush/drain. Unknown paid intents are never retried. SDK retries are off.
 */
export function executeVerification(input: VerificationExecutionOptions): Promise<VerificationExecutionResult> {
  const options = { ...input }, plan = structuredClone(input.regeneratedPlan);
  const event = snapshotVerificationEvent({ type: 'plan', plan: input.retainedPlan });
  if (event.type !== 'plan' || stableStringify(plan) !== event.plan.gatingPlanBytes) {
    return Promise.reject(new Error('verification_execution_plan_mismatch'));
  }
  const retained = event.plan;
  if (!Number.isSafeInteger(options.otherPhysicalCalls) || options.otherPhysicalCalls < 0 || options.otherPhysicalCalls > 500 ||
    typeof options.beforeLaunch !== 'function' || typeof options.askFactory !== 'function' ||
    typeof options.auditLateAnswer !== 'function' || typeof options.onLateAuditError !== 'function') {
    return Promise.reject(new Error('verification_execution_invalid_options'));
  }
  return withOwnedNativeOperation(options.ownership, options.commonDir, options.journal.getPlan().target, async ownership => {
    const wall = options.nowMs ?? Date.now, monotonic = options.monotonicNow ?? performance.now.bind(performance);
    const wallStart = wall(), monoStart = monotonic();
    if (!Number.isSafeInteger(wallStart) || wallStart < 0 || !Number.isFinite(monoStart)) throw new Error('verification_execution_invalid_clock');
    let lastTime = Math.max(retained.startedAtMs, wallStart), lastMono = monoStart;
    const now = (): number => {
      const currentWall = wall(), currentMono = monotonic();
      if (!Number.isSafeInteger(currentWall) || currentWall < 0 || !Number.isFinite(currentMono) || currentMono < lastMono) {
        throw new Error('verification_execution_invalid_clock');
      }
      lastMono = currentMono;
      lastTime = Math.max(lastTime, currentWall, wallStart + Math.floor(currentMono - monoStart));
      if (!Number.isSafeInteger(lastTime)) throw new Error('verification_execution_invalid_clock');
      return lastTime;
    };
    // Existing phase bytes, including caps and absolute expiry, must match.
    // This also rejects new phase work after immutable terminal report bytes.
    await options.journal.beginVerification(retained, ownership);
    let state = (await options.journal.readVerification())!;
    const main = await options.journal.read();
    const reviewerCalls = main.records.filter(row => row.type === 'intent').length;
    let newPhysicalCalls = 0;
    const replay = (saved: VerificationState): ReturnType<typeof replayGating> => replayGating(plan,
      saved.outcomes.map(row => ({ batchIndex: row.batchIndex, kind: 'answer', answer: parseVerificationAnswer(row.answerBytes, retained) })),
      saved.terminal!.finishedAtMs - retained.startedAtMs);
    const result = async (saved: VerificationState, interpreted?: ReturnType<typeof replayGating>): Promise<VerificationExecutionResult> => {
      const proof = await options.journal.exportVerificationProof();
      if (interpreted?.verification) interpreted.verification.durationMs = saved.terminal!.finishedAtMs - retained.startedAtMs;
      return saved.terminal!.status === 'complete'
        ? { ok: true, ...(interpreted ?? replay(saved)), proof, newPhysicalCalls }
        : { ok: false, findings: structuredClone(plan.findings), failure: new Error(saved.terminal!.reason), proof, newPhysicalCalls };
    };
    if (state.terminal) return result(state);

    const controller = new AbortController();
    let failure: string | undefined;
    const fail = (reason: string): void => { failure ??= reason; controller.abort(); };
    const remaining = (): number => retained.expiresAtMs - now();
    const pendingAudit = new Set<Promise<void>>(), auditErrors: unknown[] = [];
    function audit(row: VerificationResult): void {
      let work: Promise<void>;
      try { work = options.auditLateAnswer(row); }
      catch (error) { work = Promise.reject(error); }
      const tracked = work.catch(error => {
        auditErrors.push(error);
        try { options.onLateAuditError(error, row.batchIndex); }
        catch (sinkError) { auditErrors.push(sinkError); }
      });
      pendingAudit.add(tracked);
      void tracked.then(() => pendingAudit.delete(tracked));
    }
    const cancel = (): void => fail('verification_execution_cancelled');
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    let passTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (state.uncertain.length) fail('verification_execution_uncertain_intent');
      if (retained.maxPhysicalCalls < plan.batches.length) fail('verification_execution_call_cap');
      if (reviewerCalls + options.otherPhysicalCalls + retained.maxPhysicalCalls > 500) fail('verification_execution_total_call_cap');
      if (remaining() <= 0) fail('verification_execution_deadline');
      if (!failure) passTimer = setTimeout(() => fail('verification_execution_deadline'), remaining());
      const todo = plan.batches.map((_, index) => index).filter(index => !state.intents.some(row => row.batchIndex === index));
      let ask: AskFn | undefined;
      if (!failure && todo.length) {
        await options.beforeLaunch();
        if (remaining() <= 0) fail('verification_execution_deadline');
        if (!failure) {
          try { ask = options.askFactory(); }
          catch { fail('verification_execution_adapter_unavailable'); }
        }
      }
      async function runBatch(batchIndex: number): Promise<void> {
        if (failure) return;
        await options.beforeLaunch();
        if (failure) return;
        if (remaining() <= 0) { fail('verification_execution_deadline'); return; }
        const intent = { batchIndex, attemptId: `verifier-${randomUUID()}`, startedAtMs: now() };
        const claimed = await options.journal.recordVerificationIntent(intent, ownership);
        if (!claimed) { fail('verification_execution_uncertain_intent'); return; }
        // Counts include a durable intent whose acknowledgment outlived expiry;
        // it cannot safely be refunded or used to launch after the deadline.
        newPhysicalCalls++;
        if (remaining() <= 0) fail('verification_execution_deadline');
        if (failure) return;
        const batch = plan.batches[batchIndex]!;
        const timeoutMs = Math.max(1, Math.floor(Math.min(retained.verificationTimeoutMs, remaining())));
        const call = new AbortController();
        const observed = await new Promise<VerificationResult | undefined>(resolve => {
          let settled = false;
          const finish = (row?: VerificationResult): void => {
            if (settled) { if (row) audit(row); return; }
            settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); resolve(row);
          };
          const onAbort = (): void => { call.abort(); finish(); };
          const timer = setTimeout(() => { fail('verification_execution_request_timeout'); }, timeoutMs);
          controller.signal.addEventListener('abort', onAbort, { once: true });
          if (controller.signal.aborted) { onAbort(); return; }
          let request: ReturnType<AskFn>;
          try { request = ask!(plan.model, batch.systemPrompt, batch.userPrompt, { timeoutMs, maxRetries: 0, signal: call.signal }); }
          catch { fail('verification_execution_request_failed'); finish(); return; }
          void request.then(answer => {
            // Snapshot the adapter's actual response, never a manufactured timeout.
            const answerBytes = JSON.stringify(answer);
            parseVerificationAnswer(answerBytes, retained);
            finish({ batchIndex, attemptId: intent.attemptId, finishedAtMs: now(), answerBytes });
          }).catch(error => {
            if (settled) {
              // No answer exists to retain on a rejected request. A late invalid
              // response or audit failure remains visible through the error sink.
              try { options.onLateAuditError(error, batchIndex); } catch (sinkError) { auditErrors.push(sinkError); }
            } else { fail('verification_execution_request_failed'); finish(); }
          });
        });
        if (observed) {
          // Keep exact schema fields; the intent timestamp is not part of a result.
          const { batchIndex, attemptId, finishedAtMs, answerBytes } = observed;
          await options.journal.recordVerificationResult({ batchIndex, attemptId, finishedAtMs, answerBytes }, ownership);
        }
        if (remaining() <= 0) fail('verification_execution_deadline');
      }
      let next = 0;
      const workers = await Promise.allSettled(Array.from({ length: Math.min(3, todo.length) }, async () => {
        try { while (!failure && next < todo.length) await runBatch(todo[next++]!); }
        catch (error) { fail('verification_execution_persistence_failed'); throw error; }
      }));
      const errors = workers.filter((row): row is PromiseRejectedResult => row.status === 'rejected').map(row => row.reason as unknown);
      if (errors.length) throw new AggregateError(errors, 'verification_execution_failed');
      state = (await options.journal.readVerification())!;
      let interpreted: ReturnType<typeof replayGating> | undefined;
      if (!failure) {
        // Complete interpretation before sealing. First completion returns this
        // exact result; a later resume replays the identical retained transcript.
        interpreted = replayGating(plan, state.outcomes.map(row => ({ batchIndex: row.batchIndex, kind: 'answer', answer: parseVerificationAnswer(row.answerBytes, retained) })), now() - retained.startedAtMs);
        if (remaining() <= 0) fail('verification_execution_deadline');
      }
      const finishedAtMs = now();
      if (finishedAtMs >= retained.expiresAtMs) fail('verification_execution_deadline');
      await options.journal.finalizeVerification(failure
        ? { status: 'failed', finishedAtMs, reason: failure }
        : { status: 'complete', finishedAtMs }, ownership);
      while (pendingAudit.size) await Promise.all([...pendingAudit]);
      if (auditErrors.length) throw new AggregateError(auditErrors, 'verification_execution_late_audit_failed');
      return result((await options.journal.readVerification())!, interpreted);
    } finally {
      if (passTimer !== undefined) clearTimeout(passTimer);
      options.signal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  });
}
