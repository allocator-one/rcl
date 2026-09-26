import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { runReviews, reviewCallIdentity } from '../../src/dispatch/runner.js';
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

describe('runReviews successful-seat quorum closure (RCL-105)', () => {
  it('closes once the required complete seats succeeded and cancels stragglers', async () => {
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

  it('defaults an enabled quorum to two-thirds when its fraction is omitted', async () => {
    const adapter = delayedAdapter({ fast1: 5, fast2: 5, slow: Infinity });
    const assignments = ['fast1', 'fast2', 'slow'].map(makeAssignment);

    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 3,
      adapterFactory: () => adapter,
      quorum: {},
    });

    expect(reviews.map(review => review.status)).toEqual(['success', 'success', 'canceled']);
  });

  it('cancels a core model when successful quorum is reached', async () => {
    const adapter = delayedAdapter({ fast1: 5, fast2: 5, coreSlow: 150 });
    const assignments = ['fast1', 'fast2', 'coreSlow'].map(makeAssignment);

    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 3,
      adapterFactory: () => adapter,
      quorum: { fraction: 2 / 3, coreModels: ['coreSlow'] },
    });

    expect(reviews.find((r) => r.model === 'coreSlow')!.status).toBe('canceled');
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

  it('does not label a declined intent as a quorum cancellation when the round is open', async () => {
    const assignments = [makeAssignment('declined')];
    const factory = vi.fn(() => delayedAdapter({}));
    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 1000,
      maxRetries: 0,
      concurrency: 1,
      adapterFactory: factory,
      beforeReview: async () => false,
    });
    expect(reviews[0]!.error).toBe('Canceled intent declined before provider dispatch');
    expect(factory).not.toHaveBeenCalled();
  });

  it('a fraction of 1 requires every seat to succeed', async () => {
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

  it('does not cancel the remaining route to quorum after a failed completion', async () => {
    const adapter = delayedAdapter({ ok: 1, failing: 1, slow: 25 });
    const original = adapter.review;
    adapter.review = async (...args) => args[0] === 'failing'
      ? { ...successReview('failing'), status: 'error', error: 'boom' }
      : original(...args);
    const assignments = ['ok', 'failing', 'slow'].map(makeAssignment);
    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 1000, maxRetries: 0, concurrency: 3,
      adapterFactory: () => adapter, quorum: { fraction: 2 / 3 },
    });
    expect(reviews.map(review => review.status)).toEqual(['success', 'error', 'success']);
  });

  it('an exact-integer quorum fraction does not overshoot from float noise', async () => {
    // 2/3 of 6 must be 4 completions, not 5 — ceil(float noise) once cost a call.
    const adapter = delayedAdapter({
      f1: 5, f2: 5, f3: 5, f4: 5,
      s1: Infinity, s2: Infinity,
    });
    const assignments = ['f1', 'f2', 'f3', 'f4', 's1', 's2'].map(makeAssignment);
    const start = Date.now();
    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 6,
      adapterFactory: () => adapter,
      quorum: { fraction: 2 / 3 },
    });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(reviews.filter((r) => r.status === 'canceled')).toHaveLength(2);
  });

  it('a canceled call whose promise later rejects does not crash the run', async () => {
    const adapter: ReviewAdapter = {
      name: 'fake',
      provider: 'fake',
      review: (model, _role, _s, _u, opts: AdapterOptions) =>
        new Promise((resolve, reject) => {
          if (model !== 'slow') {
            setTimeout(() => resolve(successReview(model)), 5);
            return;
          }
          opts.signal?.addEventListener('abort', () =>
            setTimeout(() => reject(new Error('late rejection after cancel')), 10)
          );
        }),
      ask: async () => {
        throw new Error('not used');
      },
    };
    const assignments = ['a', 'b', 'slow'].map(makeAssignment);
    const reviews = await runReviews(assignments, assignments.map(makePrompt), {
      timeoutMs: 60_000,
      maxRetries: 0,
      concurrency: 3,
      adapterFactory: () => adapter,
      quorum: { fraction: 2 / 3 },
    });
    expect(reviews.find((r) => r.model === 'slow')!.status).toBe('canceled');
    // Give the late rejection a beat to fire; an unhandled rejection would
    // fail the test process.
    await new Promise((r) => setTimeout(r, 30));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const drain = () => new Promise<void>(resolve => setImmediate(resolve));

function controlled(assignments: ReviewAssignment[]) {
  const pending = assignments.map(() => deferred<ModelReview>());
  const started: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const adapter: ReviewAdapter = {
    name: 'controlled', provider: 'fake',
    review: (_model, _role, _system, user, options) => {
      const index = Number(user);
      started.push(index);
      signals[index] = options.signal;
      return pending[index]!.promise;
    },
    ask: async () => { throw new Error('not used'); },
  };
  const result = (index: number, status: ModelReview['status'] = 'success'): ModelReview => ({
    ...successReview(assignments[index]!.model),
    role: assignments[index]!.role.name,
    provider: assignments[index]!.provider,
    status,
  });
  return { pending, started, signals, adapter, result,
    prompts: assignments.map((_a, index) => ({ systemPrompt: 'system', userPrompt: String(index) })) };
}

const poolOptions = { timeoutMs: 1000, maxRetries: 0, concurrency: 20, quorum: { fraction: 2 / 3 } };

describe('complete-seat and durable-acceptance boundary', () => {
  it('counts complete seats instead of successful chunks', async () => {
    const assignments = ['a', 'a', 'b', 'b', 'c', 'c'].map(makeAssignment);
    const c = controlled(assignments);
    const running = runReviews(assignments, c.prompts, { ...poolOptions, adapterFactory: () => c.adapter });
    // Four successful chunks is not two complete seats: b's second chunk failed.
    for (const index of [0, 1, 2, 4]) c.pending[index]!.resolve(c.result(index));
    c.pending[3]!.resolve(c.result(3, 'parse_failed'));
    await drain();
    expect(c.signals[5]!.aborted).toBe(false);
    c.pending[5]!.resolve(c.result(5));
    expect((await running).map(r => r.status)).toEqual([
      'success', 'success', 'success', 'parse_failed', 'success', 'success',
    ]);
  });

  it('keeps distinct provider/model/role seats in the frozen denominator', async () => {
    const assignments = [makeAssignment('same'), makeAssignment('same'), makeAssignment('same')];
    assignments[1]!.role = makeRole('security');
    assignments[2]!.provider = 'other';
    const c = controlled(assignments);
    const running = runReviews(assignments, c.prompts, { ...poolOptions, adapterFactory: () => c.adapter });
    c.pending[0]!.resolve(c.result(0));
    c.pending[1]!.resolve(c.result(1));
    await drain();
    // Release the third promise even on a broken implementation, so RED cannot hang.
    const abortedAtQuorum = c.signals[2]!.aborted;
    c.pending[2]!.resolve(c.result(2));
    const reviews = await running;
    expect(abortedAtQuorum).toBe(true);
    expect(reviews.map(r => r.status)).toEqual(['success', 'success', 'canceled']);
  });

  it('does not count async results as blocking successes', async () => {
    const assignments = ['a', 'bonus', 'remaining'].map(makeAssignment);
    const c = controlled(assignments);
    const running = runReviews(assignments, c.prompts, { ...poolOptions, adapterFactory: () => c.adapter });
    c.pending[0]!.resolve(c.result(0));
    c.pending[1]!.resolve({ ...c.result(1), async: true });
    await drain();
    const prematurelyAborted = c.signals[2]!.aborted;
    c.pending[2]!.resolve(c.result(2));
    expect((await running)[2]!.status).toBe('success');
    expect(prematurelyAborted).toBe(false);
  });

  it.each(['model', 'role', 'provider'] as const)('rejects a substituted result %s before accepting it', async field => {
    const assignments = ['a', 'b', 'queued'].map(makeAssignment);
    const c = controlled(assignments);
    const acceptReview = vi.fn(async () => {});
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, concurrency: 1, adapterFactory: () => c.adapter, acceptReview,
    });
    const rejected = expect(running).rejects.toThrow(/planned.*identity/i);
    c.pending[0]!.resolve({ ...c.result(0), [field]: 'substituted' });
    c.pending[1]!.resolve(c.result(1)); c.pending[2]!.resolve(c.result(2));
    await rejected;
    expect(acceptReview).not.toHaveBeenCalled();
    expect(c.started).toEqual([0]);
  });

  it('waits for durable acceptance before counting a success or dispatching another cell', async () => {
    const assignments = ['a', 'b', 'queued'].map(makeAssignment);
    const c = controlled(assignments);
    const persisted = deferred<void>();
    const accepted: number[] = [];
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, concurrency: 1, adapterFactory: () => c.adapter,
      acceptReview: async (_review: ModelReview, index: number) => {
        if (index === 1) await persisted.promise;
        accepted.push(index);
      },
    });
    c.pending[0]!.resolve(c.result(0));
    await drain();
    c.pending[1]!.resolve(c.result(1));
    await drain();
    expect(accepted).toEqual([0]);
    expect(c.started).toEqual([0, 1]);
    persisted.resolve();
    const reviews = await running;
    expect(accepted).toEqual([0, 1]);
    expect(c.started).toEqual([0, 1]);
    expect(reviews.map(r => r.status)).toEqual(['success', 'success', 'canceled']);
  });

  it('fails closed on persistence failure and stops queued and hanging calls', async () => {
    const assignments = ['a', 'hanging', 'queued'].map(makeAssignment);
    const c = controlled(assignments);
    const onReviewComplete = vi.fn();
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, concurrency: 2, adapterFactory: () => c.adapter, onReviewComplete,
      acceptReview: async () => { throw new Error('durable store unavailable'); },
    });
    const rejected = expect(running).rejects.toThrow('durable store unavailable');
    c.pending[0]!.resolve(c.result(0));
    await drain();
    // Resolve fallback inputs for the unchanged runner's expected RED failure.
    c.pending[1]!.resolve(c.result(1)); c.pending[2]!.resolve(c.result(2));
    await rejected;
    expect(c.signals[1]!.aborted).toBe(true);
    expect(c.started).toEqual([0, 1]);
    expect(onReviewComplete).not.toHaveBeenCalled();
  });

  it('freezes quorum eligibility before invoking the progress callback', async () => {
    const assignments = ['failed', 'success', 'remaining'].map(makeAssignment);
    const c = controlled(assignments);
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions,
      adapterFactory: () => c.adapter,
      onReviewComplete: review => { if (review.model === 'failed') review.status = 'success'; },
    });
    c.pending[0]!.resolve(c.result(0, 'error'));
    c.pending[1]!.resolve(c.result(1));
    await drain();
    const prematurelyAborted = c.signals[2]!.aborted;
    c.pending[2]!.resolve(c.result(2));
    const reviews = await running;
    expect(prematurelyAborted).toBe(false);
    expect(reviews.map(review => review.status)).toEqual(['error', 'success', 'success']);
  });

  it('returns without waiting for a hanging core and fences its late success', async () => {
    const assignments = ['a', 'b', 'core'].map(makeAssignment);
    const c = controlled(assignments);
    const onReviewComplete = vi.fn();
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, adapterFactory: () => c.adapter, onReviewComplete,
      quorum: { fraction: 2 / 3, coreModels: ['core'] },
    });
    c.pending[0]!.resolve(c.result(0)); c.pending[1]!.resolve(c.result(1));
    const observed = await Promise.race([running.then(value => ({ value })), drain().then(() => ({ value: undefined }))]);
    const aborted = c.signals[2]!.aborted;
    c.pending[2]!.resolve(c.result(2));
    const reviews = await running;
    await drain();
    expect(observed.value).toBeDefined();
    expect(aborted).toBe(true);
    expect(reviews.map(r => r.status)).toEqual(['success', 'success', 'canceled']);
    expect(onReviewComplete).toHaveBeenCalledTimes(3);
  });

  it('preserves every accepted finding and never dispatches after the quorum transition', async () => {
    const assignments = ['a', 'b', 'queued'].map(makeAssignment);
    const c = controlled(assignments);
    const findings = [{ id: 'original', file: 'a.ts', startLine: 1, endLine: 1,
      severity: 'critical' as const, category: 'correctness' as const, title: 'Original', description: 'Preserve me' }];
    const original = { ...c.result(0), findings };
    const before = JSON.stringify(original);
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, concurrency: 1, adapterFactory: () => c.adapter,
    });
    c.pending[0]!.resolve(original); await drain();
    c.pending[1]!.resolve(c.result(1));
    const reviews = await running;
    expect(c.started).toEqual([0, 1]);
    expect(JSON.stringify(reviews[0])).toBe(before);
    expect(reviews[0]).toBe(original);
    // Repeated completion of the same provider promise cannot add a seat.
    c.pending[0]!.resolve(c.result(0));
    expect(reviews.map(r => r.status)).toEqual(['success', 'success', 'canceled']);
  });
});

