import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeClaim, compareClaims, claimDescriptorSchema } from '../../src/consensus/claim-identity.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';

describe('versioned semantic claim evidence', () => {
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
