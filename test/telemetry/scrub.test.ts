import { describe, expect, it } from 'vitest';
import { REDACTED, scrubDeep, scrubSecrets, scrubText, stripFencedCode } from '../../src/telemetry/scrub.js';

describe('scrubSecrets', () => {
  it('redacts provider, GitHub, Google, Harness and bearer tokens', () => {
    const text = [
      'anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
      'openai sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123',
      'pat github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'google AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ012345678',
      'harness aone_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'header Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
    ].join('\n');
    const scrubbed = scrubSecrets(text);
    expect(scrubbed).not.toMatch(/sk-|ghp_|github_pat_|AIza|aone_|eyJ/);
    expect(scrubbed.split(REDACTED).length - 1).toBe(7);
  });

  it('redacts an opaque mixed-class token but keeps hex digests and prose', () => {
    const digest = 'f'.repeat(64);
    const sha = '3ffee698ed340e49943d4aa7f47d244a94b8ef87';
    const token = 'Qm9vdHN0cmFwVG9rZW4xMjM0NTY3ODkwYWJjZGVm';
    const scrubbed = scrubSecrets(`digest ${digest} commit ${sha} token ${token} words words words`);
    expect(scrubbed).toContain(digest);
    expect(scrubbed).toContain(sha);
    expect(scrubbed).not.toContain(token);
    expect(scrubbed).toContain('words words words');
  });
});

describe('scrubText', () => {
  it('truncates after scrubbing, grapheme-safe, with an ellipsis', () => {
    expect(scrubText('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(scrubText('😀'.repeat(20), 5)).toBe(`${'😀'.repeat(4)}…`);
    expect(scrubText('short')).toBe('short');
  });
});

describe('scrubDeep', () => {
  it('scrubs every nested string and leaves the structure alone', () => {
    const value = { a: ['sk-ant-abcdefghijklmnopqrstuvwxyz', { b: 'fine', n: 3, z: null }] };
    expect(scrubDeep(value)).toEqual({ a: [REDACTED, { b: 'fine', n: 3, z: null }] });
  });
});

describe('stripFencedCode', () => {
  it('drops fenced blocks, closed or not', () => {
    expect(stripFencedCode('before ```json\n{"a":1}\n``` after')).toBe('before [code omitted] after');
    expect(stripFencedCode('open ```\nnever closed')).toBe('open [code omitted]');
  });
});
