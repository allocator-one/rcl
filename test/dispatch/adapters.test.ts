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

function anthropicStreamResponse(response: unknown) {
  return { finalMessage: vi.fn().mockResolvedValue(response) };
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

describe('anthropic automatic tool choice', () => {
  it('gives Fable 5.1 room to complete a large review with bounded effort', async () => {
    const stream = vi.fn().mockReturnValue(anthropicStreamResponse(anthropicToolResponse()));
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, { messages: { stream } });

    const review = await adapter.review('anthropic/claude-fable-5-1', 'general', 'system', 'large diff', OPTS);

    expect(review.status).toBe('success');
    expect(stream).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        model: 'claude-fable-5-1',
        max_tokens: 32768,
        output_config: { effort: 'medium' },
        tool_choice: { type: 'auto' },
      }),
      expect.any(Object),
    );
  });

  it('keeps the existing output budget for other Claude models', async () => {
    const create = vi.fn().mockResolvedValue(anthropicToolResponse());
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, { messages: { create } });

    const review = await adapter.review('anthropic/claude-opus-4-8', 'general', 'system', 'diff', OPTS);

    expect(review.status).toBe('success');
    expect(create.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 16384 });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('output_config');
  });

  it('reviews with Fable 5.1 without sending unsupported forced tool choice', async () => {
    const stream = vi.fn((params: { tool_choice: { type: string } }) => {
      if (params.tool_choice.type !== 'auto') {
        throw new Anthropic.APIError(400, undefined, 'Forced tool choice is not supported', undefined);
      }
      return anthropicStreamResponse(anthropicToolResponse());
    });
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, { messages: { stream } });

    const review = await adapter.review('anthropic/claude-fable-5-1', 'general', 'system', 'diff', OPTS);

    expect(review.status).toBe('success');
    expect(stream).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        model: 'claude-fable-5-1',
        tool_choice: { type: 'auto' },
        tools: [expect.objectContaining({ name: 'report_findings' })],
      }),
      expect.any(Object),
    );
  });

  it('preserves findings when the model returns text instead of calling the tool', async () => {
    const finding = {
      id: 'finding-1',
      file: 'src/access.ts',
      startLine: 2,
      endLine: 2,
      severity: 'critical',
      category: 'security',
      title: 'Missing authorization',
      description: 'The route exposes protected data without checking access.',
    };
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        stream: vi.fn().mockReturnValue(anthropicStreamResponse({
          content: [
            { type: 'thinking', thinking: 'Check access control.' },
            { type: 'text', text: JSON.stringify({ findings: [finding] }) },
          ],
          stop_reason: 'end_turn',
        })),
      },
    });

    const review = await adapter.review('claude-fable-5-1', 'general', 'system', 'diff', OPTS);

    expect(review.status).toBe('success');
    expect(review.findings).toEqual([expect.objectContaining(finding)]);
  });

  it('does not count thinking without findings output as a successful review', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        stream: vi.fn().mockReturnValue(anthropicStreamResponse({
          content: [{ type: 'thinking', thinking: 'Check access control.' }],
          stop_reason: 'end_turn',
        })),
      },
    });

    const review = await adapter.review('claude-fable-5-1', 'general', 'system', 'diff', OPTS);

    expect(review.status).toBe('error');
    expect(review.error).toContain('empty response');
  });

  it('does not count a truncated Fable stream as a successful review', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        stream: vi.fn().mockReturnValue(anthropicStreamResponse(anthropicToolResponse('max_tokens'))),
      },
    });

    const review = await adapter.review('claude-fable-5-1', 'general', 'system', 'diff', OPTS);

    expect(review.status).toBe('error');
    expect(review.error).toContain('truncated');
    expect(review.findings).toEqual([]);
  });

  it('does not retry a rejected request even when a retry budget remains', async () => {
    const stream = vi.fn().mockReturnValue({
      finalMessage: vi.fn().mockRejectedValue(
        new Anthropic.APIError(400, undefined, 'Invalid request', undefined),
      ),
    });
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, { messages: { stream } });

    const review = await adapter.review('claude-fable-5-1', 'general', 'system', 'diff', {
      ...OPTS,
      maxRetries: 3,
    });

    expect(review.status).toBe('error');
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

describe('timeout classification', () => {
  it('anthropic Fable stream abort is classified as timeout', async () => {
    vi.useFakeTimers();
    const adapter = new AnthropicAdapter('test-key');
    const stream = vi.fn((_params: unknown, opts: { signal: AbortSignal }) => ({
      finalMessage: () =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()));
        }),
    }));
    setClient(adapter, {
      messages: {
        stream,
      },
    });

    const pending = adapter.review('claude-fable-5-1', 'general', 's', 'u', {
      timeoutMs: 50,
      maxRetries: 3,
    });
    await vi.advanceTimersByTimeAsync(60);

    expect((await pending).status).toBe('timeout');
    expect(stream).toHaveBeenCalledTimes(1);
  });

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

