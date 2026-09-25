import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../src/dispatch/anthropic.js';

const FINDING = {
  id: 'finding-1',
  file: 'src/access.ts',
  startLine: 12,
  endLine: 12,
  severity: 'important',
  category: 'correctness',
  title: 'Missing fallback',
  description: 'The empty response needs a fallback.',
};

function event(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function messageStart(): string {
  return event('message_start', {
    message: {
      id: 'msg_local_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5-1',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
}

async function withLocalSse(
  responseEvents: string,
  run: (adapter: AnthropicAdapter, requests: object[]) => Promise<void>,
): Promise<void> {
  const requests: object[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body) as object);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(responseEvents);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as AddressInfo).port;
    const adapter = new AnthropicAdapter('local-test-key');
    // Keep the adapter's real SDK client and transport; only route its base URL
    // to this test server, so no provider credentials or network call is used.
    (adapter as unknown as { client: Anthropic }).client.baseURL = `http://127.0.0.1:${port}`;
    await run(adapter, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

describe('Anthropic Fable streaming over real SDK SSE', () => {
  it('assembles tool input deltas and parses the final findings', async () => {
    const input = JSON.stringify({ findings: [FINDING] });
    const stream = [
      messageStart(),
      event('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_local_test', name: 'report_findings', input: {} },
      }),
      event('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: input.slice(0, 25) },
      }),
      event('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: input.slice(25) },
      }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', {
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 18 },
      }),
      event('message_stop', {}),
    ].join('');

    await withLocalSse(stream, async (adapter, requests) => {
      const review = await adapter.review('anthropic/claude-fable-5-1', 'general', 'system', 'diff', {
        timeoutMs: 5000,
        maxRetries: 0,
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: 'claude-fable-5-1',
        stream: true,
        max_tokens: 32768,
        output_config: { effort: 'medium' },
        tool_choice: { type: 'auto' },
      });
      expect(review.status).toBe('success');
      expect(review.findings).toEqual([FINDING]);
      expect(review.usage).toMatchObject({ inputTokens: 10, outputTokens: 18 });
    });
  });

  it('fails closed when SSE ends before message_stop', async () => {
    const stream = [
      messageStart(),
      event('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_local_test', name: 'report_findings', input: {} },
      }),
      event('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"findings":[]}' },
      }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', {
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 8 },
      }),
    ].join('');

    await withLocalSse(stream, async (adapter, requests) => {
      const review = await adapter.review('claude-fable-5-1', 'general', 'system', 'diff', {
        timeoutMs: 5000,
        maxRetries: 0,
      });

      expect(requests).toHaveLength(1);
      expect(review.status).toBe('error');
      expect(review.findings).toEqual([]);
      expect(review.error).toContain('stream ended without producing a Message');
    });
  });
});
