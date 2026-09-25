import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleAdapter } from '../../src/dispatch/google.js';
import { applyHarnessModelKeys } from '../../src/config/harness.js';

function selectedKey(apiKey?: string): string | undefined {
  const adapter = new GoogleAdapter(apiKey);
  return (adapter as unknown as { client: { apiKey?: string } }).client.apiKey;
}

beforeEach(() => {
  vi.stubEnv('GOOGLE_API_KEY', undefined);
  vi.stubEnv('GEMINI_API_KEY', undefined);
  vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Google credential selection', () => {
  it('does not let an empty Google alias shadow an available Gemini key', () => {
    vi.stubEnv('GOOGLE_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-fixture');

    expect(selectedKey()).toBe('gemini-fixture');
  });

  it('normalizes whitespace before choosing a nonempty credential', () => {
    vi.stubEnv('GOOGLE_API_KEY', ' \t ');
    vi.stubEnv('GEMINI_API_KEY', ' gemini-fixture ');

    expect(selectedKey(' ')).toBe('gemini-fixture');
  });

  it('preserves nonempty explicit credentials ahead of both environment aliases', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'google-fixture');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-fixture');

    expect(selectedKey('explicit-fixture')).toBe('explicit-fixture');
  });

  it('preserves Google precedence over Gemini when both aliases are nonempty', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'google-fixture');
    vi.stubEnv('GEMINI_API_KEY', 'gemini-fixture');

    expect(selectedKey('')).toBe('google-fixture');
  });

  it.each([undefined, '', ' \t '])('leaves missing credentials missing for %j', blank => {
    vi.stubEnv('GOOGLE_API_KEY', blank);
    vi.stubEnv('GEMINI_API_KEY', blank);

    expect(selectedKey(blank)).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith('API key should be set when using the Gemini API.');
  });

  it('uses the Harness-injected key despite a blank Google alias', async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'anthropic-fixture', OPENAI_API_KEY: 'openai-fixture',
      OPENROUTER_API_KEY: 'openrouter-fixture', GOOGLE_API_KEY: ' ', GEMINI_API_KEY: '',
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { keys: { google: 'harness-google-fixture' } },
    }), { status: 200 }));

    const result = await applyHarnessModelKeys({
      env, credential: { url: 'https://harness.example.test', token: 'fixture-token' }, fetchImpl,
    });
    vi.stubEnv('GOOGLE_API_KEY', env['GOOGLE_API_KEY']);
    vi.stubEnv('GEMINI_API_KEY', env['GEMINI_API_KEY']);

    expect(result.injected).toEqual(['google']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(env['GOOGLE_API_KEY']).toBe(' ');
    expect(selectedKey()).toBe('harness-google-fixture');
  });

  it('does not fetch Harness keys when Gemini already supplies the Google credential', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'anthropic-fixture', OPENAI_API_KEY: 'openai-fixture',
      OPENROUTER_API_KEY: 'openrouter-fixture', GOOGLE_API_KEY: '', GEMINI_API_KEY: 'gemini-fixture',
    };
    const fetchImpl = vi.fn();

    const result = await applyHarnessModelKeys({
      env, credential: { url: 'https://harness.example.test', token: 'fixture-token' }, fetchImpl,
    });

    expect(result.injected).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(env['GEMINI_API_KEY']).toBe('gemini-fixture');
  });
});
