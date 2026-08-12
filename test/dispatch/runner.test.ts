import { describe, it, expect, vi } from 'vitest';
import { runReviews, defaultAdapterFactory } from '../../src/dispatch/runner.js';
import { detectProvider } from '../../src/roles/dispatcher.js';
import type { ReviewAdapter } from '../../src/dispatch/adapter.js';
import type { Role, ReviewAssignment } from '../../src/roles/types.js';
import type { BuiltPrompt } from '../../src/prepare/prompt-builder.js';
import type { ModelReview } from '../../src/consensus/types.js';

function makeRole(name: string): Role {
  return {
    name,
    systemPrompt: 'system',
    focus: [],
    description: name,
    isSpecialized: false,
  };
}

function makeAssignment(model: string, provider: string): ReviewAssignment {
  return { model, provider, role: makeRole('general') };
}

function makePrompt(): BuiltPrompt {
  return { systemPrompt: 'system', userPrompt: 'user' } as BuiltPrompt;
}

function successReview(model: string, provider: string): ModelReview {
  return {
    model,
    role: 'general',
    provider,
    findings: [],
    durationMs: 1,
    status: 'success',
  };
}

function delayedAdapter(
  delaysByModel: Record<string, number>,
  completions: string[]
): ReviewAdapter {
  return {
    name: 'fake',
    provider: 'fake',
    review: (model, _role, _s, _u, _opts) =>
      new Promise((resolve) => {
        setTimeout(() => {
          completions.push(model);
          resolve(successReview(model, 'fake'));
        }, delaysByModel[model] ?? 1);
      }),
  };
}

describe('runReviews worker pool', () => {
  it('does not head-of-line block: a slow call does not stall queued calls beyond pool width', async () => {
    const completions: string[] = [];
    const adapter = delayedAdapter({ slow: 80, fast1: 5, fast2: 5 }, completions);

    const assignments = [
      makeAssignment('slow', 'fake'),
      makeAssignment('fast1', 'fake'),
      makeAssignment('fast2', 'fake'),
    ];
    const reviews = await runReviews(
      assignments,
      assignments.map(makePrompt),
      {
        timeoutMs: 5000,
        maxRetries: 0,
        concurrency: 2,
        adapterFactory: () => adapter,
      }
    );

    // With sequential batches [slow, fast1] then [fast2], fast2 completes last.
    // With a worker pool, fast2 starts as soon as fast1 frees its slot.
    expect(completions).toEqual(['fast1', 'fast2', 'slow']);
    // Results stay aligned to input order regardless of completion order.
    expect(reviews.map((r) => r.model)).toEqual(['slow', 'fast1', 'fast2']);
  });

  it('reports progress for every call even when the adapter factory throws', async () => {
    const onReviewComplete = vi.fn();
    const adapter = delayedAdapter({}, []);

    const assignments = [
      makeAssignment('ok', 'fake'),
      makeAssignment('boom', 'broken'),
    ];
    const reviews = await runReviews(
      assignments,
      assignments.map(makePrompt),
      {
        timeoutMs: 5000,
        maxRetries: 0,
        concurrency: 2,
        onReviewComplete,
        adapterFactory: (provider) => {
          if (provider === 'broken') throw new Error('ANTHROPIC_API_KEY missing');
          return adapter;
        },
      }
    );

    expect(onReviewComplete).toHaveBeenCalledTimes(2);
    expect(reviews[1]!.status).toBe('error');
    expect(reviews[1]!.error).toContain('ANTHROPIC_API_KEY missing');
    expect(reviews[0]!.status).toBe('success');
  });

  it('throws when assignments and prompts lengths differ', async () => {
    await expect(
      runReviews([makeAssignment('m', 'fake')], [], {
        timeoutMs: 5000,
        maxRetries: 0,
        concurrency: 1,
      })
    ).rejects.toThrow(/same length/);
  });

  it('builds a working OpenRouter adapter end to end from an openrouter/ model', async () => {
    // Guards the whole wiring chain at once: detectProvider -> factory ->
    // OpenRouter key/baseURL (never the OpenAI key) -> prefix strip that
    // keeps the vendor segment -> reasoning effort -> provider label.
    const prev = process.env['OPENROUTER_API_KEY'];
    const prevOpenAI = process.env['OPENAI_API_KEY'];
    process.env['OPENROUTER_API_KEY'] = 'or-key';
    process.env['OPENAI_API_KEY'] = 'oai-key-must-not-be-used';
    try {
      const model = 'openrouter/moonshotai/kimi-k3';
      expect(detectProvider(model)).toBe('openrouter');

      const adapter = defaultAdapterFactory('openrouter') as unknown as {
        provider: string;
        client: { apiKey: string; baseURL: string };
        review: ReviewAdapter['review'];
      };
      expect(adapter.provider).toBe('openrouter');
      expect(adapter.client.apiKey).toBe('or-key');
      expect(adapter.client.baseURL).toBe('https://openrouter.ai/api/v1');

      let captured: Record<string, unknown> = {};
      (adapter as unknown as { client: unknown }).client = {
        chat: {
          completions: {
            create: (params: Record<string, unknown>) => {
              captured = params;
              return Promise.resolve({
                choices: [
                  { message: { content: '{"findings":[]}' }, finish_reason: 'stop' },
                ],
              });
            },
          },
        },
      };

      const reviews = await runReviews(
        [makeAssignment(model, detectProvider(model))],
        [makePrompt()],
        {
          timeoutMs: 5000,
          maxRetries: 0,
          concurrency: 1,
          adapterFactory: () => adapter as unknown as ReviewAdapter,
        }
      );

      expect(reviews[0]!.status).toBe('success');
      expect(reviews[0]!.provider).toBe('openrouter');
      expect(captured['model']).toBe('moonshotai/kimi-k3');
      expect(captured['reasoning']).toEqual({ effort: 'medium' });
    } finally {
      if (prev === undefined) delete process.env['OPENROUTER_API_KEY'];
      else process.env['OPENROUTER_API_KEY'] = prev;
      if (prevOpenAI === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = prevOpenAI;
    }
  });

  it('openrouter without OPENROUTER_API_KEY surfaces a per-review error', async () => {
    const prev = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
    try {
      const reviews = await runReviews(
        [makeAssignment('openrouter/moonshotai/kimi-k3', 'openrouter')],
        [makePrompt()],
        { timeoutMs: 1000, maxRetries: 0, concurrency: 1 }
      );
      expect(reviews[0]!.status).toBe('error');
      expect(reviews[0]!.error).toContain('OPENROUTER_API_KEY');
    } finally {
      if (prev !== undefined) process.env['OPENROUTER_API_KEY'] = prev;
    }
  });
});
