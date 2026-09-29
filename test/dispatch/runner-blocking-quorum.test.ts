import { describe, expect, it } from 'vitest';
import type { ModelReview } from '../../src/consensus/types.js';
import type { AdapterOptions, ReviewAdapter } from '../../src/dispatch/adapter.js';
import { mergeChunkReviews } from '../../src/dispatch/merge.js';
import { reviewCallIdentity, runReviews } from '../../src/dispatch/runner.js';
import type { BuiltPrompt } from '../../src/prepare/prompt-builder.js';
import { deriveBlockingHealth } from '../../src/report/blocking-health.js';
import type { RosterEntry } from '../../src/report/run-header.js';
import type { ReviewAssignment, Role } from '../../src/roles/types.js';

const role: Role = { name: 'general', systemPrompt: 'system', focus: [], description: 'general', isSpecialized: false };
const assignment = (model: string): ReviewAssignment => ({ model, provider: 'fake', role });
const prompt = (): BuiltPrompt => ({ systemPrompt: 'system', userPrompt: 'user' }) as BuiltPrompt;

type Scripted = ModelReview['status'] | 'held';

/**
 * Synthetic provider: each model answers immediately with its scripted status,
 * or is held until the test releases it. Records aborts so premature
 * cancellation is observable without timing assumptions.
 */
function scriptedAdapter(script: (model: string, call: number) => Scripted) {
  const held = new Map<string, Array<(status: ModelReview['status']) => void>>();
  const aborted: string[] = [];
  const calls = new Map<string, number>();
  let notify: () => void = () => {};
  const adapter: ReviewAdapter = {
    name: 'fake', provider: 'fake',
    review: (model, reviewRole, _system, _user, options: AdapterOptions) => new Promise((resolve) => {
      const call = calls.get(model) ?? 0;
      calls.set(model, call + 1);
      const answer = (status: ModelReview['status']) => resolve({
        model, role: reviewRole, provider: 'fake', findings: [], durationMs: 1, status,
        ...(status === 'success' ? {} : { error: status }),
      });
      options.signal?.addEventListener('abort', () => { aborted.push(model); answer('timeout'); });
      const status = script(model, call);
      if (status === 'held') {
        held.set(model, [...(held.get(model) ?? []), answer]);
        notify();
      } else answer(status);
    }),
    ask: async () => { throw new Error('not used'); },
  };
  return {
    adapter, aborted,
    heldCount: () => [...held.values()].reduce((sum, list) => sum + list.length, 0),
    // One outstanding wait at a time is enough for these sequential scenarios.
    whenHeld: (count: number) => new Promise<void>((resolve) => {
      const check = () => { if ([...held.values()].reduce((sum, list) => sum + list.length, 0) >= count) resolve(); };
      notify = check;
      check();
    }),
    release: (model: string, status: ModelReview['status']) => held.get(model)!.shift()!(status),
  };
}

function council(blocking: string[], secondary: string[], chunks = 1) {
  const models = [...blocking, ...secondary];
  const perChunk = models.map(assignment);
  const assignments = Array.from({ length: chunks }, () => perChunk).flat();
  const roster: RosterEntry[] = models.map((model) => ({
    model, role: 'general', provider: 'fake', lane: blocking.includes(model) ? 'blocking' : 'secondary',
  }));
  return { assignments, prompts: assignments.map(prompt), roster,
    blockingLanes: assignments.map((entry) => blocking.includes(entry.model)) };
}

const names = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

