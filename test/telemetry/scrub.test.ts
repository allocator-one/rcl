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
    expect(stripFencedCode('before ```json\n{"a":1}\n```\nafter')).toBe('before [code omitted]\nafter');
    expect(stripFencedCode('open ```\nnever closed')).toBe('open [code omitted]');
    expect(stripFencedCode('tilde ~~~json\n{"prompt":"raw"}\n~~~\ndone')).toBe('tilde [code omitted]\ndone');
    expect(stripFencedCode('long ````\nx\n````\nend')).toBe('long [code omitted]\nend');
  });

  it('closes only at a line start with the same character at least as long, and strips every block', () => {
    // A shorter run inside the block does not close it; a longer one does.
    expect(stripFencedCode('a ````\ninner ``` still code\n````\nb')).toBe('a [code omitted]\nb');
    expect(stripFencedCode('a ```\ncode\n````\nb')).toBe('a [code omitted]\nb');
    // A same-length run mid-line, or one followed by text, is part of the block.
    expect(stripFencedCode('a ```\nx = "```"; still code\n``` not a close\n```\nb')).toBe('a [code omitted]\nb');
    // Tildes never close a backtick fence; up to three leading spaces are allowed.
    expect(stripFencedCode('a ```\ncode ~~~ more\n   ```  \nb')).toBe('a [code omitted]\nb');
    // Windows line endings still close a fence.
    expect(stripFencedCode('a ```\r\ncode\r\n```\r\nb')).toBe('a [code omitted]\nb');
    // Several blocks, mixed styles, with a final unclosed one.
    expect(stripFencedCode('x ```\none\n```\ny ~~~\ntwo\n~~~\nz ```\nthree')).toBe('x [code omitted]\ny [code omitted]\nz [code omitted]');
  });
});

describe('scrubbing is idempotent and bounded', () => {
  it('is a fixed point at every cap, truncated or not', () => {
    const text = `token=abcdefghijklmnop and ${'x'.repeat(300)} sk-${'k'.repeat(30)} end`;
    for (const max of [20, 100, 500, undefined]) {
      const once = scrubText(text, max);
      expect(scrubText(once, max)).toBe(once);
    }
    expect(scrubSecrets(REDACTED)).toBe(REDACTED);
  });

  it('applies the same result twice', () => {
    const noisy = `token="a very long passphrase" ghp_${'A'.repeat(30)} ${'x'.repeat(3_000)}`;
    const once = scrubText(noisy, 500);
    expect(scrubText(once, 500)).toBe(once);
    expect(scrubSecrets(scrubSecrets(noisy))).toBe(scrubSecrets(noisy));
    expect(stripFencedCode(stripFencedCode('a ```\nb\n```\nc'))).toBe(stripFencedCode('a ```\nb\n```\nc'));
  });

  it('never leaves half a secret at the pre-scrub cut', () => {
    const secret = `sk-${'q'.repeat(40)}`;
    const text = `${'p'.repeat(2_000 * 4 - 10)} ${secret} tail`;
    const out = scrubText(text);
    expect(out).not.toContain('sk-');
    expect(out).not.toContain('qqqq');
  });

  it('keeps distinct keys distinct after scrubbing and drops prototype keys', () => {
    const scrubbed = scrubDeep({ 'token=abcdefgh': 1, 'token=ijklmnop': 2, plain: 3 }) as Record<string, unknown>;
    expect(Object.keys(scrubbed).sort()).toEqual([`token=${REDACTED}`, `token=${REDACTED}#2`, 'plain'].sort());
    expect(scrubbed[`token=${REDACTED}`]).toBe(1);
    expect(scrubbed[`token=${REDACTED}#2`]).toBe(2);

    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "ok": "x"}') as Record<string, unknown>;
    const safe = scrubDeep(hostile) as Record<string, unknown>;
    expect(Object.keys(safe)).toEqual(['ok']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    // At every depth, inside arrays too.
    const nested = JSON.parse(
      '{"a": {"__proto__": {"deep": true}, "prototype": 1, "keep": [{"constructor": 2, "ok": 1}]}}'
    ) as Record<string, unknown>;
    const nestedSafe = scrubDeep(nested) as { a: { keep: Array<Record<string, unknown>> } };
    expect(Object.keys(nestedSafe.a)).toEqual(['keep']);
    expect(Object.keys(nestedSafe.a.keep[0]!)).toEqual(['ok']);
    expect(({} as Record<string, unknown>)['deep']).toBeUndefined();
  });

  it('redacts Stripe, GitLab, npm and Hugging Face token shapes', () => {
    // Assembled at runtime so no key-shaped literal sits in the repository.
    const body = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    for (const token of [
      ['sk', 'live', body.slice(0, 24)].join('_'),
      ['rk', 'test', body.slice(0, 24)].join('_'),
      ['glpat', body.slice(0, 20)].join('-'),
      ['npm', body.slice(0, 36)].join('_'),
      ['hf', body.slice(0, 34)].join('_'),
    ]) {
      expect(scrubSecrets(`key ${token} used`)).toBe(`key ${REDACTED} used`);
    }
  });

  it('redacts JSON-quoted keys, compound key names and values with escaped quotes', () => {
    expect(scrubSecrets('{"password":"lowercasecredential"}')).toBe(`{"password":"${REDACTED}"}`);
    expect(scrubSecrets('client_secret=lowercasecredential')).toBe(`client_secret=${REDACTED}`);
    expect(scrubSecrets('GITHUB_TOKEN=abcdefghij')).toBe(`GITHUB_TOKEN=${REDACTED}`);
    expect(scrubSecrets('private_key: "-----BEGIN"')).toBe(`private_key: "${REDACTED}"`);
    expect(scrubSecrets('api_key: "abc\\"def" rest')).toBe(`api_key: "${REDACTED}" rest`);
  });
});
