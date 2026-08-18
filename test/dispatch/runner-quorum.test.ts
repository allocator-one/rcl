import { describe, it, expect } from 'vitest';
import { runReviews } from '../../src/dispatch/runner.js';
import type { ReviewAdapter, AdapterOptions } from '../../src/dispatch/adapter.js';
import type { Role, ReviewAssignment } from '../../src/roles/types.js';
import type { BuiltPrompt } from '../../src/prepare/prompt-builder.js';
import type { ModelReview } from '../../src/consensus/types.js';

function makeRole(name: string): Role {
  return { name, systemPrompt: 'system', focus: [], description: name, isSpecialized: false };
}

function makeAssignment(model: string): ReviewAssignment {
  return { model, provider: 'fake', role: makeRole('general') };
}

function makePrompt(): BuiltPrompt {
  return { systemPrompt: 'system', userPrompt: 'user' } as BuiltPrompt;
}

function successReview(model: string): ModelReview {
  return { model, role: 'general', provider: 'fake', findings: [], durationMs: 1, status: 'success' };
}

/** Adapter where each model resolves after its configured delay, or hangs
 * until aborted when delay is Infinity. */
function delayedAdapter(delaysByModel: Record<string, number>): ReviewAdapter {
  return {
    name: 'fake',
    provider: 'fake',
    review: (model, _role, _s, _u, opts: AdapterOptions) =>
      new Promise((resolve) => {
        const delay = delaysByModel[model] ?? 1;
        if (delay === Infinity) {
          opts.signal?.addEventListener('abort', () =>
            resolve({ ...successReview(model), status: 'timeout', error: 'aborted' })
          );
          return;
        }
        setTimeout(() => resolve(successReview(model)), delay);
      }),
    ask: async () => {
      throw new Error('not used');
    },
  };
}

describe('runReviews quorum closure (RCL-26)', () => {
  it('closes the round once the quorum fraction has completed and cancels stragglers', async () => {
    const adapter = delayedAdapter({ fast1: 5, fast2: 5, fast3: 5, fast4: 5, slow1: Infinity, slow2: Infinity });
    const assignments = ['fast1', 'fast2', 'fast3', 'fast4', 'slow1', 'slow2'].map(makeAssignment);

    const start = Date.now();
    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 6,
      adapterFactory: () => adapter,
      quorum: { fraction: 2 / 3 },
    });
    expect(Date.now() - start).toBeLessThan(5_000);

    const byModel = new Map(reviews.map((r) => [r.model, r]));
    for (const fast of ['fast1', 'fast2', 'fast3', 'fast4']) {
      expect(byModel.get(fast)!.status).toBe('success');
    }
    for (const slow of ['slow1', 'slow2']) {
      const r = byModel.get(slow)!;
      expect(r.status).toBe('canceled');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.error).toMatch(/quorum/i);
    }
  });

  it('never cancels a core model call — the round waits for it', async () => {
    const adapter = delayedAdapter({ fast1: 5, fast2: 5, coreSlow: 150 });
    const assignments = ['fast1', 'fast2', 'coreSlow'].map(makeAssignment);

    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 3,
      adapterFactory: () => adapter,
      quorum: { fraction: 2 / 3, coreModels: ['coreSlow'] },
    });

    expect(reviews.find((r) => r.model === 'coreSlow')!.status).toBe('success');
  });

  it('cancels queued calls that have not started when the round closes', async () => {
    const adapter = delayedAdapter({ fast1: 5, fast2: 5, queuedSlow: Infinity });
    const assignments = ['fast1', 'fast2', 'queuedSlow'].map(makeAssignment);

    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 1,
      adapterFactory: () => adapter,
      quorum: { fraction: 2 / 3 },
    });

    const queued = reviews.find((r) => r.model === 'queuedSlow')!;
    expect(queued.status).toBe('canceled');
    expect(queued.durationMs).toBe(0);
  });

  it('runs everything to completion when quorum is not configured', async () => {
    const adapter = delayedAdapter({ a: 5, b: 30, c: 60 });
    const assignments = ['a', 'b', 'c'].map(makeAssignment);
    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 3,
      adapterFactory: () => adapter,
    });
    expect(reviews.every((r) => r.status === 'success')).toBe(true);
  });

  it('a fraction of 1 disables early closure', async () => {
    const adapter = delayedAdapter({ a: 5, b: 5, c: 80 });
    const assignments = ['a', 'b', 'c'].map(makeAssignment);
    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 3,
      adapterFactory: () => adapter,
      quorum: { fraction: 1 },
    });
    expect(reviews.every((r) => r.status === 'success')).toBe(true);
  });

  it('propagates the abort to the in-flight adapter call', async () => {
    let sawAbort = false;
    const adapter: ReviewAdapter = {
      name: 'fake',
      provider: 'fake',
      review: (model, _role, _s, _u, opts: AdapterOptions) =>
        new Promise((resolve) => {
          if (model !== 'slow') {
            setTimeout(() => resolve(successReview(model)), 5);
            return;
          }
          opts.signal?.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ ...successReview(model), status: 'timeout', error: 'aborted' });
          });
        }),
      ask: async () => {
        throw new Error('not used');
      },
    };
    const assignments = ['a', 'b', 'slow'].map(makeAssignment);
    await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 3,
      adapterFactory: () => adapter,
      quorum: { fraction: 2 / 3 },
    });
    expect(sawAbort).toBe(true);
  });
});
