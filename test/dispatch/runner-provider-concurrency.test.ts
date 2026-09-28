import { describe, expect, it, vi } from 'vitest';
import { runReviews } from '../../src/dispatch/runner.js';
import type { ReviewAdapter } from '../../src/dispatch/adapter.js';
import type { ModelReview } from '../../src/consensus/types.js';
import type { BuiltPrompt } from '../../src/prepare/prompt-builder.js';
import type { ReviewAssignment, Role } from '../../src/roles/types.js';

function role(name: string): Role {
  return { name, systemPrompt: 'system', focus: [], description: name, isSpecialized: false };
}

function assignment(model: string, provider: string, roleName = model): ReviewAssignment {
  return { model, provider, role: role(roleName) };
}

function prompt(): BuiltPrompt {
  return { systemPrompt: 'system', userPrompt: 'user' } as BuiltPrompt;
}

function success(model: string, reviewerRole: string, provider: string): ModelReview {
  return { model, role: reviewerRole, provider, findings: [], durationMs: 1, status: 'success' };
}

describe('runReviews provider-aware scheduling', () => {
  it('bounds a representative five-role by five-chunk Fable plan without exceeding global concurrency', async () => {
    vi.useFakeTimers();
    try {
      let globalActive = 0;
      let globalPeak = 0;
      const active = new Map<string, number>();
      const peak = new Map<string, number>();
      const factory = (provider: string): ReviewAdapter => ({
        name: provider,
        provider,
        review: async (model, reviewerRole) => {
          globalActive++;
          globalPeak = Math.max(globalPeak, globalActive);
          const providerActive = (active.get(provider) ?? 0) + 1;
          active.set(provider, providerActive);
          peak.set(provider, Math.max(peak.get(provider) ?? 0, providerActive));
          await new Promise(resolve => setTimeout(resolve, provider === 'anthropic' ? 1 : 10));
          active.set(provider, (active.get(provider) ?? 1) - 1);
          globalActive--;
          return success(model, reviewerRole, provider);
        },
      });
      const seats = [
        ...Array.from({ length: 5 }, (_, seat) =>
          assignment('anthropic/claude-fable-5-1', 'anthropic', `fable-role-${seat}`)),
        ...Array.from({ length: 5 }, (_, seat) =>
          assignment('openai/gpt-6-sol', 'openai', `sol-role-${seat}`)),
        ...Array.from({ length: 4 }, (_, seat) =>
          assignment('google/gemini-3.8-flash', 'google', `gemini-role-${seat}`)),
      ];
      const calls = Array.from({ length: 5 }, () => seats).flat();

      const pending = runReviews(calls, calls.map(prompt), {
        timeoutMs: 540_000,
        maxRetries: 0,
        concurrency: 9,
        providerConcurrency: { anthropic: 2, openai: 3 },
        adapterFactory: factory,
        quorum: { fraction: 2 / 3 },
      });
      await vi.runAllTimersAsync();
      const reviews = await pending;

      expect(globalPeak).toBe(9);
      expect(peak.get('anthropic')).toBe(2);
      expect(peak.get('openai')).toBe(3);
      expect(reviews.map(review => review.model)).toEqual(calls.map(call => call.model));
      expect(reviews.map(review => review.status)).toEqual(
        calls.map((_call, index) => index >= 62 && index <= 65 ? 'canceled' : 'success')
      );
      const successfulChunks = new Map<string, number>();
      reviews.forEach((review, index) => {
        if (review.status !== 'success') return;
        const call = calls[index]!;
        const seat = JSON.stringify([call.provider, call.model, call.role.name]);
        successfulChunks.set(seat, (successfulChunks.get(seat) ?? 0) + 1);
      });
      const completedSeats = seats.filter(seat =>
        successfulChunks.get(JSON.stringify([seat.provider, seat.model, seat.role.name])) === 5);
      expect(completedSeats).toHaveLength(10);
      expect(completedSeats.filter(seat => seat.provider === 'anthropic')).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scans past a saturated provider instead of head-of-line blocking other providers', async () => {
    const starts: string[] = [];
    const releases = new Map<string, () => void>();
    const factory = (provider: string): ReviewAdapter => ({
      name: provider,
      provider,
      review: (model, reviewerRole) => new Promise(resolve => {
        starts.push(model);
        releases.set(model, () => resolve(success(model, reviewerRole, provider)));
      }),
    });
    const calls = [
      assignment('fable-1', 'anthropic'),
      assignment('fable-2', 'anthropic'),
      assignment('fable-3', 'anthropic'),
      assignment('sol-1', 'openai'),
      assignment('sol-2', 'openai'),
    ];

    const pending = runReviews(calls, calls.map(prompt), {
      timeoutMs: 540_000,
      maxRetries: 0,
      concurrency: 2,
      providerConcurrency: { anthropic: 1 },
      adapterFactory: factory,
    });

    await vi.waitFor(() => expect(starts).toEqual(['fable-1', 'sol-1']));
    releases.get('sol-1')!();
    await vi.waitFor(() => expect(starts).toEqual(['fable-1', 'sol-1', 'sol-2']));
    releases.get('fable-1')!();
    await vi.waitFor(() => expect(starts).toContain('fable-2'));
    releases.get('sol-2')!();
    releases.get('fable-2')!();
    await vi.waitFor(() => expect(starts).toContain('fable-3'));
    releases.get('fable-3')!();

    const reviews = await pending;
    expect(reviews.map(review => review.model)).toEqual(calls.map(call => call.model));
  });

  it('does not let a high global override exceed a provider cap', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const adapter: ReviewAdapter = {
        name: 'anthropic',
        provider: 'anthropic',
        review: async (model, reviewerRole) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 10));
          active--;
          return success(model, reviewerRole, 'anthropic');
        },
      };
      const calls = Array.from({ length: 12 }, (_, index) => assignment(`fable-${index}`, 'anthropic'));
      const pending = runReviews(calls, calls.map(prompt), {
        timeoutMs: 540_000,
        maxRetries: 0,
        concurrency: 99,
        providerConcurrency: { anthropic: 2 },
        adapterFactory: () => adapter,
      });
      await vi.runAllTimersAsync();
      await pending;
      expect(peak).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets an uncapped provider use the global bound', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let peak = 0;
      const adapter: ReviewAdapter = {
        name: 'openai',
        provider: 'openai',
        review: async (model, reviewerRole) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise(resolve => setTimeout(resolve, 10));
          active--;
          return success(model, reviewerRole, 'openai');
        },
      };
      const calls = Array.from({ length: 5 }, (_, index) => assignment(`sol-${index}`, 'openai'));
      const pending = runReviews(calls, calls.map(prompt), {
        timeoutMs: 540_000,
        maxRetries: 0,
        concurrency: 3,
        providerConcurrency: { anthropic: 2 },
        adapterFactory: () => adapter,
      });
      await vi.runAllTimersAsync();
      await pending;
      expect(peak).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes a large single-provider queue under a smaller provider bound', async () => {
    const adapter: ReviewAdapter = {
      name: 'anthropic',
      provider: 'anthropic',
      review: async (model, reviewerRole) => success(model, reviewerRole, 'anthropic'),
    };
    const calls = Array.from({ length: 10_000 }, (_, index) => assignment(`fable-${index}`, 'anthropic'));
    const reviews = await runReviews(calls, calls.map(prompt), {
      timeoutMs: 540_000,
      maxRetries: 0,
      concurrency: 3,
      providerConcurrency: { anthropic: 2 },
      adapterFactory: () => adapter,
    });
    expect(reviews).toHaveLength(calls.length);
    expect(reviews.every(review => review.status === 'success')).toBe(true);
  });

  it('preserves each provider FIFO across a large interleaved queue', async () => {
    const started: string[] = [];
    const adapterFactory = (provider: string): ReviewAdapter => ({
      name: provider,
      provider,
      review: async (model, reviewerRole) => {
        started.push(model);
        return success(model, reviewerRole, provider);
      },
    });
    const calls = Array.from({ length: 1_000 }, (_, index) => index % 2 === 0
      ? assignment(`fable-${index / 2}`, 'anthropic')
      : assignment(`sol-${(index - 1) / 2}`, 'openai'));
    await runReviews(calls, calls.map(prompt), {
      timeoutMs: 540_000,
      maxRetries: 0,
      concurrency: 3,
      providerConcurrency: { anthropic: 2, openai: 1 },
      adapterFactory,
    });
    expect(started.filter(model => model.startsWith('fable-')))
      .toEqual(Array.from({ length: 500 }, (_, index) => `fable-${index}`));
    expect(started.filter(model => model.startsWith('sol-')))
      .toEqual(Array.from({ length: 500 }, (_, index) => `sol-${index}`));
  });

  it('preserves a nonmonotonic caller priority across provider queues', async () => {
    const started: string[] = [];
    const providers = ['anthropic', 'anthropic', 'openai', 'openai', 'google', 'google'];
    const calls = providers.map((provider, index) => assignment(`model-${index}`, provider));
    await runReviews(calls, calls.map(prompt), {
      timeoutMs: 540_000,
      maxRetries: 0,
      concurrency: 1,
      providerConcurrency: { anthropic: 1, openai: 1, google: 1 },
      eligibleCallIndices: [5, 1, 3],
      adapterFactory: provider => ({
        name: provider,
        provider,
        review: async (model, reviewerRole) => {
          started.push(model);
          return success(model, reviewerRole, provider);
        },
      }),
    });
    expect(started).toEqual(['model-5', 'model-1', 'model-3']);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid direct runner provider cap of %s',
    async (limit) => {
      const call = assignment('fable', 'anthropic');
      await expect(runReviews([call], [prompt()], {
        timeoutMs: 540_000,
        maxRetries: 0,
        concurrency: 9,
        providerConcurrency: { anthropic: limit },
      })).rejects.toThrow(/provider concurrency/i);
    }
  );

  it('keeps queued saturated-provider calls unstarted after blocking quorum closes', async () => {
    const starts: string[] = [];
    const adapterFactory = (provider: string): ReviewAdapter => ({
      name: provider,
      provider,
      review: async (model, reviewerRole) => {
        starts.push(model);
        return success(model, reviewerRole, provider);
      },
    });
    const calls = [
      assignment('fable-1', 'anthropic'),
      assignment('fable-2', 'anthropic'),
      assignment('sol-1', 'openai'),
    ];

    const reviews = await runReviews(calls, calls.map(prompt), {
      timeoutMs: 540_000,
      maxRetries: 0,
      concurrency: 3,
      providerConcurrency: { anthropic: 1 },
      adapterFactory,
      quorum: { fraction: 2 / 3 },
    });

    expect(starts).toEqual(['fable-1', 'sol-1']);
    expect(reviews.map(review => review.status)).toEqual(['success', 'canceled', 'success']);
  });
});
