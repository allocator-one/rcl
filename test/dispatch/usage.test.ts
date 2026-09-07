import { describe, it, expect } from 'vitest';
import { usageFromAnthropic, usageFromGoogle, usageFromOpenAI } from '../../src/dispatch/utils.js';

describe('usage extractors', () => {
  it('map every SDK shape to the camelCase report shape', () => {
    expect(usageFromAnthropic({ input_tokens: 10, output_tokens: 20 })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(
      usageFromOpenAI({
        prompt_tokens: 1,
        completion_tokens: 2,
        completion_tokens_details: { reasoning_tokens: 3 },
      })
    ).toEqual({ inputTokens: 1, outputTokens: 2, reasoningTokens: 3 });
    // Google reports answer and thinking tokens disjointly; outputTokens is
    // the total generated so it means the same thing as for OpenAI, whose
    // completion_tokens already include reasoning.
    expect(
      usageFromGoogle({ promptTokenCount: 4, candidatesTokenCount: 5, thoughtsTokenCount: 6 })
    ).toEqual({ inputTokens: 4, outputTokens: 11, reasoningTokens: 6 });
    expect(usageFromGoogle({ promptTokenCount: 4, candidatesTokenCount: 5 })).toEqual({
      inputTokens: 4,
      outputTokens: 5,
    });
  });

  it('count Anthropic prompt-cache reads and writes as input tokens', () => {
    expect(
      usageFromAnthropic({
        input_tokens: 100,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 500,
        output_tokens: 20,
      })
    ).toEqual({ inputTokens: 10_600, outputTokens: 20 });
    expect(
      usageFromAnthropic({ input_tokens: null, cache_read_input_tokens: 7, output_tokens: 1 })
    ).toEqual({ inputTokens: 7, outputTokens: 1 });
  });

  it('return nothing for a missing or null usage block', () => {
    expect(usageFromAnthropic(undefined)).toBeUndefined();
    expect(usageFromAnthropic(null)).toBeUndefined();
    expect(usageFromOpenAI(null)).toBeUndefined();
    expect(usageFromGoogle(undefined)).toBeUndefined();
  });

  it('keep only the counters that were reported and never return {}', () => {
    expect(usageFromAnthropic({ input_tokens: null, output_tokens: 7 })).toEqual({ outputTokens: 7 });
    expect(usageFromAnthropic({ input_tokens: null, output_tokens: null })).toBeUndefined();
    expect(usageFromOpenAI({ prompt_tokens: 1, completion_tokens_details: null })).toEqual({
      inputTokens: 1,
    });
    expect(usageFromOpenAI({ prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: {} })).toEqual(
      { inputTokens: 1, outputTokens: 2 }
    );
    expect(usageFromGoogle({})).toBeUndefined();
  });

  it('preserve zero counts and drop non-numeric values', () => {
    expect(usageFromAnthropic({ input_tokens: 0, output_tokens: 0 })).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(
      usageFromOpenAI({ prompt_tokens: '12' as unknown as number, completion_tokens: 3 })
    ).toEqual({ outputTokens: 3 });
  });
});
