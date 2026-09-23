import { describe, expect, it, vi } from 'vitest';
import { recoverAttestedDelivery } from '../../src/telemetry/attested-retry.js';

const FUTURE = '2026-09-23T12:10:00.000Z';
const NOW = Date.parse('2026-09-23T12:00:00.000Z');

describe('recoverAttestedDelivery', () => {
  it('reads the own-run receipt before replaying an uncertain post and preserves the exact payload', async () => {
    const posts: string[] = [];
    const reads: string[] = [];
    const payload = '{"run":{"id":"run-1"},"delivery":{"mode":"direct"}}';
    let postCalls = 0;

    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload, expiresAt: FUTURE, now: () => NOW,
      post: async (body) => {
        posts.push(body);
        postCalls++;
        return postCalls === 1 ? { kind: 'unavailable' } : { kind: 'recorded' };
      },
      receipt: async (runId) => {
        reads.push(runId);
        return { kind: 'absent' };
      },
      sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'recorded', attempts: 2, recovered: true });
    expect(reads).toEqual(['run-1']);
    expect(posts).toEqual([payload, payload]);
  });

  it('accepts a matching receipt after a lost acknowledgement without a second post', async () => {
    let posts = 0;
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
      post: async () => { posts++; return { kind: 'unavailable' }; },
      receipt: async () => ({ kind: 'recorded' }), sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'recorded', attempts: 1, recovered: true });
    expect(posts).toBe(1);
  });

  it('keeps the elapsed deadline when the credential clock moves backward', async () => {
    let epoch = NOW;
    let elapsed = 0;
    let posts = 0;
    const receipt = vi.fn(async () => ({ kind: 'absent' as const }));
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE,
      now: () => epoch, monotonicNow: () => elapsed, deadlineMs: 20,
      post: async () => {
        posts++;
        epoch -= 60_000;
        elapsed += 25;
        return posts === 1 ? { kind: 'unavailable' } : { kind: 'recorded' };
      },
      receipt, sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'deadline_exceeded', attempts: 1, recovered: false });
    expect(posts).toBe(1);
    expect(receipt).not.toHaveBeenCalled();
  });

  it('does not expire the elapsed deadline when the credential clock moves forward within its validity', async () => {
    let epoch = NOW;
    let elapsed = 0;
    let posts = 0;
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE,
      now: () => epoch, monotonicNow: () => elapsed, deadlineMs: 20,
      post: async () => {
        posts++;
        epoch += 60_000;
        elapsed++;
        return posts === 1 ? { kind: 'unavailable' } : { kind: 'recorded' };
      },
      receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'recorded', attempts: 2, recovered: true });
  });

  it.each([
    ['conflict', { kind: 'conflict' }],
    ['hard rejection', { kind: 'rejected' }],
  ] as const)('does not retry a %s', async (_label, post) => {
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
      post: async () => post, receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: post.kind, attempts: 1, recovered: false });
  });

  it('refuses a blind retry when the receipt cannot be read', async () => {
    let posts = 0;
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
      post: async () => { posts++; return { kind: 'unavailable' }; },
      receipt: async () => ({ kind: 'unavailable' }), sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'receipt_unavailable', attempts: 1, recovered: false });
    expect(posts).toBe(1);
  });

  it.each([true, false])('reports cancellation when a %s receipt normalizes its abort as unavailable', async (receiptFirst) => {
    const controller = new AbortController();
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, signal: controller.signal, receiptFirst,
      initialAttempts: receiptFirst ? 1 : 0,
      post: async () => ({ kind: 'unavailable' }),
      receipt: async () => { controller.abort(); return { kind: 'unavailable' }; },
      sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'cancelled', attempts: receiptFirst ? 1 : 1, recovered: false });
  });

  it('refuses replay after expiry, cancellation, the deadline, or the finite attempt budget', async () => {
    const expired = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: '2026-09-23T11:59:59.000Z', now: () => NOW,
      post: async () => ({ kind: 'recorded' }), receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });
    expect(expired).toEqual({ kind: 'expired', attempts: 0, recovered: false });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, signal: controller.signal,
      post: async () => ({ kind: 'recorded' }), receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });
    expect(cancelled).toEqual({ kind: 'cancelled', attempts: 0, recovered: false });

    let clock = 0;
    const deadline = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, monotonicNow: () => clock, deadlineMs: 1,
      post: async () => { clock += 1; return { kind: 'unavailable' }; }, receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });
    expect(deadline).toEqual({ kind: 'deadline_exceeded', attempts: 1, recovered: false });

    const budget = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, maxAttempts: 2,
      post: async () => ({ kind: 'unavailable' }), receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });
    expect(budget).toEqual({ kind: 'attempts_exhausted', attempts: 2, recovered: false });
  });

  it('does not start receipt-first or replay transports after a boundary crosses while acquiring its timeout', async () => {
    async function recover(receiptFirst: boolean, boundary: 'expiry' | 'deadline') {
      let ticks = 0;
      const receiptExpired: boolean[] = [];
      const postExpired: boolean[] = [];
      const tick = () => ++ticks >= 4 ? 1 : 0;
      const now = () => NOW + (boundary === 'expiry' ? tick() : 0);
      const monotonicNow = () => boundary === 'deadline' ? tick() : 0;
      const stopped = () => boundary === 'expiry' ? now() >= NOW + 1 : monotonicNow() >= 1;

      const outcome = await recoverAttestedDelivery({
        runId: 'run-1', payload: 'immutable', expiresAt: new Date(boundary === 'expiry' ? NOW + 1 : NOW + 60_000).toISOString(),
        now, monotonicNow, receiptFirst, ...(boundary === 'deadline' ? { deadlineMs: 1 } : {}),
        initialAttempts: receiptFirst ? 1 : 0,
        post: async () => { postExpired.push(stopped()); return { kind: 'recorded' }; },
        receipt: async () => { receiptExpired.push(stopped()); return { kind: 'absent' }; },
        sleep: async () => {},
      });

      return { outcome, receiptExpired, postExpired };
    }

    for (const [boundary, outcome] of [['expiry', 'expired'], ['deadline', 'deadline_exceeded']] as const) {
      await expect(recover(true, boundary)).resolves.toEqual({
        outcome: { kind: outcome, attempts: 1, recovered: false }, receiptExpired: [false], postExpired: [],
      });
      await expect(recover(false, boundary)).resolves.toEqual({
        outcome: { kind: 'recorded', attempts: 1, recovered: false }, receiptExpired: [], postExpired: [false],
      });
    }
  });

  it('aborts an in-flight post at the remaining delivery deadline', async () => {
    let aborted = false;
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, deadlineMs: 1,
      post: async (_payload, signal) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
      }),
      receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'deadline_exceeded', attempts: 1, recovered: false });
    expect(aborted).toBe(true);
  });

  it('propagates parent cancellation into an in-flight retry transport without AbortSignal.any', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    const controller = new AbortController();
    let called = false;

    try {
      Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
      const pending = recoverAttestedDelivery({
        runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
        signal: controller.signal,
        post: async (_payload, signal) => new Promise((resolve, reject) => {
          called = true;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
      });
      setTimeout(() => controller.abort(new Error('fixture cancellation')), 10);

      expect(await pending).toEqual({ kind: 'cancelled', attempts: 1, recovered: false });
      expect(called).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
      else delete (AbortSignal as unknown as Record<string, unknown>)['any'];
    }
  });

  it('aborts the actual retry transport at its deadline without AbortSignal.any and removes the parent listener', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, 'addEventListener');
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    let aborted = false;

    try {
      Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
      const outcome = await recoverAttestedDelivery({
        runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
        signal: parent.signal, deadlineMs: 5,
        post: async (_payload, signal) => new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
        }),
        receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
      });

      expect(outcome).toEqual({ kind: 'deadline_exceeded', attempts: 1, recovered: false });
      expect(aborted).toBe(true);
      expect(add).toHaveBeenCalled();
      expect(remove).toHaveBeenCalled();
    } finally {
      add.mockRestore(); remove.mockRestore();
      if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
      else delete (AbortSignal as unknown as Record<string, unknown>)['any'];
    }
  });
});
