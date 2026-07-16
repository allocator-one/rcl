import type { ModelReview } from '../consensus/types.js';
import type { ReviewAssignment } from '../roles/types.js';
import type { BuiltPrompt } from '../prepare/prompt-builder.js';
import type { AdapterOptions, ReviewAdapter } from './adapter.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import { GoogleAdapter } from './google.js';
import { OpenAICompatAdapter } from './openai-compat.js';

export interface RunnerOptions {
  timeoutMs: number;
  maxRetries: number;
  concurrency: number;
  verbose?: boolean;
  onReviewComplete?: (review: ModelReview) => void;
  /** Test seam / future config-key wiring; defaults to the builtin providers. */
  adapterFactory?: (provider: string) => ReviewAdapter;
}

type AdapterCall = {
  model: string;
  role: string;
  provider: string;
  systemPrompt: string;
  userPrompt: string;
};

function defaultAdapterFactory(provider: string): ReviewAdapter {
  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter();
    case 'openai':
      return new OpenAIAdapter();
    case 'google':
      return new GoogleAdapter();
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
  const factory = options.adapterFactory ?? defaultAdapterFactory;
  // One adapter (and HTTP client) per provider per run; a throwing
  // constructor is handled per call below so one bad provider doesn't
  // take down the pool.
  const adapters = new Map<string, ReviewAdapter>();

  const results: ModelReview[] = new Array(calls.length);
  let nextIndex = 0;

  async function runOne(index: number): Promise<void> {
    const call = calls[index]!;
    let review: ModelReview;
    try {
      let adapter = adapters.get(call.provider);
      if (!adapter) {
        adapter = factory(call.provider);
        adapters.set(call.provider, adapter);
      }
      review = await adapter.review(
        call.model,
        call.role,
        call.systemPrompt,
        call.userPrompt,
        adapterOpts
      );
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
