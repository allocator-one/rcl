import { describe, it, expect, vi, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AnthropicAdapter } from '../../src/dispatch/anthropic.js';
import { OpenAIAdapter } from '../../src/dispatch/openai.js';
import { OpenAICompatAdapter } from '../../src/dispatch/openai-compat.js';
import { GoogleAdapter } from '../../src/dispatch/google.js';

const OPTS = { timeoutMs: 5000, maxRetries: 0 };

const EMPTY_FINDINGS_JSON = '{"findings":[]}';

function anthropicToolResponse(stopReason = 'tool_use') {
  return {
    content: [
      { type: 'tool_use', name: 'report_findings', input: { findings: [] } },
    ],
    stop_reason: stopReason,
  };
}

function openaiResponse(finishReason = 'stop') {
  return {
    choices: [
      { message: { content: EMPTY_FINDINGS_JSON }, finish_reason: finishReason },
    ],
  };
}

function googleResponse(finishReason = 'STOP') {
  return {
    text: EMPTY_FINDINGS_JSON,
    candidates: [{ finishReason }],
  };
}

function setClient(adapter: object, client: unknown): void {
  (adapter as { client: unknown }).client = client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SDK client construction', () => {
  it('anthropic client owns no internal retries', () => {
    const adapter = new AnthropicAdapter('test-key');
    expect((adapter as unknown as { client: Anthropic }).client.maxRetries).toBe(0);
  });

  it('openai client owns no internal retries', () => {
    const adapter = new OpenAIAdapter('test-key');
    expect((adapter as unknown as { client: OpenAI }).client.maxRetries).toBe(0);
  });

  it('openai-compat client owns no internal retries', () => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key' });
    expect((adapter as unknown as { client: OpenAI }).client.maxRetries).toBe(0);
  });
});

describe('timeout classification', () => {
  it('anthropic: SDK abort error is classified as timeout', async () => {
    vi.useFakeTimers();
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        create: (_params: unknown, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(new Anthropic.APIUserAbortError())
            );
          }),
      },
    });

    const pending = adapter.review('claude-opus-4-8', 'general', 's', 'u', {
      timeoutMs: 50,
      maxRetries: 0,
    });
    await vi.advanceTimersByTimeAsync(60);
    const review = await pending;
    expect(review.status).toBe('timeout');
  });

  it('openai: SDK abort error is classified as timeout', async () => {
    vi.useFakeTimers();
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: {
        completions: {
          create: (_params: unknown, opts: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              opts.signal.addEventListener('abort', () =>
                reject(new OpenAI.APIUserAbortError())
              );
            }),
        },
      },
    });

    const pending = adapter.review('gpt-5.5', 'general', 's', 'u', {
      timeoutMs: 50,
      maxRetries: 0,
    });
    await vi.advanceTimersByTimeAsync(60);
    const review = await pending;
    expect(review.status).toBe('timeout');
  });

  it('openai-compat: SDK abort error is classified as timeout', async () => {
    vi.useFakeTimers();
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key' });
    setClient(adapter, {
      chat: {
        completions: {
          create: (_params: unknown, opts: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              opts.signal.addEventListener('abort', () =>
                reject(new OpenAI.APIUserAbortError())
              );
            }),
        },
      },
    });

    const pending = adapter.review('openai-compat/llama3.2', 'general', 's', 'u', {
      timeoutMs: 50,
      maxRetries: 0,
    });
    await vi.advanceTimersByTimeAsync(60);
    const review = await pending;
    expect(review.status).toBe('timeout');
  });

  it('google: timeout aborts the request via abortSignal and is classified as timeout', async () => {
    vi.useFakeTimers();
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: {
        generateContent: (params: { config: { abortSignal?: AbortSignal } }) =>
          new Promise((_resolve, reject) => {
            expect(params.config.abortSignal).toBeInstanceOf(AbortSignal);
            params.config.abortSignal?.addEventListener('abort', () =>
              reject(new Error('Request aborted'))
            );
          }),
      },
    });

    const pending = adapter.review('gemini-2.5-pro', 'general', 's', 'u', {
      timeoutMs: 50,
      maxRetries: 0,
    });
    await vi.advanceTimersByTimeAsync(60);
    const review = await pending;
    expect(review.status).toBe('timeout');
  });
});