describe('google model contract', () => {
  it('forwards the stable Gemini 3.8 Flash model ID without deprecated sampling parameters', async () => {
    const generateContent = vi.fn().mockResolvedValue(googleResponse());
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, { models: { generateContent } });

    const review = await adapter.review(
      'google/gemini-3.8-flash',
      'general',
      'system',
      'user',
      OPTS
    );

    expect(review.status).toBe('success');
    const request = generateContent.mock.calls[0]![0] as {
      model: string;
      config: Record<string, unknown>;
    };
    expect(request.model).toBe('gemini-3.8-flash');
    for (const parameter of [
      'temperature',
      'topP',
      'topK',
      'candidateCount',
      'thinkingBudget',
    ]) {
      expect(request.config).not.toHaveProperty(parameter);
    }
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

// The verification lane reads ask/4's text as a verdict list covering every
// candidate. A truncated answer that arrives as a short success is parsed as
// "no verdicts", which records every candidate unavailable and gates findings
// the verifier was about to refute (RCL-60).
describe('ask cancellation', () => {
  it('anthropic aborts an ask when its caller cancels', async () => {
    const adapter = new AnthropicAdapter('test-key');
    const controller = new AbortController();
    setClient(adapter, {
      messages: {
        create: (_params: unknown, options: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () =>
              reject(new Anthropic.APIUserAbortError())
            );
          }),
      },
    });

    const pending = adapter.ask('claude-opus-4-8', 's', 'u', {
      ...OPTS,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: 'Request cancelled',
    });
  });

  it('openai aborts an ask when its caller cancels', async () => {
    const adapter = new OpenAIAdapter('test-key');
    const controller = new AbortController();
    setClient(adapter, {
      chat: {
        completions: {
          create: (_params: unknown, options: { signal: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () =>
                reject(new OpenAI.APIUserAbortError())
              );
            }),
        },
      },
    });

    const pending = adapter.ask('gpt-5.5', 's', 'u', {
      ...OPTS,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: 'Request cancelled',
    });
  });

  it('google aborts an ask when its caller cancels', async () => {
    const adapter = new GoogleAdapter('test-key');
    const controller = new AbortController();
    setClient(adapter, {
      models: {
        generateContent: (params: { config: { abortSignal: AbortSignal } }) =>
          new Promise((_resolve, reject) => {
            params.config.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      },
    });

    const pending = adapter.ask('gemini-2.5-pro', 's', 'u', { ...OPTS, signal: controller.signal });
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      status: 'error',
      error: 'Request cancelled',
    });
  });
});

