import Anthropic from '@anthropic-ai/sdk';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/dispatch/anthropic.js';
import { isRetryableConnectionError } from '../../src/dispatch/utils.js';

type FailureCase = {
  name: string;
  makeError: () => Error;
  expectedStatus: 'success' | 'error';
  expectedAttempts: number;
  utilityRetryable: boolean;
};

const OPTIONS = { timeoutMs: 20_000, maxRetries: 3 };

function transportError(code?: string): TypeError {
  const cause = code === undefined
    ? undefined
    : Object.assign(new Error('Synthetic transport cause'), { code });
  return new TypeError('terminated', cause === undefined ? undefined : { cause });
}

function messageStart() {
  return {
    type: 'message_start' as const,
    message: {
      id: 'msg_local_mock',
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  };
}

function successTail() {
  return [
    {
      type: 'content_block_start' as const,
      index: 0,
      content_block: {
        type: 'tool_use' as const,
        id: 'tool_local_mock',
        name: 'report_findings',
        input: {},
      },
    },
    {
      type: 'content_block_delta' as const,
      index: 0,
      delta: { type: 'input_json_delta' as const, partial_json: '{"findings":[]}' },
    },
    { type: 'content_block_stop' as const, index: 0 },
    {
      type: 'message_delta' as const,
      delta: { stop_reason: 'tool_use' as const, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' as const },
  ];
}

async function runCase(spec: FailureCase) {
  const adapter = new AnthropicAdapter('local-dummy-not-a-credential');
  const streamCalls = vi.fn();
  const createCalls = vi.fn();
  const sdkErrors: Error[] = [];

  Object.assign(adapter, {
    client: {
      messages: {
        stream(request: object, options: { signal: AbortSignal }) {
          streamCalls(request, options);
          const attempt = streamCalls.mock.calls.length;
          const fakeMessages = {
            create(params: object, opts: { signal: AbortSignal }) {
              createCalls(params, opts);
              const data = {
                controller: { signal: opts.signal },
                async *[Symbol.asyncIterator]() {
                  yield messageStart();
                  if (attempt === 1) throw spec.makeError();
                  for (const event of successTail()) yield event;
                },
              };
              return {
                async withResponse() {
                  return {
                    response: new Response(null, {
                      status: 200,
                      headers: { 'request-id': 'req_local_mock' },
                    }),
                    data,
                  };
                },
              };
            },
          };
          const stream = MessageStream.createMessage(fakeMessages as never, request as never, options);
          stream.on('error', (error) => sdkErrors.push(error));
          stream.on('abort', (error) => sdkErrors.push(error));
          return stream;
        },
      },
    },
  });

  const pending = adapter.review(
    'anthropic/claude-opus-5-5',
    'general',
    'Synthetic local review; return findings.',
    'No real patch or credentials.',
    OPTIONS,
  );
  if (spec.expectedAttempts === 2) await vi.advanceTimersByTimeAsync(1_001);
  const outcome = await pending;

  expect(outcome).toMatchObject({
    status: spec.expectedStatus,
    adapterAttempts: spec.expectedAttempts,
  });
  expect(streamCalls).toHaveBeenCalledTimes(spec.expectedAttempts);
  expect(createCalls).toHaveBeenCalledTimes(spec.expectedAttempts);
  expect(sdkErrors).toHaveLength(1);
  expect(isRetryableConnectionError(sdkErrors[0])).toBe(spec.utilityRetryable);
}

describe('Anthropic SDK-wrapped stream transport failures', () => {
  let network: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    network = vi.fn(() => {
      throw new Error('External network forbidden');
    });
    vi.stubGlobal('fetch', network);
  });

  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each<FailureCase>([
    {
      name: 'UND_ERR_SOCKET',
      makeError: () => transportError('UND_ERR_SOCKET'),
      expectedStatus: 'success',
      expectedAttempts: 2,
      utilityRetryable: true,
    },
    {
      name: 'ECONNRESET',
      makeError: () => transportError('ECONNRESET'),
      expectedStatus: 'success',
      expectedAttempts: 2,
      utilityRetryable: true,
    },
    {
      name: 'APIConnectionError control',
      makeError: () => new Anthropic.APIConnectionError({
        cause: transportError('UND_ERR_SOCKET'),
      }),
      expectedStatus: 'success',
      expectedAttempts: 2,
      utilityRetryable: true,
    },
    {
      name: 'incomplete stream control',
      makeError: () => new Anthropic.AnthropicError(
        'request ended without sending any chunks',
      ),
      expectedStatus: 'success',
      expectedAttempts: 2,
      utilityRetryable: false,
    },
    {
      name: 'permanent TLS cause',
      makeError: () => transportError('CERT_HAS_EXPIRED'),
      expectedStatus: 'error',
      expectedAttempts: 1,
      utilityRetryable: false,
    },
    {
      name: 'unclassified terminated error',
      makeError: () => transportError(),
      expectedStatus: 'error',
      expectedAttempts: 1,
      utilityRetryable: false,
    },
    {
      name: 'user abort',
      makeError: () => new Anthropic.APIUserAbortError(),
      expectedStatus: 'error',
      expectedAttempts: 1,
      utilityRetryable: false,
    },
  ])('$name', runCase);
});