// Independent identity vector; retained bytes come from the validated journal,
// not a freshly requested reviewer. The root plan validator owns global inputs.
function retainedCell(assignments: ReviewAssignment[], prompts: BuiltPrompt[], index: number, seatId?: string) {
  const a = assignments[index]!;
  const seat = seatId ?? JSON.stringify([a.provider, a.model, a.role.name]);
  const callIdentity = createHash('sha256').update(JSON.stringify([
    1, index, seat, a.provider, a.model, a.role.name,
    prompts[index]!.systemPrompt, prompts[index]!.userPrompt,
  ])).digest('hex');
  return { callIndex: index, callIdentity, review: {
    ...successReview(a.model), provider: a.provider, role: a.role.name,
  } };
}

describe('retained original matrix and recovery dispatch boundaries', () => {
  it('binds retained chunks to original index, seat, route and exact prompt bytes', () => {
    const assignment = makeAssignment('a'); const prompt = makePrompt();
    const expected = retainedCell([assignment], [prompt], 0, 'original-seat').callIdentity;
    expect(reviewCallIdentity(assignment, prompt, 0, 'original-seat')).toBe(expected);
    expect(reviewCallIdentity(assignment, prompt, 1, 'original-seat')).not.toBe(expected);
    expect(reviewCallIdentity(assignment, { ...prompt, userPrompt: 'changed' }, 0, 'original-seat')).not.toBe(expected);
    expect(reviewCallIdentity(assignment, prompt, 0, 'other-seat')).not.toBe(expected);
  });

  it.each([2, 3])('with %i retained successes at or above M launches zero calls and preserves bytes', async count => {
    const assignments = ['a', 'b', 'c'].map(makeAssignment); const c = controlled(assignments);
    const retainedReviews = Array.from({ length: count }, (_, i) => retainedCell(assignments, c.prompts, i));
    retainedReviews[0]!.review.findings = [{ id: 'kept', file: 'a.ts', startLine: 1, endLine: 1,
      severity: 'critical', category: 'correctness', title: 'Original', description: 'Keep this' }];
    const originals = retainedReviews.map(row => JSON.stringify(row.review));
    const factory = vi.fn(() => c.adapter); const acceptReview = vi.fn(async () => {}); const beforeReview = vi.fn(async () => {});
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const reviews = await runReviews(assignments, c.prompts, {
      ...poolOptions, retainedReviews, adapterFactory: factory, acceptReview, beforeReview,
    });
    expect(factory).not.toHaveBeenCalled(); expect(acceptReview).not.toHaveBeenCalled(); expect(beforeReview).not.toHaveBeenCalled();
    expect(reviews.slice(0, count).map(row => JSON.stringify(row))).toEqual(originals);
    expect(reviews.filter(row => row.status === 'success')).toHaveLength(count);
  });

  it('retains complete and partial seats and dispatches only the one missing chunk needed for quorum', async () => {
    const assignments = ['a', 'a', 'b', 'b', 'c', 'c'].map(makeAssignment); const c = controlled(assignments);
    const retainedReviews = [0, 1, 2, 4].map(i => retainedCell(assignments, c.prompts, i));
    const acceptReview = vi.fn(async () => {}); const beforeReview = vi.fn(async () => {});
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const reviews = await runReviews(assignments, c.prompts, {
      ...poolOptions, concurrency: 1, retainedReviews, adapterFactory: () => c.adapter, acceptReview, beforeReview,
    });
    expect(c.started).toEqual([3]);
    expect(beforeReview.mock.calls.map(call => call[0])).toEqual([3]);
    expect(acceptReview.mock.calls.map(call => call[1])).toEqual([3]);
    expect(reviews.map(r => r.status)).toEqual(['success', 'success', 'success', 'success', 'success', 'canceled']);
  });

  it('retains the full denominator when eligibility excludes unsuccessful cells', async () => {
    const assignments = ['a', 'b', 'c', 'permanent', 'uncertain'].map(makeAssignment); const c = controlled(assignments);
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const reviews = await runReviews(assignments, c.prompts, {
      ...poolOptions, retainedReviews: [0, 1].map(i => retainedCell(assignments, c.prompts, i)),
      eligibleCallIndices: [2], adapterFactory: () => c.adapter,
    });
    expect(c.started).toEqual([2]);
    expect(reviews.map(r => r.status)).toEqual(['success', 'success', 'success', 'canceled', 'canceled']);
    // Three successes is not the four required by the original five seats.
  });

  it('preserves wait-for-all compatibility when quorum is omitted while skipping retained cells', async () => {
    const assignments = ['a', 'b', 'c'].map(makeAssignment); const c = controlled(assignments);
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const reviews = await runReviews(assignments, c.prompts, {
      timeoutMs: 1000, maxRetries: 0, concurrency: 1,
      retainedReviews: [retainedCell(assignments, c.prompts, 0)], adapterFactory: () => c.adapter,
    });
    expect(c.started).toEqual([1, 2]); expect(reviews.every(r => r.status === 'success')).toBe(true);
  });

  it.each(['duplicate', 'out-of-range', 'fractional-index', 'chunk', 'identity', 'failure', 'async'])(
    'refuses invalid retained %s before any intent/provider call', async kind => {
      const assignments = ['a', 'a', 'b'].map(makeAssignment); const c = controlled(assignments);
      const row = retainedCell(assignments, c.prompts, 0);
      const retainedReviews = [row];
      if (kind === 'duplicate') retainedReviews.push(row);
      if (kind === 'out-of-range') row.callIndex = 3;
      if (kind === 'fractional-index') row.callIndex = 0.5;
      if (kind === 'chunk') row.callIndex = 1;
      if (kind === 'identity') row.review.model = 'substituted';
      if (kind === 'failure') row.review.status = 'error';
      if (kind === 'async') row.review.async = true;
      const factory = vi.fn(() => c.adapter); const beforeReview = vi.fn(async () => {});
      for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
      await expect(runReviews(assignments, c.prompts, {
        ...poolOptions, retainedReviews, beforeReview, adapterFactory: factory,
      })).rejects.toThrow(/retained/i);
      expect(factory).not.toHaveBeenCalled(); expect(beforeReview).not.toHaveBeenCalled();
    }
  );

  it.each([[1, 1], [-1], [3], [0.5], [0]].map(indices => ({ indices })))('refuses invalid or already retained eligible indices $indices', async ({ indices }) => {
    const assignments = ['a', 'b', 'c'].map(makeAssignment); const c = controlled(assignments);
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const factory = vi.fn(() => c.adapter);
    await expect(runReviews(assignments, c.prompts, {
      ...poolOptions, retainedReviews: [retainedCell(assignments, c.prompts, 0)],
      eligibleCallIndices: indices, adapterFactory: factory,
    })).rejects.toThrow(/eligible/i);
    expect(factory).not.toHaveBeenCalled();
  });

  it('awaits the owned intent before provider dispatch and refuses intent failure', async () => {
    const assignments = ['a', 'b', 'c'].map(makeAssignment); const c = controlled(assignments);
    const intent = deferred<void>(); const beforeReview = vi.fn(() => intent.promise);
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, concurrency: 1, beforeReview, adapterFactory: () => c.adapter,
    });
    const rejected = expect(running).rejects.toThrow('budget exhausted');
    await drain(); const startedBeforeIntent = [...c.started];
    intent.reject(new Error('budget exhausted'));
    // Observe the deliberately rejected fixture even if the old runner ignores it.
    void intent.promise.catch(() => {});
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    await rejected; expect(startedBeforeIntent).toEqual([]); expect(c.started).toEqual([]);
  });

  it('treats an abort-aware intent canceled at quorum as a canceled cell', async () => {
    const assignments = ['a', 'b', 'waiting-intent'].map(makeAssignment); const c = controlled(assignments);
    const beforeReview = vi.fn((index: number, signal: AbortSignal): Promise<void> => {
      if (index !== 2) return Promise.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('intent aborted', 'AbortError')), { once: true });
      });
    });
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, adapterFactory: () => c.adapter, beforeReview,
    });
    c.pending[0]!.resolve(c.result(0)); c.pending[1]!.resolve(c.result(1));
    await expect(running).resolves.toEqual([
      c.result(0), c.result(1), expect.objectContaining({ status: 'canceled' }),
    ]);
    expect(c.started).toEqual([0, 1]);
  });

  it('does not suppress an independent intent persistence failure during quorum cancellation', async () => {
    const assignments = ['a', 'b', 'waiting-intent'].map(makeAssignment); const c = controlled(assignments);
    const beforeReview = vi.fn((index: number, signal: AbortSignal): Promise<void> => {
      if (index !== 2) return Promise.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('intent store unavailable')), { once: true });
      });
    });
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, adapterFactory: () => c.adapter, beforeReview,
    });
    const rejected = expect(running).rejects.toThrow('intent store unavailable');
    c.pending[0]!.resolve(c.result(0)); c.pending[1]!.resolve(c.result(1));
    await rejected;
    expect(c.started).toEqual([0, 1]);
  });

  it('waits for a delayed intent persistence failure after quorum cancellation', async () => {
    const assignments = ['a', 'b', 'waiting-intent'].map(makeAssignment); const c = controlled(assignments);
    const beforeReview = vi.fn((index: number, signal: AbortSignal): Promise<void> => {
      if (index !== 2) return Promise.resolve();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => reject(new Error('delayed intent store failure')), 10);
        }, { once: true });
      });
    });
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, adapterFactory: () => c.adapter, beforeReview,
    });
    const rejected = expect(running).rejects.toThrow('delayed intent store failure');
    c.pending[0]!.resolve(c.result(0)); c.pending[1]!.resolve(c.result(1));
    await rejected;
    expect(c.started).toEqual([0, 1]);
  });

  it('external cancellation aborts noncooperative calls even without quorum', async () => {
    const assignments = ['a', 'b', 'queued'].map(makeAssignment); const c = controlled(assignments);
    const controller = new AbortController(); const acceptReview = vi.fn(async () => {});
    const running = runReviews(assignments, c.prompts, {
      timeoutMs: 1000, maxRetries: 0, concurrency: 2, signal: controller.signal,
      adapterFactory: () => c.adapter, acceptReview,
    });
    controller.abort();
    const observed = await Promise.race([running.then(value => ({ value })), drain().then(() => ({ value: undefined }))]);
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const reviews = await running;
    expect(observed.value).toBeDefined(); expect(c.started).toEqual([0, 1]);
    expect(c.signals[0]!.aborted && c.signals[1]!.aborted).toBe(true);
    expect(reviews.every(r => r.status === 'canceled')).toBe(true);
    expect(acceptReview.mock.calls.map(call => call[1])).toEqual([0, 1]);
  });

  it('an already aborted signal makes no intent, acceptance or provider calls', async () => {
    const assignments = ['a', 'b'].map(makeAssignment); const c = controlled(assignments);
    c.pending[0]!.resolve(c.result(0)); c.pending[1]!.resolve(c.result(1));
    const controller = new AbortController(); controller.abort();
    const beforeReview = vi.fn(async () => {}); const acceptReview = vi.fn(async () => {}); const factory = vi.fn(() => c.adapter);
    const result = await runReviews(assignments, c.prompts, {
      ...poolOptions, signal: controller.signal, beforeReview, acceptReview, adapterFactory: factory,
    });
    expect(result.every(r => r.status === 'canceled')).toBe(true);
    expect(factory).not.toHaveBeenCalled(); expect(beforeReview).not.toHaveBeenCalled(); expect(acceptReview).not.toHaveBeenCalled();
  });

  it('uses explicit original seat instances instead of collapsing identical model-role tuples', async () => {
    const assignments = ['same', 'same', 'same'].map(makeAssignment); const c = controlled(assignments);
    const seatIds = ['seat-a', 'seat-b', 'seat-c'];
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const reviews = await runReviews(assignments, c.prompts, {
      ...poolOptions, concurrency: 1, seatIds, adapterFactory: () => c.adapter,
      retainedReviews: [retainedCell(assignments, c.prompts, 0, seatIds[0])],
    });
    expect(c.started).toEqual([1]); expect(reviews.map(r => r.status)).toEqual(['success', 'success', 'canceled']);
  });

  it.each([['short'], ['a', ''], ['same', 'same'], new Array<string>(2)].map(seatIds => ({ seatIds })))('refuses invalid or inconsistent seat IDs $seatIds', async ({ seatIds }) => {
    const assignments = ['a', 'b'].map(makeAssignment); const c = controlled(assignments);
    c.pending[0]!.resolve(c.result(0)); c.pending[1]!.resolve(c.result(1));
    const factory = vi.fn(() => c.adapter);
    await expect(runReviews(assignments, c.prompts, { ...poolOptions, seatIds, adapterFactory: factory })).rejects.toThrow(/seat/i);
    expect(factory).not.toHaveBeenCalled();
  });

  it('audits late success and rejection without changing the report, and reports audit failure', async () => {
    const assignments = ['a', 'b', 'late-success', 'late-error'].map(makeAssignment); const c = controlled(assignments);
    const auditLateReview = vi.fn(async (review: ModelReview) => {
      review.findings.push({ id: 'audit-only', file: 'x', startLine: 1, endLine: 1,
        severity: 'critical', category: 'correctness', title: 'Audit only', description: 'Must not mutate report' });
      if (review.status === 'error') throw new Error('audit unavailable');
    });
    const onLateAuditError = vi.fn();
    const running = runReviews(assignments, c.prompts, {
      ...poolOptions, quorum: { fraction: 2 / 3 },
      retainedReviews: [0, 1].map(i => retainedCell(assignments, c.prompts, i)),
      adapterFactory: () => c.adapter, auditLateReview, onLateAuditError,
    });
    c.pending[0]!.resolve(c.result(0)); c.pending[1]!.resolve(c.result(1));
    c.pending[2]!.resolve(c.result(2));
    const reviews = await running; const before = JSON.stringify(reviews);
    c.pending[3]!.reject(new Error('late provider error')); await drain();
    expect(JSON.stringify(reviews)).toBe(before);
    expect(auditLateReview).toHaveBeenCalledTimes(1);
    expect(auditLateReview.mock.calls[0]![0].status).toBe('error');
    expect(onLateAuditError).toHaveBeenCalledWith(expect.objectContaining({ message: 'audit unavailable' }), 3);
  });

  it('records a late raw success as audit only after canceled report finalization', async () => {
    const assignments = ['a', 'b', 'late'].map(makeAssignment); const c = controlled(assignments);
    const auditLateReview = vi.fn(async () => {}); const onLateAuditError = vi.fn();
    const running = runReviews(assignments, c.prompts, { ...poolOptions, adapterFactory: () => c.adapter, auditLateReview, onLateAuditError });
    c.pending[0]!.resolve(c.result(0)); c.pending[1]!.resolve(c.result(1));
    const reviews = await running; const before = JSON.stringify(reviews);
    c.pending[2]!.resolve(c.result(2)); await drain();
    expect(auditLateReview).toHaveBeenCalledWith(c.result(2), 2);
    expect(JSON.stringify(reviews)).toBe(before); expect(onLateAuditError).not.toHaveBeenCalled();
  });
});


