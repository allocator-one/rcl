import { describe, expect, it } from 'vitest';
import { resolveProviderConcurrency } from '../../src/config/provider-concurrency.js';

describe('resolveProviderConcurrency', () => {
  it('applies the version-owned Anthropic default without capping other providers', () => {
    expect(resolveProviderConcurrency()).toEqual({ anthropic: 2 });
    expect(resolveProviderConcurrency()).not.toHaveProperty('openai');
  });

  it('lets source-bound configuration override a default and add another provider', () => {
    expect(resolveProviderConcurrency({ anthropic: 4, openai: 3 }))
      .toEqual({ anthropic: 4, openai: 3 });
  });
});
