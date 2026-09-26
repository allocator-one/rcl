import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describeClaim, compareClaims, claimDescriptorSchema } from '../../src/consensus/claim-identity.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';

describe('versioned semantic claim evidence', () => {
  it('describes long dotted prose without unbounded anchor backtracking', () => {
    const module = new URL('../../src/consensus/claim-identity.ts', import.meta.url).href;
    const script = `import assert from 'node:assert/strict';
      import { describeClaim, compareClaims } from ${JSON.stringify(module)};
      const finding = { file: 'src/cache.ts', title: 'Cache invariant', description: 'a.'.repeat(100000), suggestedFix: '' };
      const left = describeClaim({ ...finding, description: finding.description + 'accepts stale entries' });
      const right = describeClaim({ ...finding, description: finding.description + 'rejects valid entries' });
      assert.notEqual(left.invariant, right.invariant);
      assert.equal(compareClaims(left, right), undefined);`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      encoding: 'utf8', timeout: 4000, env: { PATH: process.env.PATH, LANG: 'C' },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
  it('distinguishes preserved CopyButton, Toast and search allegations', () => {
    const { sightings } = JSON.parse(readFileSync(new URL('../fixtures/semantic-claims.json', import.meta.url), 'utf8'));
    for (const [a, b] of [[0, 2], [1, 3], [4, 5]]) {
      const left = sightings[a!].original_finding as ConsensusFinding;
      const right = sightings[b!].original_finding as ConsensusFinding;
      expect(compareClaims(describeClaim(left), describeClaim(right))).toBeUndefined();
    }
  });
  it('supports a narrow paraphrase with shared invariant and evidence, not title identity', () => {
    const a = describeClaim(sampleFinding({ title: 'Cache result survives expiry', description: 'The search cache returns expired entries without checking their expiry timestamp.', suggestedFix: 'Check the expiry timestamp before returning a cached result.' }));
    const b = describeClaim(sampleFinding({ title: 'Expired cache entries are returned', description: 'The search cache returns expired entries without checking the expiry timestamp.', suggestedFix: 'Check the expiry timestamp before returning the cached result.' }));
    expect(compareClaims(a, b)).toBe('supported_paraphrase');
    expect(compareClaims(a, a)).toBe('exact_descriptor');
  });
  it('does not use an operation, generic concept or opposite invariant alone', () => {
    const a = { version: 1 as const, operation: 'cache.read', invariant: 'The cache must not return expired entries', evidence: ['Expired entries bypass the TTL check'] };
    expect(compareClaims(a, { ...a, invariant: 'The cache must return expired entries' })).toBeUndefined();
    expect(compareClaims(a, { ...a, invariant: 'The cache stores transient failures as missing records', evidence: ['Failure caching survives an upstream outage'] })).toBeUndefined();
  });
  it('does not equate supported paraphrases with different numeric evidence bounds', () => {
    const a = { version: 1 as const, operation: 'cache.read', invariant: 'The cache retries the request after a transient failure', evidence: ['Retry the request at most 3 times after a transient failure'] };
    const b = { ...a, evidence: ['Retry the request at most 5 times after a transient failure'] };
    expect(compareClaims(a, b)).toBeUndefined();
  });
  it.each([
    ['signed', 'Reject status -3 after a transient failure', 'Reject status 3 after a transient failure'],
    ['fractional', 'Wait .5 seconds after a transient failure', 'Wait 5 seconds after a transient failure'],
    ['hexadecimal', 'Mask value 0x10 after a transient failure', 'Mask value 0x20 after a transient failure'],
    ['exponent', 'Retry after 1e3 milliseconds', 'Retry after 1e6 milliseconds'],
    ['unit', 'Retry after 3ms', 'Retry after 5ms'],
    ['binary', 'Mask value 0b10 after a transient failure', 'Mask value 0b11 after a transient failure'],
  ])('does not equate %s numeric evidence constraints', (_kind, left, right) => {
    const a = { version: 1 as const, operation: 'cache.read', invariant: 'The cache retries the request after a transient failure', evidence: [left] };
    expect(compareClaims(a, { ...a, evidence: [right] })).toBeUndefined();
  });
  it('does not equate operation constraints with different digit-bearing tokens', () => {
    const a = { version: 1 as const, operation: 'cache.read retry=3n', invariant: 'The cache retries the request after a transient failure', evidence: ['Retry the request after a transient failure'] };
    expect(compareClaims(a, { ...a, operation: 'cache.read retry=5n' })).toBeUndefined();
  });
  it('normalizes a bounded complete descriptor once, including Unicode and secrets', () => {
    const d = describeClaim(sampleFinding({ title: 'Check\0 cache', description: '😀'.repeat(600) + ' sk-abcdefghijklmnop123456789', suggestedFix: '\u0001Fix the invalid cache record' }));
    expect(claimDescriptorSchema.safeParse(d).success).toBe(true);
    for (const text of [d.operation, d.invariant, ...d.evidence]) {
      expect([...text].length).toBeLessThanOrEqual(500);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2000);
      expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    }
    expect(JSON.stringify(d)).not.toContain('sk-abcdefghijklmnop123456789');
    expect(claimDescriptorSchema.safeParse({ ...d, extra: true }).success).toBe(false);
  });
});

it('does not equate truncation collisions, substituted quoted subjects or reversed conditions', () => {
  const base = sampleFinding({ title: 'Cache invariant', description: 'The cache returns a result only after `load_account()` completes.', suggestedFix: 'Wait for the loader before returning the cache result.' });
  const descriptor = describeClaim(base);
  expect(compareClaims(descriptor, describeClaim({ ...base, description: base.description.replace('load_account', 'load_org') }))).toBeUndefined();
  expect(compareClaims(descriptor, describeClaim({ ...base, description: base.description.replace('after', 'before') }))).toBeUndefined();
  const long = 'The cache preserves the exact assertion '.repeat(20);
  const a = describeClaim({ ...base, description: long + 'but incorrectly accepts stale entries' });
  const b = describeClaim({ ...base, description: long + 'but incorrectly rejects valid entries' });
  expect(a.invariant).not.toBe(b.invariant);
  expect(compareClaims(a, b)).toBeUndefined();
  expect(compareClaims(descriptor, { ...descriptor, evidence: [...descriptor.evidence].reverse() })).not.toBe('exact_descriptor');
});
it('retains sparse reviewer output without inventing equivalence from a title or redacted argument', () => {
  const blank = describeClaim(sampleFinding({ title: ' ', description: '\u0000', suggestedFix: '' }));
  expect(claimDescriptorSchema.safeParse(blank).success).toBe(true);
  expect(compareClaims(blank, blank)).toBeUndefined();
  const titleOnly = describeClaim(sampleFinding({ title: 'The search cache returns expired records', description: ' ', suggestedFix: '' }));
  expect(compareClaims(titleOnly, titleOnly)).toBeUndefined();
  const redacted = describeClaim(sampleFinding({ title: 'Cache uses an invalid credential', description: 'The cache applies secret=sk-abcdefghijklmnop123456789 to every query.', suggestedFix: 'Use the request credential for every cache query.' }));
  expect(compareClaims(redacted, redacted)).toBeUndefined();
});
