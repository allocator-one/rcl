import { describe, it, expect, vi } from 'vitest';
import {
  attemptWithRetries,
  isRetryableStatus,
  sleep,
  stripKnownProviderPrefix,
} from '../../src/dispatch/utils.js';

describe('stripKnownProviderPrefix', () => {
  it('strips anthropic/ prefix', () => {
    expect(stripKnownProviderPrefix('anthropic/claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('returns model unchanged when no prefix', () => {
    expect(stripKnownProviderPrefix('claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('strips openai/ prefix', () => {
    expect(stripKnownProviderPrefix('openai/gpt-5.4')).toBe('gpt-5.4');
  });

  it('strips google/ prefix', () => {
    expect(stripKnownProviderPrefix('google/gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  it('preserves unknown provider prefix', () => {
    expect(stripKnownProviderPrefix('unknown/model')).toBe('unknown/model');
  });

  it('preserves multi-segment path that is not a known provider', () => {
    expect(stripKnownProviderPrefix('org/sub/model')).toBe('org/sub/model');
  });

  it('returns empty string unchanged', () => {
    expect(stripKnownProviderPrefix('')).toBe('');
  });

  it('strips anthropic/ prefix leaving empty string', () => {
    expect(stripKnownProviderPrefix('anthropic/')).toBe('');
  });

  it('strips openai-compat/ prefix', () => {
    expect(stripKnownProviderPrefix('openai-compat/llama3.2')).toBe('llama3.2');
  });

  it('strips openrouter/ prefix but keeps the vendor segment', () => {
    expect(stripKnownProviderPrefix('openrouter/moonshotai/kimi-k3')).toBe('moonshotai/kimi-k3');
  });
});

describe('isRetryableStatus', () => {
  it.each([429, 500, 502, 503, 504, 529])('retries %i', (status) => {
    expect(isRetryableStatus(status)).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('does not retry %i', (status) => {
    expect(isRetryableStatus(status)).toBe(false);
  });

  it('does not retry undefined status', () => {
    expect(isRetryableStatus(undefined)).toBe(false);
  });
});


describe('attemptWithRetries external cancellation', () => {
  it('does not retry a pre-aborted external signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn(async () => {
      throw new Error('retryable');
    });

    const outcome = await attemptWithRetries({
      timeoutMs: 1_000,
      maxRetries: 3,
      signal: controller.signal,
      isRetryable: () => true,
      attempt,
    });

    expect(attempt).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, timedOut: false, error: 'Request cancelled' });
  });

  it('does not retry after an external abort during a retryable failure', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort();
      throw new Error('retryable');
    });

    const outcome = await attemptWithRetries({
      timeoutMs: 1_000,
      maxRetries: 3,
      signal: controller.signal,
      isRetryable: () => true,
      attempt,
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: false, timedOut: false, error: 'Request cancelled' });
  });

  it('discards a successful result returned after external cancellation', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort();
      return 'stale result';
    });

    const outcome = await attemptWithRetries({
      timeoutMs: 1_000,
      maxRetries: 0,
      signal: controller.signal,
      isRetryable: () => false,
      attempt,
    });

    expect(outcome).toEqual({ ok: false, timedOut: false, error: 'Request cancelled' });
  });

  it('keeps timeout classification when external cancellation arrives later', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const outcomePromise = attemptWithRetries({
        timeoutMs: 100,
        maxRetries: 0,
        signal: controller.signal,
        isRetryable: () => false,
        attempt: async () => {
          await sleep(200);
          throw new Error('late provider rejection');
        },
      });

      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);

      await expect(outcomePromise).resolves.toEqual({
        ok: false,
        timedOut: true,
        error: 'Request timed out',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles external cancellation when an attempt ignores the signal', async () => {
    const controller = new AbortController();
    const outcomePromise = attemptWithRetries({
      timeoutMs: 10_000,
      maxRetries: 0,
      signal: controller.signal,
      isRetryable: () => false,
      attempt: async () => new Promise<string>(() => {}),
    });

    controller.abort();

    await expect(outcomePromise).resolves.toEqual({
      ok: false,
      timedOut: false,
      error: 'Request cancelled',
    });
  });

  it('settles an internal timeout when an attempt ignores the signal', async () => {
    vi.useFakeTimers();
    try {
      const outcomePromise = attemptWithRetries({
        timeoutMs: 100,
        maxRetries: 0,
        isRetryable: () => false,
        attempt: async () => new Promise<string>(() => {}),
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(outcomePromise).resolves.toEqual({
        ok: false,
        timedOut: true,
        error: 'Request timed out',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a retry delay without starting another attempt', async () => {
    const controller = new AbortController();
    let retryableChecked!: () => void;
    const retryableWasChecked = new Promise<void>((resolve) => {
      retryableChecked = resolve;
    });
    const attempt = vi.fn(async () => {
      throw new Error('retryable');
    });
    const outcomePromise = attemptWithRetries({
      timeoutMs: 10_000,
      maxRetries: 3,
      signal: controller.signal,
      isRetryable: () => {
        retryableChecked();
        return true;
      },
      attempt,
    });

    await retryableWasChecked;
    controller.abort();

    await expect(outcomePromise).resolves.toEqual({
      ok: false,
      timedOut: false,
      error: 'Request cancelled',
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
