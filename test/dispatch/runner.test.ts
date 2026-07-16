import { describe, it, expect, vi } from 'vitest';
import { runReviews } from '../../src/dispatch/runner.js';
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
});
