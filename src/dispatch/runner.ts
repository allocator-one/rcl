import type { ModelReview } from '../consensus/types.js';
import type { ReviewAssignment } from '../roles/types.js';
import type { BuiltPrompt } from '../prepare/prompt-builder.js';
import type { AdapterOptions } from './adapter.js';
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
}

type AdapterCall = {
  model: string;
  role: string;
  provider: string;
  systemPrompt: string;
  userPrompt: string;
};

function getAdapter(provider: string): {
  review: (
    model: string,
    role: string,
    system: string,
    user: string,
    opts: AdapterOptions
  ) => Promise<ModelReview>;
} {
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

async function runBatch(
  calls: AdapterCall[],
  options: RunnerOptions
): Promise<ModelReview[]> {
  const adapterOpts: AdapterOptions = {
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
  };

  const results = await Promise.allSettled(
    calls.map(async (call) => {
      const adapter = getAdapter(call.provider);
      const review = await adapter.review(
        call.model,
        call.role,
        call.systemPrompt,
        call.userPrompt,
        adapterOpts
      );
      if (review.status === 'error' && options.verbose) {
        console.error(`${call.model}/${call.role}: ${review.error}`);
      }
      options.onReviewComplete?.(review);
      return review;
    })
  );

  return results.map((r, i): ModelReview => {
    if (r.status === 'fulfilled') return r.value;
    const call = calls[i]!;
    return {
      model: call.model,
      role: call.role,
      provider: call.provider,
      findings: [],
      durationMs: 0,
      status: 'error',
      error: String(r.reason),
    };
  });
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

  // Process in batches of concurrency size
  const { concurrency } = options;
  const allResults: ModelReview[] = [];

  for (let i = 0; i < calls.length; i += concurrency) {
    const batch = calls.slice(i, i + concurrency);
    const batchResults = await runBatch(batch, options);
    allResults.push(...batchResults);
  }

  return allResults;
}
