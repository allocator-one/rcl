import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ApiError } from '@google/genai';
import { AnthropicAdapter } from '../../src/dispatch/anthropic.js';
import { OpenAIAdapter } from '../../src/dispatch/openai.js';
import { OpenAICompatAdapter } from '../../src/dispatch/openai-compat.js';
import { GoogleAdapter } from '../../src/dispatch/google.js';
import type { AdapterOptions, ReviewAdapter } from '../../src/dispatch/adapter.js';

const providers = ['google', 'openai', 'openai-compat', 'anthropic'] as const;
type Provider = typeof providers[number];
const methods = ['review', 'ask'] as const;
const options: AdapterOptions = { timeoutMs: 20_000, maxRetries: 2 };
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  network = vi.fn(() => { throw new Error('External network forbidden'); });
  vi.stubGlobal('fetch', network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

function fixture(provider: Provider) {
  const adapter: ReviewAdapter = provider === 'google' ? new GoogleAdapter('synthetic')
    : provider === 'anthropic' ? new AnthropicAdapter('synthetic')
      : provider === 'openai' ? new OpenAIAdapter('synthetic') : new OpenAICompatAdapter({ apiKey: 'synthetic' });
  const response = provider === 'google' ? { text: '{"findings":[]}', candidates: [{ finishReason: 'STOP' }] }
    : provider === 'anthropic' ? { content: [{ type: 'text', text: '{"findings":[]}' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }] };
  const request = vi.fn().mockResolvedValue(response);
  Object.assign(adapter, { client: provider === 'google' ? { models: { generateContent: request } }
    : provider === 'anthropic' ? { messages: { create: request } } : { chat: { completions: { create: request } } } });
  const invoke = (method: typeof methods[number], opts = options) => method === 'review'
    ? adapter.review(`${provider}/fixture`, 'general', 's', 'u', opts)
    : adapter.ask(`${provider}/fixture`, 's', 'u', opts);
  return { request, invoke };
}

function transport(provider: Provider, code = 'UND_ERR_CONNECT_TIMEOUT'): Error {
  const cause = new TypeError('fetch failed', { cause: Object.assign(new Error('Transport failure'), { code }) });
  return provider === 'google' ? cause : provider === 'anthropic'
    ? new Anthropic.APIConnectionError({ cause }) : new OpenAI.APIConnectionError({ cause });
}

for (const provider of providers) describe(`${provider} bounded transport retries`, () => {
  for (const method of methods) {
    it(`${method} retries a transient failure and reports observed SDK invocations`, async () => {
      const { request, invoke } = fixture(provider);
      // Exercise the exact statusless OpenAI timeout from RCL126 as well as
      // Google's fetch-failed cause and the analogous adapters.
      request.mockRejectedValueOnce(provider === 'openai' ? new OpenAI.APIConnectionTimeoutError() : transport(provider));
      const pending = invoke(method);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await pending).toMatchObject({ status: 'success', adapterAttempts: 2 });
      expect(request).toHaveBeenCalledTimes(2);
    });

    it(`${method} stops at the configured attempt budget without inventing success`, async () => {
      const { request, invoke } = fixture(provider);
      request.mockRejectedValue(transport(provider));
      const pending = invoke(method);
      await vi.advanceTimersByTimeAsync(3_001);
      expect(await pending).toMatchObject({ status: 'error', adapterAttempts: 3 });
      expect(request).toHaveBeenCalledTimes(3);
    });

    it(`${method} makes no SDK call for a pre-canceled parent`, async () => {
      const { request, invoke } = fixture(provider);
      const controller = new AbortController(); controller.abort();
      const result = await invoke(method, { ...options, signal: controller.signal });
      expect(result).toMatchObject({ status: 'error', error: 'Request cancelled', adapterAttempts: 0 });
      expect(request).not.toHaveBeenCalled();
    });

    it(`${method} makes no SDK call when its overall deadline has already expired`, async () => {
      const { request, invoke } = fixture(provider);
      const result = await invoke(method, { ...options, timeoutMs: 0 });
      expect(result).toMatchObject({ status: 'timeout', error: 'Request timed out', adapterAttempts: 0 });
      expect(request).not.toHaveBeenCalled();
    });

    it(`${method} cancels promptly during retry backoff without another SDK call`, async () => {
      const { request, invoke } = fixture(provider);
      const controller = new AbortController();
      request.mockRejectedValue(transport(provider));
      let finished = false;
      const pending = invoke(method, { ...options, signal: controller.signal }).then(result => { finished = true; return result; });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(true);
      expect(await pending).toMatchObject({ status: 'error', error: 'Request cancelled', adapterAttempts: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it(`${method} keeps all retries inside one overall deadline`, async () => {
      const { request, invoke } = fixture(provider);
      request.mockRejectedValue(transport(provider));
      let finished = false;
      const pending = invoke(method, { ...options, timeoutMs: 500 }).then(result => { finished = true; return result; });
      await vi.advanceTimersByTimeAsync(501);
      expect(finished).toBe(true);
      expect(await pending).toMatchObject({ status: 'timeout', error: 'Request timed out', adapterAttempts: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['permanent TLS failure', () => transport(provider, 'CERT_HAS_EXPIRED')],
      ['configuration error containing a status number', () => new TypeError('503 is an invalid synthetic configuration value')],
    ])(`${method} does not retry %s`, async (_name, failure) => {
      const { request, invoke } = fixture(provider);
      request.mockRejectedValue(failure());
      const pending = invoke(method);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ status: 'error', adapterAttempts: 1 });
      expect(request).toHaveBeenCalledTimes(1);
    });
  }

  it('still retries a real HTTP 503 error', async () => {
    const { request, invoke } = fixture(provider);
    request.mockRejectedValueOnce(provider === 'google' ? new ApiError({ status: 503, message: 'Unavailable' })
      : provider === 'anthropic' ? new Anthropic.APIError(503, undefined, 'Unavailable', undefined)
        : new OpenAI.APIError(503, undefined, 'Unavailable', undefined));
    const pending = invoke('review');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await pending).toMatchObject({ status: 'success', adapterAttempts: 2 });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('Google ApiError retry boundaries', () => {
  it.each(methods)('%s retries a real HTTP 429 response', async method => {
    const { request, invoke } = fixture('google');
    request.mockRejectedValueOnce(new ApiError({ status: 429, message: 'RESOURCE_EXHAUSTED' }));

    const pending = invoke(method);
    await vi.advanceTimersByTimeAsync(1_001);

    expect(await pending).toMatchObject({ status: 'success', adapterAttempts: 2 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([400, 403])('does not retry HTTP %i with RESOURCE_EXHAUSTED only in its message', async status => {
    const { request, invoke } = fixture('google');
    request.mockRejectedValue(new ApiError({ status, message: 'RESOURCE_EXHAUSTED' }));

    const pending = invoke('review');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toMatchObject({ status: 'error', adapterAttempts: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it('keeps a permanent Anthropic streaming connection failure terminal', async () => {
  const adapter = new AnthropicAdapter('synthetic');
  const stream = vi.fn().mockReturnValue({ finalMessage: vi.fn().mockRejectedValue(transport('anthropic', 'CERT_HAS_EXPIRED')) });
  Object.assign(adapter, { client: { messages: { stream } } });
  const pending = adapter.review('claude-fable-5-1', 'general', 's', 'u', options);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toMatchObject({ status: 'error', adapterAttempts: 1 });
  expect(stream).toHaveBeenCalledTimes(1);
});

it('retries a transient Anthropic streaming connection failure', async () => {
  const adapter = new AnthropicAdapter('synthetic');
  const response = { content: [{ type: 'text', text: '{"findings":[]}' }], stop_reason: 'end_turn' };
  const stream = vi.fn()
    .mockReturnValueOnce({ finalMessage: vi.fn().mockRejectedValue(transport('anthropic')) })
    .mockReturnValue({ finalMessage: vi.fn().mockResolvedValue(response) });
  Object.assign(adapter, { client: { messages: { stream } } });

  const pending = adapter.review('claude-fable-5-1', 'general', 's', 'u', options);
  await vi.advanceTimersByTimeAsync(1_001);

  expect(await pending).toMatchObject({ status: 'success', adapterAttempts: 2 });
  expect(stream).toHaveBeenCalledTimes(2);
});

it('keeps a user-aborted Anthropic streaming request terminal', async () => {
  const adapter = new AnthropicAdapter('synthetic');
  const stream = vi.fn().mockReturnValue({ finalMessage: vi.fn().mockRejectedValue(new Anthropic.APIUserAbortError()) });
  Object.assign(adapter, { client: { messages: { stream } } });

  const pending = adapter.review('claude-fable-5-1', 'general', 's', 'u', options);
  await vi.advanceTimersByTimeAsync(10_000);

  expect(await pending).toMatchObject({ status: 'error', adapterAttempts: 1 });
  expect(stream).toHaveBeenCalledTimes(1);
});
