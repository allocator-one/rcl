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

export interface RunnerOptions {
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  verbose?: boolean;
  onReviewComplete?: (review: ModelReview) => void;
  /** Reasoning budget for providers that support it; defaults to 'medium'. */
  reasoningEffort?: ReasoningEffort;
  /** Test seam / config-key wiring; defaults to the builtin providers. */
  adapterFactory?: (provider: string) => ReviewAdapter;
  /**
   * Quorum round closure (RCL-26): once `fraction` of planned calls have
   * completed, outstanding calls are canceled and recorded as such — the
   * round stops waiting for stragglers. Calls from `coreModels` are never
   * canceled: the round always waits for the blocking council itself, so
   * wall-clock ≤ max(time to quorum, slowest core-model call). A fraction
   * of 1 (or omitting the option) disables early closure.
   */
  quorum?: { fraction: number; coreModels?: readonly string[] };
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

  // Quorum round closure (RCL-26). A call counts toward the quorum when it
  // settles for any reason except cancellation — a timeout completes at the
  // cap just like it does on the wall-clock. Core-model calls are exempt
  // from cancellation, so the round still waits for the blocking council.
  const planned = calls.length;
  // The epsilon absorbs float noise so fraction*planned that is
  // mathematically an integer (e.g. 2/3 of 6) never ceils one call too high.
  const quorumThreshold =
    options.quorum && options.quorum.fraction < 1
      ? Math.min(planned, Math.max(1, Math.ceil(options.quorum.fraction * planned - 1e-9)))
      : Infinity;
  const coreModels = new Set(options.quorum?.coreModels ?? []);
  let completedCount = 0;
  let roundClosed = false;
  const onRoundClosed: Array<() => void> = [];
  function noteCompletion(): void {
    completedCount++;
    if (!roundClosed && completedCount >= quorumThreshold) {
      roundClosed = true;
      for (const cancel of onRoundClosed) cancel();
    }
  }

  function canceledReview(call: AdapterCall, elapsedMs: number, detail: string): ModelReview {
    return {
      model: call.model,
      role: call.role,
      provider: call.provider,
      findings: [],
      durationMs: elapsedMs,
      status: 'canceled',
      error: `Canceled at quorum round closure ${detail}`,
    };
  }

  async function runOne(index: number): Promise<void> {
    const call = calls[index]!;
    const cancelable = quorumThreshold !== Infinity && !coreModels.has(call.model);
    let review: ModelReview;
    if (roundClosed && cancelable) {
      review = canceledReview(call, 0, 'before starting');
    } else {
      const startedAt = Date.now();
      const controller = new AbortController();
      try {
        let adapter = adapters.get(call.provider);
        if (!adapter) {
          adapter = factory(call.provider);
          adapters.set(call.provider, adapter);
        }
        const reviewPromise = adapter.review(
          call.model,
          call.role,
          call.systemPrompt,
          call.userPrompt,
          { ...adapterOpts, signal: controller.signal }
        );
        // Builtin adapters never reject, but a custom adapterFactory might.
        // Once the cancellation wins the race, a late rejection from the
        // abandoned promise must not surface as an unhandled rejection.
        reviewPromise.catch(() => {});
        review = cancelable
          ? await Promise.race([
              reviewPromise,
              new Promise<ModelReview>((resolveCancel) => {
                onRoundClosed.push(() => {
                  // Settle the cancellation FIRST: aborting can settle the
                  // adapter promise synchronously, and the race must record
                  // this call as canceled, not as the adapter's timeout.
                  resolveCancel(
                    canceledReview(
                      call,
                      Date.now() - startedAt,
                      `after ${Math.round((Date.now() - startedAt) / 1000)}s`
                    )
                  );
                  controller.abort();
                });
              }),
            ])
          : await reviewPromise;
      } catch (err) {
        review = {
          model: call.model,
          role: call.role,
          provider: call.provider,
          findings: [],
          durationMs: 0,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (review.status !== 'canceled') noteCompletion();
    if (review.status === 'error' && options.verbose) {
      console.error(`${call.model}/${call.role}: ${review.error}`);
    }
    options.onReviewComplete?.(review);
    results[index] = review;
  }

  // Index-stealing worker pool: each worker pulls the next unclaimed call,
  // so one slow provider never stalls the rest of the queue.
  const width = Math.max(1, Math.min(options.concurrency, calls.length));
  const workers = Array.from({ length: width }, async () => {
    while (nextIndex < calls.length) {
      const index = nextIndex++;
      await runOne(index);
    }
  });
  await Promise.all(workers);

  return results;
}
