import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortSignalWithTimeout } from '../../src/telemetry/abort-signal.js';

describe('abortSignalWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('preserves the reason of a parent that is already aborted', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const reason = new Error('parent stopped');
    parent.abort(reason);

    const lease = abortSignalWithTimeout(parent.signal, 1_000);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes the exact parent callback once when dispose is called repeatedly', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, 'addEventListener');
    const remove = vi.spyOn(parent.signal, 'removeEventListener');
    const lease = abortSignalWithTimeout(parent.signal, 1_000);
    const callback = add.mock.calls.find(([type]) => type === 'abort')?.[1];

    lease.dispose();
    lease.dispose();

    expect(callback).toBeTypeOf('function');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', callback);
    expect(vi.getTimerCount()).toBe(0);
  });


  it('aborts with TimeoutError when the lease expires', () => {
    vi.useFakeTimers();
    const lease = abortSignalWithTimeout(undefined, 1_000);

    vi.advanceTimersByTime(1_000);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBeInstanceOf(DOMException);
    expect((lease.signal.reason as DOMException).name).toBe('TimeoutError');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a parent abort after creation and releases the timer', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const lease = abortSignalWithTimeout(parent.signal, 1_000);
    const reason = new Error('parent stopped');

    parent.abort(reason);

    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a deadline beyond the native timer range without aborting early', () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const nativeMaximum = 2 ** 31 - 1;
    const lease = abortSignalWithTimeout(undefined, nativeMaximum + 1_000);

    vi.advanceTimersByTime(nativeMaximum);
    expect(lease.signal.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(lease.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays active after disposal even when its former timeout and parent fire', () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const lease = abortSignalWithTimeout(parent.signal, 10);

    lease.dispose();
    vi.advanceTimersByTime(10);
    parent.abort(new Error('too late'));

    expect(lease.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