describe('ask: truncation is an error, not a short answer', () => {
  it('anthropic: stop_reason max_tokens fails the answer', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        create: () =>
          Promise.resolve({
            content: [{ type: 'text', text: '[{"id":"F1","verdict":"refuted"' }],
            stop_reason: 'max_tokens',
          }),
      },
    });

    const answer = await adapter.ask('claude-opus-4-8', 's', 'u', OPTS);
    expect(answer.status).toBe('error');
    expect(answer.error).toMatch(/truncat/i);
    expect(answer.text).toBe('');
  });

  it('openai: finish_reason length fails the answer', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: {
        completions: {
          create: () =>
            Promise.resolve({
              choices: [{ message: { content: '[{"id":"F1"' }, finish_reason: 'length' }],
            }),
        },
      },
    });

    const answer = await adapter.ask('gpt-5.5', 's', 'u', OPTS);
    expect(answer.status).toBe('error');
    expect(answer.error).toMatch(/truncat/i);
  });

  it('google: finishReason MAX_TOKENS fails the answer', async () => {
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: {
        generateContent: () => Promise.resolve({ text: '', candidates: [{ finishReason: 'MAX_TOKENS' }] }),
      },
    });

    const answer = await adapter.ask('gemini-2.5-pro', 's', 'u', OPTS);
    expect(answer.status).toBe('error');
    expect(answer.error).toMatch(/truncat/i);
  });

  it('a complete answer still succeeds', async () => {
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: {
        generateContent: () =>
          Promise.resolve({
            text: '[{"id":"F1","verdict":"refuted","reason":"guarded"}]',
            candidates: [{ finishReason: 'STOP' }],
          }),
      },
    });

    const answer = await adapter.ask('gemini-2.5-pro', 's', 'u', OPTS);
    expect(answer.status).toBe('success');
    expect(answer.text).toContain('refuted');
  });
});