describe('google timer hygiene', () => {
  it('leaves no pending timers after a successful review', async () => {
    vi.useFakeTimers();
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: { generateContent: () => Promise.resolve(googleResponse()) },
    });

    const review = await adapter.review('gemini-2.5-pro', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('success');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('truncation detection', () => {
  it('anthropic: stop_reason max_tokens is an error, not an empty success', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        create: () => Promise.resolve(anthropicToolResponse('max_tokens')),
      },
    });

    const review = await adapter.review('claude-opus-4-8', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/truncat/i);
    expect(review.findings).toEqual([]);
  });

  it('openai: finish_reason length is an error, not an empty success', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: {
        completions: { create: () => Promise.resolve(openaiResponse('length')) },
      },
    });

    const review = await adapter.review('gpt-5.5', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/truncat/i);
  });

  it('openai-compat: finish_reason length is an error, not an empty success', async () => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key' });
    setClient(adapter, {
      chat: {
        completions: { create: () => Promise.resolve(openaiResponse('length')) },
      },
    });

    const review = await adapter.review('llama3.2', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/truncat/i);
  });

  it('google: finishReason MAX_TOKENS is an error, not an empty success', async () => {
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: {
        generateContent: () => Promise.resolve(googleResponse('MAX_TOKENS')),
      },
    });

    const review = await adapter.review('gemini-2.5-pro', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/truncat/i);
  });
});

describe('retry behavior', () => {
  it('anthropic: retries a 529 overloaded error and succeeds', async () => {
    vi.useFakeTimers();
    const adapter = new AnthropicAdapter('test-key');
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new Anthropic.APIError(529, undefined, 'Overloaded', undefined)
      )
      .mockResolvedValueOnce(anthropicToolResponse());
    setClient(adapter, { messages: { create } });

    const pending = adapter.review('claude-opus-4-8', 'general', 's', 'u', {
      timeoutMs: 60000,
      maxRetries: 2,
    });
    await vi.advanceTimersByTimeAsync(1100);
    const review = await pending;
    expect(review.status).toBe('success');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('openai: retries a 502 bad gateway error and succeeds', async () => {
    vi.useFakeTimers();
    const adapter = new OpenAIAdapter('test-key');
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new OpenAI.APIError(502, undefined, 'Bad gateway', undefined)
      )
      .mockResolvedValueOnce(openaiResponse());
    setClient(adapter, { chat: { completions: { create } } });

    const pending = adapter.review('gpt-5.5', 'general', 's', 'u', {
      timeoutMs: 60000,
      maxRetries: 2,
    });
    await vi.advanceTimersByTimeAsync(1100);
    const review = await pending;
    expect(review.status).toBe('success');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('anthropic: does not retry a 401', async () => {
    const adapter = new AnthropicAdapter('test-key');
    const create = vi
      .fn()
      .mockRejectedValue(
        new Anthropic.APIError(401, undefined, 'Unauthorized', undefined)
      );
    setClient(adapter, { messages: { create } });

    const review = await adapter.review('claude-opus-4-8', 'general', 's', 'u', {
      timeoutMs: 60000,
      maxRetries: 3,
    });
    expect(review.status).toBe('error');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('openai-compat request parameters', () => {
  it('strips the openai-compat/ prefix and uses the full token budget', async () => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key' });
    let captured: { model?: string; max_tokens?: number } = {};
    let capturedOpts: { timeout?: number } = {};
    setClient(adapter, {
      chat: {
        completions: {
          create: (params: { model: string; max_tokens: number }, opts: { timeout?: number }) => {
            captured = params;
            capturedOpts = opts;
            return Promise.resolve(openaiResponse());
          },
        },
      },
    });

    const review = await adapter.review(
      'openai-compat/llama3.2',
      'general',
      's',
      'u',
      OPTS
    );
    expect(review.status).toBe('success');
    expect(captured.model).toBe('llama3.2');
    expect(captured.max_tokens).toBe(16384);
    // The SDK request timeout must sit above the adapter's own timeout so the
    // AbortController owns timeout classification (SDK default is 600s and
    // would otherwise tie or undercut large configured timeouts).
    expect(capturedOpts.timeout).toBe(OPTS.timeoutMs + 30_000);
  });

  it('passes reasoning effort through when configured, omits it otherwise', async () => {
    const withEffort = new OpenAICompatAdapter({ apiKey: 'k', reasoningEffort: 'medium' });
    const without = new OpenAICompatAdapter({ apiKey: 'k' });
    for (const [adapter, expected] of [
      [withEffort, { effort: 'medium' }],
      [without, undefined],
    ] as const) {
      let captured: Record<string, unknown> = {};
      setClient(adapter, {
        chat: {
          completions: {
            create: (params: Record<string, unknown>) => {
              captured = params;
              return Promise.resolve(openaiResponse());
            },
          },
        },
      });
      await adapter.review('m', 'general', 's', 'u', OPTS);
      expect(captured['reasoning']).toEqual(expected);
    }
  });

  it('openrouter: strips only the openrouter/ prefix and reports the openrouter provider', async () => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key', provider: 'openrouter' });
    let captured: { model?: string } = {};
    setClient(adapter, {
      chat: {
        completions: {
          create: (params: { model: string }) => {
            captured = params;
            return Promise.resolve(openaiResponse());
          },
        },
      },
    });

    const review = await adapter.review(
      'openrouter/moonshotai/kimi-k3',
      'general',
      's',
      'u',
      OPTS
    );
    expect(review.status).toBe('success');
    expect(review.provider).toBe('openrouter');
    expect(captured.model).toBe('moonshotai/kimi-k3');
  });
});

// A provider that declines does so IN-BAND: HTTP 200, no content. Recording
// that as a clean review is the dangerous failure mode — the run reports a
// green check for code nobody looked at, `successfulReviews` keeps the CI
// "nothing was reviewed" guard quiet, and consensus counts the refuser as a
// relevant reviewer that found nothing (RCL-13).
describe('refusal detection', () => {
  it('anthropic: stop_reason refusal is an error carrying the category', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        create: () =>
          Promise.resolve({
            content: [],
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: 'blocked' },
          }),
      },
    });

    const review = await adapter.review('claude-fable-5', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/refused/i);
    expect(review.error).toMatch(/cyber/);
    expect(review.findings).toEqual([]);
  });

  it('anthropic: a refusal without stop_details still errors', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: { create: () => Promise.resolve({ content: [], stop_reason: 'refusal' }) },
    });

    const review = await adapter.review('claude-fable-5', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/refused/i);
  });

  it('openai: finish_reason content_filter is an error', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: {
        completions: {
          create: () =>
            Promise.resolve({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
        },
      },
    });

    const review = await adapter.review('gpt-5.6-sol', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/refused/i);
  });

  it('openai-compat: OpenRouter surfaces an upstream refusal on message.refusal', async () => {
    // The shape observed from openrouter/anthropic/claude-fable-5 on a diff
    // containing a SQL injection: content_filter + the provider's explanation.
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key', provider: 'openrouter' });
    setClient(adapter, {
      chat: {
        completions: {
          create: () =>
            Promise.resolve({
              choices: [
                {
                  message: { content: '', refusal: 'blocked under the Usage Policy' },
                  finish_reason: 'content_filter',
                },
              ],
            }),
        },
      },
    });

    const review = await adapter.review('openrouter/anthropic/claude-fable-5', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/refused/i);
    expect(review.error).toMatch(/Usage Policy/);
  });

  it('google: a SAFETY finish reason is an error', async () => {
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: {
        generateContent: () => Promise.resolve({ text: '', candidates: [{ finishReason: 'SAFETY' }] }),
      },
    });

    const review = await adapter.review('gemini-3.6-flash', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/refused/i);
    expect(review.error).toMatch(/SAFETY/);
  });
});

