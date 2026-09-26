import { createHash } from 'node:crypto';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAssignment } from '../roles/types.js';
import type { BuiltPrompt } from '../prepare/prompt-builder.js';
import type { AdapterOptions, ReviewAdapter } from './adapter.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GoogleAdapter } from './google.js';
import { OpenAICompatAdapter } from './openai-compat.js';
import { DEFAULT_REASONING_EFFORT } from '../config/defaults.js';
import type { ReasoningEffort } from '../config/schema.js';
import { hasSuccessfulQuorum, resolveQuorumPolicy } from './quorum.js';

/** A successful cell read from a durably validated, exact-input checkpoint. */
export interface RetainedReview {
  callIndex: number;
  callIdentity: string;
  review: ModelReview;
}

/**
 * Local matrix binding, supplementary to the checkpoint's complete plan
 * validation. Original index and exact prompts prevent cross-chunk reuse.
 */
export function reviewCallIdentity(
  assignment: ReviewAssignment, prompt: BuiltPrompt, originalIndex: number, seatId?: string
): string {
  if (!Number.isSafeInteger(originalIndex) || originalIndex < 0) throw new Error('Invalid original call index');
  const seat = seatId ?? JSON.stringify([assignment.provider, assignment.model, assignment.role.name]);
  return createHash('sha256').update(JSON.stringify([
    1, originalIndex, seat, assignment.provider, assignment.model, assignment.role.name,
    prompt.systemPrompt, prompt.userPrompt,
  ])).digest('hex');
}

export interface RunnerOptions {
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  verbose?: boolean;
  /** Progress notification receives an isolated copy after durable acceptance. */
  onReviewComplete?: (review: ModelReview) => void;
  /** Full-matrix original seat instances; omission groups provider/model/role. */
  seatIds?: readonly string[];
  /** Caller must first validate the checkpoint's entire frozen plan and bytes. */
  retainedReviews?: readonly RetainedReview[];
  /** Unique original indices in dispatch priority order; defaults to all missing cells. */
  eligibleCallIndices?: readonly number[];
  /** Persist intent/check budget; false skips this cell, while rejection stops the run. */
  beforeReview?: (callIndex: number, signal: AbortSignal) => Promise<void | false>;
  /** Operation deadline/cancellation, independent of quorum and adapter cooperation. */
  signal?: AbortSignal;
  /**
   * Audit-only raw results arriving after closure. Receives an isolated copy;
   * never changes returned results or health. The caller owns persistence and
   * draining started audit writes; this runner cannot await a late provider.
   * An error sink is required when this hook is supplied.
   */
  auditLateReview?: (review: ModelReview, callIndex: number) => void | Promise<void>;
  /** Must report audit persistence failure without throwing or changing the report. */
  onLateAuditError?: (error: unknown, callIndex: number) => void;
  /**
   * Durable acceptance boundary, serialized in arrival order. The index names
   * the cell in the complete supplied assignment/prompt matrix. Called for
   * every dispatched terminal result, including in-flight cancellations, before
   * progress or success counting. Retained/unstarted/ineligible placeholders
   * bypass this hook: they do not represent newly paid calls. Receives an isolated copy;
   * rejection stops dispatch, aborts remaining calls and rejects the run.
   * The caller owns bounded storage I/O and frozen checkpoint identity.
   */
  acceptReview?: (review: ModelReview, callIndex: number) => Promise<void>;
  /** Reasoning budget for providers that support it; defaults to 'medium'. */
  reasoningEffort?: ReasoningEffort;
  /** Test seam / config-key wiring; defaults to the builtin providers. */
  adapterFactory?: (provider: string) => ReviewAdapter;
  /**
   * Successful complete-seat quorum over the full supplied blocking matrix.
   * Seats are provider/model/role tuples; all their expected chunks must
   * succeed. At quorum cancel every outstanding call, including core models,
   * without waiting for noncooperative adapters. Omission keeps wait-for-all.
   * coreModels is accepted for source compatibility but grants no exemption.
   */
  quorum?: { fraction?: number; coreModels?: readonly string[] };
}