describe('retry behavior', () => {
  it('anthropic Fable: retries a streamed connection error and succeeds', async () => {
    vi.useFakeTimers();
    const adapter = new AnthropicAdapter('test-key');
    const stream = vi.fn()
      .mockReturnValueOnce({
        finalMessage: vi.fn().mockRejectedValue(new Anthropic.APIConnectionError({
          message: 'Connection lost while reading response',
        })),
      })
      .mockReturnValueOnce(anthropicStreamResponse(anthropicToolResponse()));
    setClient(adapter, { messages: { stream } });

    const pending = adapter.review('claude-fable-5-1', 'general', 's', 'u', {
      timeoutMs: 60000,
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(1100);

    expect((await pending).status).toBe('success');
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it('anthropic Fable: retries a premature stream end, then fails at its retry limit', async () => {
    vi.useFakeTimers();
    const adapter = new AnthropicAdapter('test-key');
    const stream = vi.fn().mockReturnValue({
      finalMessage: vi.fn().mockRejectedValue(new Anthropic.AnthropicError(
        'stream ended without producing a Message with role=assistant',
      )),
    });
    setClient(adapter, { messages: { stream } });

    const pending = adapter.review('claude-fable-5-1', 'general', 's', 'u', {
      timeoutMs: 60000,
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(1100);
    const review = await pending;

    expect(review.status).toBe('error');
    expect(review.error).toContain('stream ended without producing a Message');
    expect(stream).toHaveBeenCalledTimes(2);
  });

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

// OpenAI rejects max_tokens on reasoning-era models with HTTP 400, so a
// wrong parameter is a dead reviewer, not a degraded one.
describe('openai request parameters', () => {
  function capturingClient(captured: Array<Record<string, unknown>>) {
    return {
      chat: {
        completions: {
          create: (params: Record<string, unknown>) => {
            captured.push(params);
            return Promise.resolve(openaiResponse());
          },
        },
      },
    };
  }

  it.each([
    'gpt-5.6-sol',
    'gpt-6-sol',
    'openai/gpt-6-sol',
    'gpt-10-sol',
    'o1',
    'o3',
    'o4-mini',
    'o5-mini',
  ])('%s reviews with max_completion_tokens', async (model) => {
    const captured: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, capturingClient(captured));

    await adapter.review(model, 'general', 's', 'u', OPTS);

    expect(captured[0]).toHaveProperty('max_completion_tokens', 16384);
    expect(captured[0]).not.toHaveProperty('max_tokens');
  });

  it('gpt-6 asks with max_completion_tokens', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, capturingClient(captured));

    await adapter.ask('gpt-6-sol', 's', 'u', OPTS);

    expect(captured[0]).toHaveProperty('max_completion_tokens');
    expect(captured[0]).not.toHaveProperty('max_tokens');
  });

  it.each(['gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'chatgpt-4o-latest'])(
    '%s keeps max_tokens',
    async (model) => {
      const captured: Array<Record<string, unknown>> = [];
      const adapter = new OpenAIAdapter('test-key');
      setClient(adapter, capturingClient(captured));

      await adapter.review(model, 'general', 's', 'u', OPTS);

      expect(captured[0]).toHaveProperty('max_tokens', 16384);
      expect(captured[0]).not.toHaveProperty('max_completion_tokens');
    }
  );
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

// RCL-14: the model answered, but every finding failed schema validation.
// `status: success, findings: []` is indistinguishable from "reviewed and
// found nothing" — a council can lose an entire role while the report says
// the round was complete.
describe('a wholly unparseable response is not a clean review', () => {
  const MALFORMED = JSON.stringify({
    findings: [
      { file: 'a.ts', startLine: 'x', endLine: 'y', severity: 'important', category: 'tests', title: 't', description: 'd' },
    ],
  });

  const SALVAGEABLE = JSON.stringify({
    findings: [
      { file: 'a.ts', startLine: 1, endLine: 2, severity: 'important', category: 'tests', title: 'ok', description: 'd' },
      { file: 'a.ts', startLine: 'x', endLine: 2, severity: 'important', category: 'tests', title: 'bad', description: 'd' },
    ],
  });

  it('openai-compat: all findings dropped yields parse_failed, not success', async () => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key', provider: 'openrouter' });
    setClient(adapter, {
      chat: {
        completions: {
          create: () => Promise.resolve({ choices: [{ message: { content: MALFORMED }, finish_reason: 'stop' }] }),
        },
      },
    });

    const review = await adapter.review('openrouter/x-ai/grok-4.5', 'test-coverage', 's', 'u', OPTS);
    expect(review.status).toBe('parse_failed');
    expect(review.findings).toEqual([]);
    expect(review.droppedFindings).toBe(1);
    expect(review.error).toMatch(/schema validation/i);
    expect(review.warnings?.length).toBeGreaterThan(0);
  });

  it('anthropic: same classification via the tool-use path', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        create: () =>
          Promise.resolve({
            content: [{ type: 'text', text: MALFORMED }],
            stop_reason: 'end_turn',
          }),
      },
    });

    const review = await adapter.review('claude-fable-5', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('parse_failed');
    expect(review.droppedFindings).toBe(1);
  });

  it('a partially salvaged review stays successful but reports the loss', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: {
        completions: {
          create: () => Promise.resolve({ choices: [{ message: { content: SALVAGEABLE }, finish_reason: 'stop' }] }),
        },
      },
    });

    const review = await adapter.review('gpt-5.6-sol', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('success');
    expect(review.findings).toHaveLength(1);
    expect(review.droppedFindings).toBe(1);
  });

  it('string line numbers now parse instead of being dropped', async () => {
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: {
        generateContent: () =>
          Promise.resolve({
            text: JSON.stringify({
              findings: [
                { file: 'a.ts', startLine: '59', endLine: '61', severity: 'minor', category: 'tests', title: 't', description: 'd' },
              ],
            }),
            candidates: [{ finishReason: 'STOP' }],
          }),
      },
    });

    const review = await adapter.review('gemini-3.6-flash', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('success');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]!.startLine).toBe(59);
    expect(review.droppedFindings).toBeUndefined();
  });

  it('a genuine clean review carries no drop count', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: { completions: { create: () => Promise.resolve(openaiResponse()) } },
    });

    const review = await adapter.review('gpt-5.6-sol', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('success');
    expect(review.droppedFindings).toBeUndefined();
    expect(review.warnings).toBeUndefined();
  });
});