// The backstop: whatever the provider's reason, a 200 with no body reviewed
// nothing. This catches refusal shapes not yet enumerated.
describe('empty output is a failed review, not a clean one', () => {
  it('anthropic', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: { create: () => Promise.resolve({ content: [], stop_reason: 'end_turn' }) },
    });

    const review = await adapter.review('claude-fable-5', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/empty response/i);
  });

  it('openai', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: {
        completions: {
          create: () => Promise.resolve({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
        },
      },
    });

    const review = await adapter.review('gpt-5.6-sol', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/empty response/i);
  });

  it('openai-compat', async () => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key', provider: 'openrouter' });
    setClient(adapter, {
      chat: {
        completions: {
          create: () => Promise.resolve({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }),
        },
      },
    });

    const review = await adapter.review('openrouter/x/y', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/empty response/i);
  });

  it('google', async () => {
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: { generateContent: () => Promise.resolve({ text: '', candidates: [{ finishReason: 'STOP' }] }) },
    });

    const review = await adapter.review('gemini-3.6-flash', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.error).toMatch(/empty response/i);
  });

  it('a genuinely clean review — findings: [] with a real body — still succeeds', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: { completions: { create: () => Promise.resolve(openaiResponse()) } },
    });

    const review = await adapter.review('gpt-5.6-sol', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('success');
    expect(review.findings).toEqual([]);
  });
});
