import { describe, it, expect } from 'vitest';
import { stripKnownProviderPrefix, isRetryableStatus } from '../../src/dispatch/utils.js';

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