describe('recovery priority and numeric preflight', () => {
  it('honors eligible order so the closest incomplete seat wins at concurrency one', async () => {
    const assignments = ['a', 'a', 'a', 'b', 'b', 'b', 'c', 'c', 'c'].map(makeAssignment);
    const c = controlled(assignments);
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const reviews = await runReviews(assignments, c.prompts, {
      ...poolOptions, concurrency: 1, adapterFactory: () => c.adapter,
      retainedReviews: [0, 3, 4, 6, 7, 8].map(i => retainedCell(assignments, c.prompts, i)),
      eligibleCallIndices: [5, 1, 2],
    });
    expect(c.started).toEqual([5]);
    expect(reviews.map(r => r.model)).toEqual(assignments.map(a => a.model));
    expect(reviews.map(r => r.status)).toEqual([
      'success', 'canceled', 'canceled', 'success', 'success', 'success', 'success', 'success', 'success',
    ]);
  });

  it.each([
    { timeoutMs: Number.NaN }, { timeoutMs: Infinity }, { timeoutMs: 0 }, { timeoutMs: 2 ** 31 },
    { concurrency: Number.NaN }, { concurrency: Infinity }, { concurrency: 0 }, { concurrency: -1 }, { concurrency: 1.5 },
  ])('refuses invalid numeric runner bounds $timeoutMs/$concurrency before provider setup', async invalid => {
    const assignments = ['a', 'b', 'c'].map(makeAssignment); const c = controlled(assignments);
    for (let i = 0; i < assignments.length; i++) c.pending[i]!.resolve(c.result(i));
    const factory = vi.fn(() => c.adapter);
    await expect(runReviews(assignments, c.prompts, { ...poolOptions, ...invalid, adapterFactory: factory }))
      .rejects.toThrow(/timeout|concurrency/i);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects a quorum fraction below two-thirds before provider setup', async () => {
    const assignments = ['a', 'b', 'c'].map(makeAssignment); const c = controlled(assignments);
    const factory = vi.fn(() => c.adapter);
    await expect(runReviews(assignments, c.prompts, {
      ...poolOptions, quorum: { fraction: 0.5 }, adapterFactory: factory,
    })).rejects.toThrow(/fraction/i);
    expect(factory).not.toHaveBeenCalled();
  });
});


