import { describe, it, expect } from 'vitest';
import { stripKnownProviderPrefix } from '../../src/dispatch/utils.js';

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
});
