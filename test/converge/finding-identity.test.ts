import { describe, it, expect } from 'vitest';
import {
  stableFindingKey,
  matchFinding,
} from '../../src/converge/finding-identity.js';

const base = {
  file: 'src/a.ts',
  category: 'correctness',
  startLine: 42,
  endLine: 48,
};

describe('stableFindingKey (RCL-24)', () => {
  it('is deterministic for identical inputs', () => {
    expect(stableFindingKey(base)).toBe(stableFindingKey({ ...base }));
  });

  it('does not depend on the title — models rephrase across rounds', () => {
    // Title is not an input at all; two phrasings of the same location match.
    const key = stableFindingKey(base);
    expect(key).toBe(stableFindingKey({ ...base }));
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs across files and categories', () => {
    expect(stableFindingKey(base)).not.toBe(stableFindingKey({ ...base, file: 'src/b.ts' }));
    expect(stableFindingKey(base)).not.toBe(
      stableFindingKey({ ...base, category: 'security' })
    );
  });

  it('is stable under small line drift within the anchor bucket', () => {
    expect(stableFindingKey(base)).toBe(stableFindingKey({ ...base, startLine: 44, endLine: 47 }));
  });
});

describe('matchFinding', () => {
  const entries = [
    { key: 'k1', file: 'src/a.ts', category: 'correctness', startLine: 40, endLine: 50 },
    { key: 'k2', file: 'src/a.ts', category: 'security', startLine: 40, endLine: 50 },
    { key: 'k3', file: 'src/b.ts', category: 'correctness', startLine: 40, endLine: 50 },
  ];

  it('matches same file+category with overlapping lines even across bucket boundaries', () => {
    expect(matchFinding({ ...base, startLine: 49, endLine: 52 }, entries, 5)?.key).toBe('k1');
  });

  it('does not match a different category or file', () => {
    expect(matchFinding({ ...base, category: 'tests' }, entries, 5)).toBeUndefined();
    expect(matchFinding({ ...base, file: 'src/c.ts' }, entries, 5)).toBeUndefined();
  });

  it('does not match findings far away in the same file', () => {
    expect(matchFinding({ ...base, startLine: 400, endLine: 410 }, entries, 5)).toBeUndefined();
  });
});