it('an intent skip leaves other in-flight calls alive to reach quorum', async () => {
  const assignments = ['reserved-slow', 'reserved-fast', 'budget-refused'].map(makeAssignment);
  const c = controlled(assignments);
  const beforeReview = vi.fn(async (index: number): Promise<void | false> => index === 2 ? false : undefined);
  const acceptReview = vi.fn(async () => {});
  const running = runReviews(assignments, c.prompts, {
    ...poolOptions, concurrency: 2, adapterFactory: () => c.adapter, beforeReview, acceptReview,
  });
  await drain();
  expect(c.started).toEqual([0, 1]);
  c.pending[1]!.resolve(c.result(1));
  await drain();
  const dispatchedBeforeSlowFinishes = [...c.started];
  const slowWasAborted = c.signals[0]!.aborted;
  c.pending[0]!.resolve(c.result(0));
  c.pending[2]!.resolve(c.result(2)); // lets the old implementation terminate on RED
  const reviews = await running;
  expect(beforeReview.mock.calls.map(call => call[0])).toEqual([0, 1, 2]);
  expect(dispatchedBeforeSlowFinishes).toEqual([0, 1]);
  expect(slowWasAborted).toBe(false);
  expect(acceptReview.mock.calls.map(call => call[1])).toEqual([1, 0]);
  expect(reviews.map(review => review.status)).toEqual(['success', 'success', 'canceled']);
});
