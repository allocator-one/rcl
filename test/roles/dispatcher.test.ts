import { describe, it, expect } from 'vitest';
import { detectProvider } from '../../src/roles/dispatcher.js';

describe('detectProvider', () => {
  it('detects anthropic from explicit prefix', () => {
    expect(detectProvider('anthropic/claude-sonnet-4-5')).toBe('anthropic');
  });

  it('detects openai from explicit prefix', () => {
    expect(detectProvider('openai/gpt-5.4')).toBe('openai');
  });

  it('detects google from explicit prefix', () => {
    expect(detectProvider('google/gemini-2.5-pro')).toBe('google');
  });

  it('detects openai-compat from explicit prefix', () => {
    expect(detectProvider('openai-compat/local-model')).toBe('openai-compat');
  });

  it('detects anthropic by model name (legacy)', () => {
    expect(detectProvider('claude-sonnet-4-5')).toBe('anthropic');
  });

  it('detects openai by model name (legacy gpt)', () => {
    expect(detectProvider('gpt-4o')).toBe('openai');
  });

  it('detects google by model name (legacy gemini)', () => {
    expect(detectProvider('gemini-pro')).toBe('google');
  });

  it('explicit prefix beats name-based heuristic', () => {
    expect(detectProvider('google/claude-like-model')).toBe('google');
  });

  it('falls back to openai-compat for unknown model', () => {
    expect(detectProvider('unknown-model')).toBe('openai-compat');
  });
});
