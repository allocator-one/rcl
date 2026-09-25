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

  it('preserves the exact disabled result without a mutable side channel', async () => {
    const disabled = { reason: 'reviews_disabled' as const, message: 'Review evidence is disabled' };
    const outcome = await recoverAttestedDelivery<undefined, typeof disabled>({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
      post: async () => ({ kind: 'disabled', value: disabled }),
      receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'disabled', attempts: 1, recovered: false, value: disabled });
    if (outcome.kind !== 'disabled') throw new Error(`expected disabled, got ${outcome.kind}`);
    expect(outcome.value).toBe(disabled);
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

  it.each([
    ['receipt probe', {
      receiptFirst: true,
      initialAttempts: 1,
      post: async () => ({ kind: 'unavailable' as const }),
      receipt: async () => { throw new Error('credential=secret'); },
      attempts: 1,
    }],
    ['replay post', {
      receiptFirst: false,
      initialAttempts: 0,
      post: async () => { throw new Error('credential=secret'); },
      receipt: async () => ({ kind: 'absent' as const }),
      attempts: 1,
    }],
  ] as const)('reports a rejected %s as an accurate bounded operation failure', async (_label, options) => {
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
      receiptFirst: options.receiptFirst, initialAttempts: options.initialAttempts,
      post: options.post, receipt: options.receipt, sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'operation_failed', attempts: options.attempts, recovered: false });
    expect(JSON.stringify(outcome)).not.toContain('credential=secret');
  });

  it('keeps an unrelated callback failure when cancellation races the operation', async () => {
    const controller = new AbortController();
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, signal: controller.signal,
      post: async () => {
        controller.abort(new Error('concurrent cancellation'));
        throw new TypeError('transport decoder failed');
      },
      receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });

    expect(outcome).toEqual({ kind: 'operation_failed', attempts: 1, recovered: false });
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

  it.each(['cancelled', 'expired', 'deadline_exceeded'] as const)('stops during retry backoff when %s', async (expected) => {
    const controller = new AbortController(); let epoch = NOW; let elapsed = 0; let posts = 0;
    const outcome = await recoverAttestedDelivery({ runId: 'run-1', payload: 'immutable', expiresAt: new Date(NOW + (expected === 'deadline_exceeded' ? 100 : 10)).toISOString(), now: () => epoch, monotonicNow: () => elapsed, deadlineMs: 10, signal: controller.signal,
      post: async () => { posts++; return { kind: 'unavailable' }; }, receipt: async () => ({ kind: 'absent' }),
      sleep: async () => { if (expected === 'cancelled') controller.abort(); if (expected === 'expired') epoch += 10; if (expected === 'deadline_exceeded') elapsed += 10; },
    });
    expect(outcome).toMatchObject({ kind: expected, attempts: 1 }); expect(posts).toBe(1);
  });

  it('does not allow callers to raise the attested delivery attempt or deadline ceilings', async () => {
    let posts = 0;
    const attempts = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, maxAttempts: 99,
      post: async () => { posts++; return { kind: 'unavailable' }; }, receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });

    expect(attempts).toEqual({ kind: 'attempts_exhausted', attempts: 3, recovered: false });
    expect(posts).toBe(3);

    let elapsed = 0;
    const deadline = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
      monotonicNow: () => elapsed, deadlineMs: 99_000,
      post: async () => { elapsed += 20_000; return { kind: 'unavailable' }; }, receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });

    expect(deadline).toEqual({ kind: 'deadline_exceeded', attempts: 1, recovered: false });
  });

  it.each([
    ['maxAttempts', { maxAttempts: 0 }],
    ['deadlineMs', { deadlineMs: Number.NaN }],
    ['initialAttempts', { initialAttempts: -1 }],
  ] as const)('fails fast for an invalid %s override', async (_field, override) => {
    const post = vi.fn(async () => ({ kind: 'recorded' as const }));
    const receipt = vi.fn(async () => ({ kind: 'absent' as const }));

    await expect(recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW,
      ...override, post, receipt, sleep: async () => {},
    })).rejects.toThrow(RangeError);
    expect(post).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
  });

  it('preserves a recorded post that completes at credential expiry', async () => {
    let now = NOW;
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: new Date(NOW + 1).toISOString(), now: () => now,
      post: async () => { now = NOW + 1; return { kind: 'recorded' }; }, receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: 'recorded', attempts: 1, recovered: false });
  });

  it('preserves a recorded post that completes at the monotonic deadline', async () => {
    let elapsed = 0;
    const outcome = await recoverAttestedDelivery({
      runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, monotonicNow: () => elapsed, deadlineMs: 1,
      post: async () => { elapsed = 1; return { kind: 'recorded' }; }, receipt: async () => ({ kind: 'absent' }), sleep: async () => {},
    });
    expect(outcome).toEqual({ kind: 'recorded', attempts: 1, recovered: false });
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
  it('rejects an invalid credential expiry before issuing a request', async () => {
    await expect(recoverAttestedDelivery({ runId: 'run-1', payload: 'immutable', expiresAt: '', post: async () => ({ kind: 'recorded' }), receipt: async () => ({ kind: 'absent' }) })).rejects.toThrow('expiresAt must be a valid ISO timestamp');
  });

  it.each(['2026-02-30T12:00:00.000Z', '2026-09-23T12:00:00Z', '2026-09-23'])('rejects a noncanonical attested expiry %s before issuing a request', async (expiresAt) => {
    const post = vi.fn(async () => ({ kind: 'recorded' as const }));
    await expect(recoverAttestedDelivery({ runId: 'run-1', payload: 'immutable', expiresAt, post, receipt: async () => ({ kind: 'absent' }) })).rejects.toThrow('expiresAt must be a valid ISO timestamp');
    expect(post).not.toHaveBeenCalled();
  });

  it('counts the original unavailable post when receiptFirst is enabled without an override', async () => {
    const post = vi.fn(async () => ({ kind: 'recorded' as const }));
    const outcome = await recoverAttestedDelivery({ runId: 'run-1', payload: 'immutable', expiresAt: FUTURE, now: () => NOW, receiptFirst: true, post, receipt: async () => ({ kind: 'absent' }) });
    expect(outcome).toEqual({ kind: 'recorded', attempts: 2, recovered: true });
  });

});
