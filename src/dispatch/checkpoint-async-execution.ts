import type { AsyncDelegate } from './checkpoint-async-store.js';
import { openCapturedAsyncDelegate } from './checkpoint-async-store.js';
import type { ReviewAdapter } from './adapter.js';
import { asyncRefuse, parseAsyncReview, type AsyncCall } from './checkpoint-async.js';
import { stableStringify } from '../report/run-header.js';

export interface CheckpointAsyncExecutionOptions {
  delegate: AsyncDelegate;
  /** Construction only; the executor supplies the exact captured route and prompts. */
  adapterFactory: (call: AsyncCall) => ReviewAdapter;
  signal?: AbortSignal;
  onLateAuditError: (error: unknown) => void;
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
    const observed = raw.then(async result => {
      const bytes = stableStringify({ ...result, async: true });
      const review = parseAsyncReview(bytes, call.ref);
      await writer.recordResult(intent.attemptId, bytes, true);
      return review.status;
    });
    // A pending result retains only restricted audit authority. Late callbacks
    // cannot reopen the sealed proof or mutate a finalized blocking report.
    const safe = observed.catch(error => { if (expired) { options.onLateAuditError(error); return undefined; } throw error; });
    let status: Awaited<typeof safe>;
    try { status = await Promise.race([safe, stopped]); } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
    }
    if (status !== 'timeout' || expired) break;
  }
  return { newPhysicalCalls };
}