// RCL-15: the shape observed in the wild on 1.8.0 — a reviewer answering
// without a findings array. The dropped counter stays zero, so the earlier
// gate let it through as `success` with an empty findings list.
describe('a response that is not a review at all', () => {
  it.each([
    ['no findings key', '{}'],
    ['prose only', 'I was unable to analyse this diff.'],
    ['findings not an array', '{"findings":null}'],
  ])('openai-compat: %s yields parse_failed with no drop count', async (_label, body) => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key', provider: 'openrouter' });
    setClient(adapter, {
      chat: {
        completions: {
          create: () => Promise.resolve({ choices: [{ message: { content: body }, finish_reason: 'stop' }] }),
        },
      },
    });

    const review = await adapter.review(
      'openrouter/deepseek/deepseek-v4-flash-0731',
      'regression-hunter',
      's',
      'u',
      OPTS
    );

    expect(review.status).toBe('parse_failed');
    expect(review.findings).toEqual([]);
    expect(review.droppedFindings).toBeUndefined();
    expect(review.error).toMatch(/not a usable review/i);
    expect(review.warnings?.length).toBeGreaterThan(0);
  });

  it('a genuine zero-finding review is still success', async () => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'test-key', provider: 'openrouter' });
    setClient(adapter, {
      chat: {
        completions: {
          create: () =>
            Promise.resolve({ choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }] }),
        },
      },
    });

    const review = await adapter.review('openrouter/x/y', 'general', 's', 'u', OPTS);

    expect(review.status).toBe('success');
    expect(review.findings).toEqual([]);
  });
});

describe('token usage passthrough', () => {
  it('anthropic: records input and output tokens from the SDK usage block', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        create: async () => ({
          ...anthropicToolResponse(),
          usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0 },
        }),
      },
    });
    const review = await adapter.review('claude-opus-4-8', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('success');
    expect(review.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
  });

  it('anthropic: a truncated answer still records the tokens it consumed', async () => {
    const adapter = new AnthropicAdapter('test-key');
    setClient(adapter, {
      messages: {
        create: async () => ({
          ...anthropicToolResponse('max_tokens'),
          usage: { input_tokens: 50, output_tokens: 16384 },
        }),
      },
    });
    const review = await adapter.review('claude-opus-4-8', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('error');
    expect(review.usage).toEqual({ inputTokens: 50, outputTokens: 16384 });
  });

  it('openai: records prompt, completion and reasoning tokens', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, {
      chat: {
        completions: {
          create: async () => ({
            ...openaiResponse(),
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
              completion_tokens_details: { reasoning_tokens: 5 },
            },
          }),
        },
      },
    });
    const review = await adapter.review('gpt-5.5', 'general', 's', 'u', OPTS);
    expect(review.usage).toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: 5 });
  });

  it('openai-compat (OpenRouter passthrough): reads the OpenAI-shaped usage block', async () => {
    const adapter = new OpenAICompatAdapter({ apiKey: 'k', provider: 'openrouter' });
    setClient(adapter, {
      chat: {
        completions: {
          create: async () => ({
            ...openaiResponse(),
            usage: { prompt_tokens: 7, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } },
          }),
        },
      },
    });
    const review = await adapter.review('openrouter/moonshotai/kimi-k3', 'general', 's', 'u', OPTS);
    expect(review.usage).toEqual({ inputTokens: 7, outputTokens: 8, reasoningTokens: 2 });
  });

  it('google: reads usageMetadata including thought tokens', async () => {
    const adapter = new GoogleAdapter('test-key');
    setClient(adapter, {
      models: {
        generateContent: async () => ({
          ...googleResponse(),
          usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 80, thoughtsTokenCount: 90, totalTokenCount: 240 },
        }),
      },
    });
    const review = await adapter.review('gemini-3.8-flash', 'general', 's', 'u', OPTS);
    // candidates + thoughts = everything generated; thoughts are the reasoning subset
    expect(review.usage).toEqual({ inputTokens: 70, outputTokens: 170, reasoningTokens: 90 });
  });

  it('leaves usage absent when the SDK returns none', async () => {
    const adapter = new OpenAIAdapter('test-key');
    setClient(adapter, { chat: { completions: { create: async () => openaiResponse() } } });
    const review = await adapter.review('gpt-5.5', 'general', 's', 'u', OPTS);
    expect(review.status).toBe('success');
    expect(review).not.toHaveProperty('usage');
  });
});