describe('runner closes quorum on blocking seats only (RCL-136)', () => {
  it('does not let four secondary successes cancel unfinished blocking reviewers', async () => {
    const blocking = names('b', 10);
    const secondary = names('s', 4);
    const { assignments, prompts, roster, blockingLanes } = council(blocking, secondary);
    const slow = new Set(['b7', 'b8', 'b9', 'b10']);
    const fake = scriptedAdapter((model) => slow.has(model) ? 'held' : 'success');
    const run = runReviews(assignments, prompts, {
      timeoutMs: 60_000, maxRetries: 0, concurrency: 14, adapterFactory: () => fake.adapter,
      quorum: { fraction: 2 / 3, blocking: blockingLanes },
    });
    // 6 blocking + 4 secondary successes equal the old all-seat quorum of 10/14.
    await fake.whenHeld(4);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.aborted).toEqual([]);
    for (const model of ['b7', 'b8', 'b9', 'b10']) fake.release(model, 'error');
    const reviews = await run;
    expect(reviews.filter((review) => review.status === 'canceled')).toEqual([]);
    expect(reviews.map((review) => review.status)).toEqual([...Array(6).fill('success'), ...Array(4).fill('error'), ...Array(4).fill('success')]);
    const health = deriveBlockingHealth({ roster, reviews: mergeChunkReviews(reviews) });
    expect(health).toMatchObject({ conclusive: false, policy: { seatCount: 10, minimumSuccessful: 7 },
      excludedSuccesses: { secondary: 4, async: 0, verification: 0 } });
  });

  it('closes exactly when the seventh of ten blocking seats completes', async () => {
    const { assignments, prompts, roster, blockingLanes } = council(names('b', 10), names('s', 4));
    const fake = scriptedAdapter((model) => ['b7', 'b8', 'b9', 'b10'].includes(model) ? 'held' : 'success');
    const run = runReviews(assignments, prompts, {
      timeoutMs: 60_000, maxRetries: 0, concurrency: 14, adapterFactory: () => fake.adapter,
      quorum: { fraction: 2 / 3, blocking: blockingLanes },
    });
    await fake.whenHeld(4);
    fake.release('b7', 'success');
    const reviews = await run;
    expect(reviews.slice(0, 7).every((review) => review.status === 'success')).toBe(true);
    expect(reviews.slice(7, 10).map((review) => review.error)).toEqual(Array(3).fill('Canceled at quorum round closure while in flight'));
    expect(fake.aborted.sort()).toEqual(['b10', 'b8', 'b9']);
    const health = deriveBlockingHealth({ roster, reviews: mergeChunkReviews(reviews) });
    expect(health).toMatchObject({ conclusive: true, policy: { minimumSuccessful: 7 } });
    expect(health.successfulSeats).toHaveLength(7);
  });

  it('waits for 12 of 17 blocking seats and ignores an unrelated secondary success', async () => {
    const { assignments, prompts, roster, blockingLanes } = council(names('b', 17), ['s1']);
    const fake = scriptedAdapter((model) => Number(model.slice(1)) > 11 && model.startsWith('b') ? 'held' : 'success');
    const run = runReviews(assignments, prompts, {
      timeoutMs: 60_000, maxRetries: 0, concurrency: 18, adapterFactory: () => fake.adapter,
      quorum: { blocking: blockingLanes },
    });
    await fake.whenHeld(6);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.aborted).toEqual([]);
    for (const model of names('b', 17).slice(11)) fake.release(model, 'timeout');
    const reviews = await run;
    const health = deriveBlockingHealth({ roster, reviews: mergeChunkReviews(reviews) });
    expect(health).toMatchObject({ conclusive: false, policy: { seatCount: 17, minimumSuccessful: 12 } });
    expect(health.successfulSeats).toHaveLength(11);
    expect(reviews.filter((review) => review.status === 'canceled')).toEqual([]);
  });

  it('requires every chunk of a blocking seat before it counts toward closure', async () => {
    const { assignments, prompts, roster, blockingLanes } = council(['b1', 'b2', 'b3'], ['s1'], 2);
    // Every seat's first chunk succeeds at once; b2's and b3's second chunks are held.
    const fake = scriptedAdapter((model, call) => model === 'b2' && call === 1 ? 'held' : model === 'b3' && call === 1 ? 'held' : 'success');
    const run = runReviews(assignments, prompts, {
      timeoutMs: 60_000, maxRetries: 0, concurrency: 8, adapterFactory: () => fake.adapter,
      quorum: { blocking: blockingLanes },
    });
    await fake.whenHeld(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.aborted).toEqual([]); // only b1 and s1 are complete; 2 blocking seats are required
    fake.release('b2', 'success');
    const reviews = await run;
    expect(fake.aborted).toEqual(['b3']);
    const health = deriveBlockingHealth({ roster, reviews: mergeChunkReviews(reviews) });
    expect(health.successfulSeats.map((seat) => seat.model)).toEqual(['b1', 'b2']);
    expect(health.unsuccessfulSeats).toEqual([{ model: 'b3', role: 'general', status: 'canceled' }]);
    expect(health.conclusive).toBe(true);
  });

  it('preserves a stricter explicit quorum fraction', async () => {
    const { assignments, prompts, roster, blockingLanes } = council(names('b', 10), names('s', 4));
    const fake = scriptedAdapter((model) => model === 'b9' ? 'held' : 'success');
    const run = runReviews(assignments, prompts, {
      timeoutMs: 60_000, maxRetries: 0, concurrency: 14, adapterFactory: () => fake.adapter,
      quorum: { fraction: 0.95, blocking: blockingLanes },
    });
    await fake.whenHeld(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.aborted).toEqual([]); // 9/10 blocking seats do not meet 0.95
    fake.release('b9', 'success');
    const reviews = await run;
    expect(reviews.every((review) => review.status === 'success')).toBe(true);
    expect(deriveBlockingHealth({ roster, reviews: mergeChunkReviews(reviews), fraction: 0.95 }).policy.minimumSuccessful).toBe(10);
  });

  it('keeps a fraction of 1 as wait-for-all, including unfinished secondary reviewers', async () => {
    const { assignments, prompts, roster, blockingLanes } = council(names('b', 10), names('s', 4));
    const fake = scriptedAdapter((model) => model === 'b10' || model === 's4' ? 'held' : 'success');
    const run = runReviews(assignments, prompts, {
      timeoutMs: 60_000, maxRetries: 0, concurrency: 14, adapterFactory: () => fake.adapter,
      quorum: { fraction: 1, blocking: blockingLanes },
    });
    await fake.whenHeld(2);
    fake.release('b10', 'success');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.aborted).toEqual([]); // every blocking seat is complete; s4 is still awaited
    fake.release('s4', 'success');
    const reviews = await run;
    expect(reviews.every((review) => review.status === 'success')).toBe(true);
    expect(deriveBlockingHealth({ roster, reviews: mergeChunkReviews(reviews), fraction: 1 }).conclusive).toBe(true);
  });

  it('keeps the historical all-call quorum when no lane matrix is supplied', async () => {
    const { assignments, prompts } = council(names('b', 2), ['s1']);
    const fake = scriptedAdapter((model) => model === 'b2' ? 'held' : 'success');
    const reviews = await runReviews(assignments, prompts, {
      timeoutMs: 60_000, maxRetries: 0, concurrency: 3, adapterFactory: () => fake.adapter, quorum: {},
    });
    expect(reviews.map((review) => review.status)).toEqual(['success', 'canceled', 'success']);
  });

  it('refuses a malformed or inconsistent lane matrix before dispatch', async () => {
    const { assignments, prompts } = council(['b1', 'b2'], [], 2);
    const fake = scriptedAdapter(() => 'success');
    const options = { timeoutMs: 1_000, maxRetries: 0, concurrency: 2, adapterFactory: () => fake.adapter };
    await expect(runReviews(assignments, prompts, { ...options, quorum: { blocking: [true] } })).rejects.toThrow(/Invalid blocking lane matrix/);
    await expect(runReviews(assignments, prompts, { ...options, quorum: { blocking: [true, true, false, true] } }))
      .rejects.toThrow(/Inconsistent original seat lane/);
  });

  it('retained fraction 1 closes at the original blocking minimum without waiting for secondary work', async () => {
    const { assignments, prompts } = council(['b1', 'b2'], ['s1']);
    const fake = scriptedAdapter(model => model === 'b2' || model === 's1' ? 'held' : 'success');
    const run = runReviews(assignments, prompts, {
      timeoutMs: 60_000, maxRetries: 0, concurrency: 3, adapterFactory: () => fake.adapter,
      seatIds: ['original-b1', 'original-b2', 'original-s1'],
      quorum: { fraction: 1, blockingSeatIds: ['original-b1', 'original-b2'] },
    });
    await fake.whenHeld(2);
    fake.release('b2', 'success');
    const reviews = await run;
    expect(reviews.map(review => review.status)).toEqual(['success', 'success', 'canceled']);
    expect(fake.aborted).toEqual(['s1']);
  });

  it('retained fraction 1 starts no calls when the original blocking minimum is already complete', async () => {
    const { assignments, prompts } = council(['b1', 'b2'], ['s1']);
    const seatIds = ['original-b1', 'original-b2', 'original-s1'];
    const retainedReviews = [0, 1].map(callIndex => ({ callIndex,
      callIdentity: reviewCallIdentity(assignments[callIndex]!, prompts[callIndex]!, callIndex, seatIds[callIndex]),
      review: { model: assignments[callIndex]!.model, role: 'general', provider: 'fake', findings: [],
        durationMs: 1, status: 'success' as const },
    }));
    let providers = 0;
    const reviews = await runReviews(assignments, prompts, {
      timeoutMs: 1_000, maxRetries: 0, concurrency: 3,
      adapterFactory: () => { providers++; return scriptedAdapter(() => 'success').adapter; },
      seatIds, retainedReviews, quorum: { fraction: 1, blockingSeatIds: seatIds.slice(0, 2) },
    });
    expect(providers).toBe(0);
    expect(reviews.slice(0, 2)).toEqual(retainedReviews.map(entry => entry.review));
    expect(reviews[2]!.status).toBe('canceled');
  });

  it('refuses ambiguous lane authorities and non-boolean lanes before constructing a provider', async () => {
    const { assignments, prompts } = council(['b1', 'b2'], []);
    let providers = 0;
    const options = { timeoutMs: 1_000, maxRetries: 0, concurrency: 2,
      adapterFactory: () => { providers++; return scriptedAdapter(() => 'success').adapter; },
      seatIds: ['original-b1', 'original-b2'],
    };
    await expect(runReviews(assignments, prompts, { ...options,
      quorum: { blocking: [true, true], blockingSeatIds: options.seatIds },
    })).rejects.toThrow(/Ambiguous blocking lane authority/);
    await expect(runReviews(assignments, prompts, { ...options,
      quorum: { blocking: [true, 'secondary' as unknown as boolean] },
    })).rejects.toThrow(/Invalid blocking lane matrix/);
    expect(providers).toBe(0);
  });

});