type AdapterCall = {
  model: string;
  role: string;
  provider: string;
  systemPrompt: string;
  userPrompt: string;
};

export function defaultAdapterFactory(
  provider: string,
  reasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT
): ReviewAdapter {
  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter();
    case 'openai':
      return new OpenAIAdapter();
    case 'google':
      return new GoogleAdapter();
    case 'openrouter': {
      const apiKey = process.env['OPENROUTER_API_KEY']?.trim();
      // Fail loudly instead of letting the OpenAI SDK silently fall back to
      // OPENAI_API_KEY, which would send the wrong key to openrouter.ai.
      if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is not set (required for openrouter/ models)');
      }
      return new OpenAICompatAdapter({
        apiKey,
        baseUrl: 'https://openrouter.ai/api/v1',
        provider: 'openrouter',
        // Without a bound, reasoning models think for 5-10 minutes and/or
        // exhaust max_tokens before emitting findings (dogfood: 4 of 7
        // OpenRouter seats completed zero reviews across three rounds).
        reasoningEffort,
      });
    }
    default:
      return new OpenAICompatAdapter();
  }
}

export async function runReviews(
  assignments: ReviewAssignment[],
  prompts: BuiltPrompt[],
  options: RunnerOptions
): Promise<ModelReview[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Runner concurrency must be a positive safe integer');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
    throw new Error('Runner timeout must be positive and within the supported timer range');
  }
  if (assignments.length !== prompts.length) {
    throw new Error('assignments and prompts arrays must have same length');
  }

  const calls: AdapterCall[] = assignments.map((a, i) => ({
    model: a.model,
    role: a.role.name,
    provider: a.provider,
    systemPrompt: prompts[i]!.systemPrompt,
    userPrompt: prompts[i]!.userPrompt,
  }));

  const adapterOpts: AdapterOptions = {
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
  };
  const factory =
    options.adapterFactory ??
    ((provider: string) => defaultAdapterFactory(provider, options.reasoningEffort));
  // One adapter (and HTTP client) per provider per run; a throwing
  // constructor is handled per call below so one bad provider doesn't
  // take down the pool.
  const adapters = new Map<string, ReviewAdapter>();

  const results: ModelReview[] = new Array(calls.length);
  let nextIndex = 0;
  if (options.seatIds !== undefined &&
    (!Array.isArray(options.seatIds) || options.seatIds.length !== calls.length ||
      calls.some((_call, index) => typeof options.seatIds![index] !== 'string' || options.seatIds![index]!.trim().length === 0))) {
    throw new Error('Invalid seat ID matrix');
  }
  const seatKeys = calls.map((call, index) => options.seatIds?.[index] ?? JSON.stringify([call.provider, call.model, call.role]));
  const expected = new Map<string, number>();
  const seatIdentities = new Map<string, string>();
  for (const [index, key] of seatKeys.entries()) {
    if (typeof key !== 'string' || key.trim().length === 0) throw new Error('Invalid empty seat ID');
    const call = calls[index]!;
    const identity = JSON.stringify([call.provider, call.model, call.role]);
    if (seatIdentities.has(key) && seatIdentities.get(key) !== identity) throw new Error('Inconsistent original seat identity');
    seatIdentities.set(key, identity);
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const policy = options.quorum ? resolveQuorumPolicy(expected.size, options.quorum.fraction) : undefined;
  const successfulChunks = new Map<string, number>();
  let successfulSeats = 0;
  function countSuccess(index: number): void {
    const key = seatKeys[index]!;
    const count = (successfulChunks.get(key) ?? 0) + 1;
    successfulChunks.set(key, count);
    if (count === expected.get(key)) successfulSeats++;
  }
  function matches(index: number, review: ModelReview): boolean {
    const call = calls[index]!;
    return review?.model === call.model && review.role === call.role && review.provider === call.provider;
  }
  function validIndex(index: number): boolean {
    return Number.isSafeInteger(index) && index >= 0 && index < calls.length;
  }
  const retained = new Set<number>();
  for (const entry of options.retainedReviews ?? []) {
    const index = entry.callIndex;
    if (!validIndex(index) || retained.has(index) || !matches(index, entry.review) ||
      entry.review.status !== 'success' || entry.review.async === true ||
      entry.callIdentity !== reviewCallIdentity(assignments[index]!, prompts[index]!, index, options.seatIds?.[index])) {
      throw new Error('Invalid retained review identity, chunk, status or duplicate index');
    }
    retained.add(index);
    results[index] = entry.review;
    countSuccess(index);
  }
  // Set iteration retains planner priority without renumbering original cells.
  const eligible = new Set<number>();
  for (const index of options.eligibleCallIndices ?? calls.map((_call, index) => index).filter(index => !retained.has(index))) {
    if (!validIndex(index) || retained.has(index) || eligible.has(index)) throw new Error('Invalid eligible call index');
    eligible.add(index);
  }
  if (options.auditLateReview && !options.onLateAuditError) throw new Error('Late review audit requires an error sink');

  let closed: 'quorum' | 'signal' | undefined = policy && hasSuccessfulQuorum(policy, successfulSeats) ? 'quorum' : undefined;
  let failure: { error: unknown } | undefined;
  let acceptance = Promise.resolve();
  const dispatched = new Set<number>();
  const intended = new Set<number>();
  const cancelOutstanding = new Set<() => void>();
  function cancelCalls(): void { for (const cancel of cancelOutstanding) cancel(); }
  function fail(error: unknown): void { failure ??= { error }; cancelCalls(); }
  function abort(): void { closed ??= 'signal'; cancelCalls(); }
  function stopped(): boolean { return closed !== undefined || failure !== undefined; }
  function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
  }
  function canceledReview(call: AdapterCall, elapsedMs: number, detail: string): ModelReview {
    const closure = closed === 'signal' ? 'by operation signal'
      : closed === 'quorum' ? 'at quorum round closure' : undefined;
    return { model: call.model, role: call.role, provider: call.provider, findings: [],
      durationMs: elapsedMs, status: 'canceled',
      error: ['Canceled', closure, detail].filter(Boolean).join(' ') };
  }
  function failedReview(index: number, error: unknown, startedAt: number): ModelReview {
    const call = calls[index]!;
    return { model: call.model, role: call.role, provider: call.provider, findings: [],
      durationMs: Date.now() - startedAt, status: 'error',
      error: error instanceof Error ? error.message : String(error) };
  }
  const auditedRawIndices = new Set<number>();
  function audit(index: number, review: ModelReview): void {
    if (!options.auditLateReview || auditedRawIndices.has(index)) return;
    auditedRawIndices.add(index);
    // The audit sink cannot mutate a shared result object in the report. Its
    // completion/errors have no path back into success counting or dispatch.
    void Promise.resolve().then(() => options.auditLateReview!(structuredClone(review), index))
      .catch(error => options.onLateAuditError!(error, index))
      .catch(() => { /* A broken error sink must not become an unhandled rejection. */ });
  }

  function accept(index: number, received: ModelReview): Promise<void> {
    const operation = acceptance.then(async () => {
      if (failure) return;
      let review = received;
      if (closed && received.status !== 'canceled') {
        audit(index, received);
        review = canceledReview(calls[index]!, received.durationMs, 'before durable acceptance');
      }
      if (!matches(index, review)) throw new Error(`Reviewer result does not match planned cell identity at index ${index}`);
      const countsTowardQuorum = review.status === 'success' && review.async !== true;
      if (dispatched.has(index) || intended.has(index)) {
        await options.acceptReview?.(structuredClone(review), index);
      }
      results[index] = review;
      options.onReviewComplete?.(structuredClone(review));
      if (review.status === 'error' && options.verbose) console.error(`${review.model}/${review.role}: ${review.error}`);
      if (countsTowardQuorum) {
        countSuccess(index);
        if (!closed && policy && hasSuccessfulQuorum(policy, successfulSeats)) { closed = 'quorum'; cancelCalls(); }
      }
    });
    acceptance = operation.catch(fail);
    return operation;
  }

  async function runOne(index: number): Promise<void> {
    const call = calls[index]!;
    if (retained.has(index)) return;
    if (stopped() || !eligible.has(index)) {
      await accept(index, canceledReview(call, 0, eligible.has(index) ? 'before starting' : 'not eligible for recovery'));
      return;
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    let canceled = false;
    let raw: ModelReview | undefined;
    let audited = false;
    function auditCanceledRaw(): void {
      if (canceled && raw && !audited) { audited = true; audit(index, raw); }
    }
    let cancel!: () => void;
    const cancellation = new Promise<ModelReview>(resolveCancel => {
      cancel = () => {
        canceled = true;
        const review = canceledReview(call, Date.now() - startedAt, 'while in flight');
        controller.abort();
        resolveCancel(review);
        auditCanceledRaw();
      };
      cancelOutstanding.add(cancel);
    });
    try {
      // Intent persistence is an owned, caller-bounded durability operation.
      // Cancellation signals it, but the run still observes how it settles.
      if (options.beforeReview) {
        try {
          const intent = await options.beforeReview(index, controller.signal);
          if (intent === false) {
            await accept(index, canceledReview(call, 0, 'intent declined before provider dispatch'));
            return;
          }
          intended.add(index);
        } catch (error) {
          if ((canceled || controller.signal.aborted || closed) && isAbortError(error)) {
            await accept(index, canceledReview(call, Date.now() - startedAt, 'while awaiting intent'));
            return;
          }
          fail(error);
          throw error;
        }
      }
      if (stopped()) {
        await accept(index, canceledReview(call, Date.now() - startedAt, 'before provider dispatch'));
        return;
      }
      let adapter: ReviewAdapter;
      try {
        const existing = adapters.get(call.provider);
        adapter = existing ?? factory(call.provider);
        if (!existing) adapters.set(call.provider, adapter);
      } catch (error) {
        await accept(index, failedReview(index, error, startedAt));
        return;
      }
      dispatched.add(index);
      const provider = (async (): Promise<ModelReview> => {
        try {
          raw = await adapter.review(call.model, call.role, call.systemPrompt, call.userPrompt,
            { ...adapterOpts, signal: controller.signal });
        } catch (error) { raw = failedReview(index, error, startedAt); }
        auditCanceledRaw();
        return raw;
      })();
      const review = await Promise.race([provider, cancellation]);
      // A returned response is no longer an in-flight provider call. Remove
      // it before acceptance can close quorum, so accepted work is not audited
      // as a canceled straggler by its own completion.
      cancelOutstanding.delete(cancel);
      await accept(index, review);
    } finally { cancelOutstanding.delete(cancel); }
  }

  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const queue = [...eligible];
    const width = Math.min(options.concurrency, queue.length);
    const workers = Array.from({ length: width }, async () => {
      while (!failure && nextIndex < queue.length) {
        const index = queue[nextIndex++]!;
        await runOne(index);
      }
    });
    await Promise.allSettled(workers);
    if (failure) throw failure.error;
    // Ineligible cells still occupy their original matrix positions. These
    // placeholders have no provider invocation and cannot become paid results.
    for (let index = 0; index < calls.length; index++) {
      if (!results[index]) await accept(index, canceledReview(calls[index]!, 0, 'not eligible for recovery'));
    }
    return results;
  } finally { options.signal?.removeEventListener('abort', abort); }
}
