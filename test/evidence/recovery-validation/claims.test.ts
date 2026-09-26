import { expect, it } from 'vitest';
import { claimDescriptorSchema, compareClaims, descriptorKey, semanticFindingKey } from '../../../src/evidence/claim-recovery/validation/claims.js';
import { descriptor } from './fixtures.js';

it('compares retained grammatical variants without generating or normalizing descriptors', () => {
  const other = { ...descriptor, invariant: descriptor.invariant.replace('their expiry', 'the expiry') };
  const before = structuredClone([descriptor, other]);
  expect(compareClaims(descriptor, descriptor)).toBe('exact_descriptor');
  expect(compareClaims(descriptor, other)).toBe('supported_paraphrase');
  expect([descriptor, other]).toEqual(before);
  expect(descriptorKey(descriptor)).toBe(JSON.stringify([1, descriptor.operation, descriptor.invariant, descriptor.evidence]));
  expect(semanticFindingKey('cache.ts', 'correctness', descriptor)).toMatch(/^[a-f0-9]{16}$/);
  expect(semanticFindingKey('other.ts', 'correctness', descriptor)).not.toBe(semanticFindingKey('cache.ts', 'correctness', descriptor));
});

it.each([
  ['-3', '3'], ['.5', '5'], ['0x10', '0x20'], ['1e3', '1e6'], ['3ms', '5ms'], ['0b10', '0b11'],
])('refuses retained evidence constraints %s versus %s', (left, right) => {
  const a = { ...descriptor, evidence: [`Retry the cache request after ${left} units following a transient failure`] };
  expect(compareClaims(a, { ...a, evidence: [a.evidence[0]!.replace(left, right)] })).toBeUndefined();
});

it('guards numeric operation constraints, polarity, quoted symbols and field ordering', () => {
  const a = { ...descriptor, operation: 'cache.ts :: cache.read retry=3n' };
  expect(compareClaims(a, { ...a, operation: a.operation.replace('3n', '5n') })).toBeUndefined();
  expect(compareClaims(descriptor, { ...descriptor, invariant: descriptor.invariant.replace('without', 'after') })).toBeUndefined();
  const quoted = { ...descriptor, operation: 'cache.ts :: `load_account()`' };
  expect(compareClaims(quoted, { ...quoted, operation: 'cache.ts :: `load_org()`' })).toBeUndefined();
});

it.each([
  { extra: true }, { invariant: '' }, { operation: 'x'.repeat(501) }, { evidence: [] },
  { invariant: 'bad\u0001control' }, { invariant: 'bad\uD800surrogate' }, { version: 2 },
])('rejects unsupported or malformed descriptors: %j', changed => {
  expect(claimDescriptorSchema.safeParse({ ...descriptor, ...changed }).success).toBe(false);
});

it('does not invent equivalence for sparse or redacted historical evidence', () => {
  for (const d of [{ ...descriptor, evidence: [descriptor.invariant] },
    { ...descriptor, evidence: ['[redacted] original secret value'] }, { ...descriptor, invariant: 'cache issue' }]) {
    expect(compareClaims(d, d)).toBeUndefined();
  }
});
