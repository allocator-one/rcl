import type { AsyncDelegate } from './checkpoint-async-store.js';
import { openCapturedAsyncDelegate } from './checkpoint-async-store.js';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter } from './adapter.js';
import { asyncRefuse, parseAsyncReview, type AsyncCall } from './checkpoint-async.js';
import { stableStringify } from '../report/run-header.js';
import { failedReview } from './utils.js';

export interface CheckpointAsyncExecutionOptions {
  delegate: AsyncDelegate;
  /** Construction only; the executor supplies the exact captured route and prompts. */
  adapterFactory: (call: AsyncCall) => ReviewAdapter;
  signal?: AbortSignal;
  onLateAuditError: (error: unknown, attemptId: string) => void | Promise<void>;
  /** Derived opinion publication only, after exact result durability. Never physical accounting. */
  onReviewRecorded?: (review: ModelReview) => Promise<void>;
}

/**
 * Execute one restricted original call. Each physical invocation has a fsynced
 * intent; SDK retries are disabled. Only observed timeouts may retry. Uncertain
 * outcomes never retry, and a noncooperative adapter cannot hold the deadline open.
 * External credential/source preflight occurs before the owner delegates this phase.
 */
export async function executeCheckpointAsync(input: CheckpointAsyncExecutionOptions): Promise<{ newPhysicalCalls: number }> {
  const options = { ...input, delegate: structuredClone(input.delegate) };
  const { writer, plan, call, timeoutMs } = await openCapturedAsyncDelegate(options.delegate);
  const wallStart = Date.now(), monotonicStart = performance.now();
  const remaining = () => Math.min(plan.expiresAtMs - Date.now(), plan.expiresAtMs - wallStart - (performance.now() - monotonicStart));
  let newPhysicalCalls = 0;
  if (options.signal?.aborted || remaining() <= 0) return { newPhysicalCalls };
  const adapter = options.adapterFactory(call.ref);
  asyncRefuse(adapter.provider === call.ref.provider, 'adapter_route');
  while (!options.signal?.aborted && remaining() > 0) {
    const startedAt = Date.now();
    const controller = new AbortController();
    let raw: ReturnType<ReviewAdapter['review']> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let stop!: () => void;
    const stopped = new Promise<undefined>(resolve => { stop = () => { expired = true; controller.abort(); resolve(undefined); }; });
    let intent;
    try {
      intent = await writer.claim(call.prompt, () => {
        // This is synchronous under the phase's cutoff lock, AFTER fsync. No
        // seal, cancellation, or deadline renewal can slip between check/start.
        if (options.signal?.aborted || remaining() <= 0) return;
        const duration = Math.min(timeoutMs, Math.max(1, Math.floor(remaining())));
        options.signal?.addEventListener('abort', stop, { once: true });
        timer = setTimeout(stop, duration);
        newPhysicalCalls++;
        try { raw = adapter.review(call.ref.model, call.ref.role, call.prompt.systemPrompt, call.prompt.userPrompt,
          { timeoutMs: duration, maxRetries: 0, signal: controller.signal }); } catch (error) { raw = Promise.reject(error); }
        // Attach immediately: a synchronously rejected adapter must not become
        // unhandled while the durable claim releases its lock.
        void raw.catch(() => {});
      });
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      throw error;
    }
    if (!intent || !raw) break;
    const reportDerivedError = (error: unknown): void => {
      try { void Promise.resolve(options.onLateAuditError(error, intent.attemptId)).catch(() => {}); }
      catch { /* contained */ }
    };
    const observedFailure = (error: unknown): ModelReview => failedReview({
      model: call.ref.model, role: call.ref.role, provider: call.ref.provider, startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    const persist = async (result: Awaited<ReturnType<ReviewAdapter['review']>>) => {
      let review: ModelReview;
      try {
        const candidate = stableStringify({ ...result, async: true });
        review = parseAsyncReview(candidate, call.ref) as ModelReview;
      } catch (error) { review = observedFailure(error); }
      const bytes = stableStringify({ ...review, async: true });
      review = parseAsyncReview(bytes, call.ref) as ModelReview;
      await writer.recordResult(intent.attemptId, bytes, true);
      // Derived publication cannot change exact physical accounting or stop a
      // durable timeout retry. Its private error sink is detached and contained.
      try { void options.onReviewRecorded?.(structuredClone(review) as ModelReview).catch(reportDerivedError); }
      catch (error) { reportDerivedError(error); }
      return review.status;
    };
    const response = raw.then(
      result => ({ kind: 'result' as const, result }),
      error => ({ kind: 'error' as const, error }),
    );
    let outcome: Awaited<typeof response> | undefined;
    try { outcome = await Promise.race([response, stopped]); } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
    }
    if (outcome === undefined) {
      // A pending provider response retains only restricted audit authority.
      // Its eventual result cannot reopen the sealed proof or blocking report.
      void response.then(async late => {
        if (late.kind === 'error') throw late.error;
        await persist(late.result);
      }).catch(async error => { await options.onLateAuditError(error, intent.attemptId); })
        // The sink is already the final bounded durability attempt. Contain its
        // own failure so a detached worker cannot create an unhandled rejection.
        .catch(() => {});
      break;
    }
    if (outcome.kind === 'error') {
      await persist(observedFailure(outcome.error));
      break;
    }
    // The immutable deadline bounds provider response time. Once a response is
    // observed, validation and durable result publication must finish rather
    // than being abandoned by the same timer.
    const status = await persist(outcome.result);
    if (status !== 'timeout' || expired) break;
  }
  return { newPhysicalCalls };
}
