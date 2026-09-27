import { expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/dispatch/openai.js';

it('sends the selected verifier reasoning effort to Astra without changing ordinary ask defaults', async () => {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }] });
  const adapter = new OpenAIAdapter('test-key');
  (adapter as unknown as { client: unknown }).client = { chat: { completions: { create } } };
  await adapter.ask('openai/gpt-6-astra', 'system', 'user', { timeoutMs: 1000, maxRetries: 0, reasoningEffort: 'high' });
  expect(create.mock.calls[0]![0]).toMatchObject({ model: 'gpt-6-astra', reasoning_effort: 'high' });
  await adapter.ask('openai/gpt-6-sol', 'system', 'user', { timeoutMs: 1000, maxRetries: 0 });
  expect(create.mock.calls[1]![0]).not.toHaveProperty('reasoning_effort');
});
