import { describe, expect, it } from 'vitest';
import { REDACTED, scrubDeep, scrubIdentifier, scrubSecrets, scrubText, stripFencedCode } from '../../src/telemetry/scrub.js';

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

  it('redacts temporary AWS key ids, quoted passphrases with spaces and short quoted values', () => {
    expect(scrubSecrets('key ASIAABCDEFGHIJKLMNOP used')).toBe(`key ${REDACTED} used`);
    expect(scrubSecrets('password="correct horse battery staple" next')).toBe(`password="${REDACTED}" next`);
    expect(scrubSecrets("token: 'abc' rest")).toBe(`token: '${REDACTED}' rest`);
    expect(scrubSecrets('api_key="a,b;c d" tail')).toBe(`api_key="${REDACTED}" tail`);
    // Unquoted short runs read as prose (a type name), not a value.
    expect(scrubSecrets('the token: string field')).toBe('the token: string field');
  });

  it('keeps long mixed-case identifiers when asked to scrub an identifier', () => {
    expect(scrubIdentifier('anthropic/Claude-Sonnet-4-5-20250929-preview')).toBe('anthropic/Claude-Sonnet-4-5-20250929-preview');
    expect(scrubIdentifier(`model ghp_${'A'.repeat(30)}`)).toBe(`model ${REDACTED}`);
    expect(scrubSecrets('anthropic/Claude-Sonnet-4-5-20250929-preview')).toBe(REDACTED);
  });

  it('redacts JWTs, AWS key ids and key=value assignments, keeping the key name', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    expect(scrubSecrets(`jwt ${jwt}`)).toBe(`jwt ${REDACTED}`);
    expect(scrubSecrets('aws AKIAIOSFODNN7EXAMPLE')).toBe(`aws ${REDACTED}`);
    expect(scrubSecrets('api_key=abcdefghij1234 token: "zyxwvutsrq9876"')).toBe(`api_key=${REDACTED} token: "${REDACTED}"`);
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
  it('scrubs every nested string — keys included — and leaves the structure alone', () => {
    const value = { a: ['sk-ant-abcdefghijklmnopqrstuvwxyz', { b: 'fine', n: 3, z: null }], 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123': 1 };
    expect(scrubDeep(value)).toEqual({ a: [REDACTED, { b: 'fine', n: 3, z: null }], [REDACTED]: 1 });
  });
});

describe('stripFencedCode', () => {
  it('drops backtick and tilde fences, closed or not', () => {
    expect(stripFencedCode('before ```json\n{"a":1}\n``` after')).toBe('before [code omitted] after');
    expect(stripFencedCode('open ```\nnever closed')).toBe('open [code omitted]');
    expect(stripFencedCode('tilde ~~~json\n{"prompt":"raw"}\n~~~ done')).toBe('tilde [code omitted] done');
    expect(stripFencedCode('long ````\nx\n```` end')).toBe('long [code omitted] end');
  });

  it('closes a fence only with the same character at least as long, and strips every block', () => {
    // A shorter run inside the block does not close it; a longer one does.
    expect(stripFencedCode('a ````\ninner ``` still code\n```` b')).toBe('a [code omitted] b');
    expect(stripFencedCode('a ```\ncode\n```` b')).toBe('a [code omitted] b');
    // Tildes never close a backtick fence.
    expect(stripFencedCode('a ```\ncode ~~~ more\n``` b')).toBe('a [code omitted] b');
    // Several blocks, mixed styles, with a final unclosed one.
    expect(stripFencedCode('x ```\none\n``` y ~~~\ntwo\n~~~ z ```\nthree')).toBe('x [code omitted] y [code omitted] z [code omitted]');
  });
});

describe('scrubbing is idempotent and bounded', () => {
  it('applies the same result twice', () => {
    const noisy = `token="a very long passphrase" ghp_${'A'.repeat(30)} ${'x'.repeat(3_000)}`;
    const once = scrubText(noisy, 500);
    expect(scrubText(once, 500)).toBe(once);
    expect(scrubSecrets(scrubSecrets(noisy))).toBe(scrubSecrets(noisy));
    expect(stripFencedCode(stripFencedCode('a ```\nb\n``` c'))).toBe(stripFencedCode('a ```\nb\n``` c'));
  });

  it('redacts a secret that sits right at the pre-scrub cut', () => {
    const secret = `sk-${'q'.repeat(40)}`;
    const text = `${'p'.repeat(2_000 * 4 - 10)}${secret}`;
    expect(scrubText(text)).not.toContain(secret.slice(0, 20));
  });
});
