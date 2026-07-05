import { describe, it, expect } from 'vitest';
import {
  jaccardSimilarity,
  combinedSimilarity,
  hasOpposingSentiment,
  deduplicateFindings,
} from '../../src/consensus/deduper.js';
import type { Finding, ModelReview } from '../../src/consensus/types.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = join(__dirname, '../fixtures');

describe('jaccardSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaccardSimilarity('hello world', 'hello world')).toBe(1.0);
  });

  it('returns 0.0 for completely different strings', () => {
    expect(jaccardSimilarity('abc def', 'xyz uvw')).toBe(0.0);
  });

  it('returns 1.0 for two empty strings', () => {
    expect(jaccardSimilarity('', '')).toBe(1.0);
  });

  it('returns a value between 0 and 1 for partial overlap', () => {
    const sim = jaccardSimilarity('sql injection vulnerability', 'sql injection attack');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe('deduplicateFindings', () => {
  function loadReview(file: string, model: string, role: string): ModelReview {
    const raw = JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8')) as { findings: ModelReview['findings'] };
    return { model, role, provider: 'test', findings: raw.findings, durationMs: 0, status: 'success' };
  }

  it('deduplicates overlapping findings across models', () => {
    const reviews = [
      loadReview('review-claude.json', 'claude-opus-4-6', 'security-auditor'),
      loadReview('review-gpt.json', 'gpt-4o', 'general'),
    ];
    const groups = deduplicateFindings(reviews, 0.3, 5);
    const totalRaw = reviews.reduce((s, r) => s + r.findings.length, 0);
    // Should have fewer groups than raw findings (some are duplicates)
    expect(groups.length).toBeLessThan(totalRaw);
    expect(groups.length).toBeGreaterThan(0);
  });

  it('returns empty for reviews with no findings', () => {
    const reviews: ModelReview[] = [
      { model: 'm1', role: 'r1', provider: 'p', findings: [], durationMs: 0, status: 'success' },
    ];
    expect(deduplicateFindings(reviews)).toHaveLength(0);
  });

  it('skips non-success reviews', () => {
    const reviews: ModelReview[] = [
      { model: 'm1', role: 'r1', provider: 'p', findings: [
        { id: '1', file: 'a.ts', startLine: 1, endLine: 1, severity: 'minor', category: 'security', title: 'test', description: 'test description' }
      ], durationMs: 0, status: 'error' },
    ];
    expect(deduplicateFindings(reviews)).toHaveLength(0);
  });

  it('sorts results by severity (critical first)', () => {
    const reviews = [loadReview('review-claude.json', 'claude-opus-4-6', 'general')];
    const groups = deduplicateFindings(reviews);
    const severityOrder = { critical: 0, important: 1, minor: 2, nitpick: 3 };
    for (let i = 1; i < groups.length; i++) {
      const prev = severityOrder[groups[i - 1]!.representative.severity];
      const curr = severityOrder[groups[i]!.representative.severity];
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});

function mkF(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    file: 'src/a.ts',
    startLine: 10,
    endLine: 12,
    severity: 'important',
    category: 'security',
    title: 'SQL injection in query builder',
    description: 'User input is interpolated directly into the SQL query string',
    ...over,
  };
}

function mkReview(model: string, role: string, findings: Finding[]): ModelReview {
  return { model, role, provider: 'test', findings, durationMs: 0, status: 'success' };
}

describe('jaccardSimilarity tokenization', () => {
  it('keeps short signal tokens like "xss" and "id"', () => {
    expect(jaccardSimilarity('xss risk', 'xss risk')).toBe(1.0);
    expect(jaccardSimilarity('missing id check', 'missing id validation')).toBeGreaterThan(0.3);
  });

  it('ignores stopwords', () => {
    expect(jaccardSimilarity('the input is validated', 'input validated')).toBe(1.0);
  });

  it('keeps negations as signal', () => {
    expect(jaccardSimilarity('no validation here', 'validation here')).toBeLessThan(1.0);
  });
});

describe('combinedSimilarity', () => {
  it('weights title at 0.6 and description at 0.4', () => {
    const sameTitle = combinedSimilarity(
      mkF({ title: 'hardcoded secret', description: 'alpha beta gamma' }),
      mkF({ title: 'hardcoded secret', description: 'delta epsilon zeta' })
    );
    expect(sameTitle).toBeCloseTo(0.6);

    const sameDesc = combinedSimilarity(
      mkF({ title: 'alpha beta gamma', description: 'hardcoded secret found' }),
      mkF({ title: 'delta epsilon zeta', description: 'hardcoded secret found' })
    );
    expect(sameDesc).toBeCloseTo(0.4);
  });

  it('renormalizes to title-only when descriptions carry no tokens', () => {
    // Empty descriptions must not grant 0.4 free similarity, nor drag a
    // strong title match below threshold
    const identicalTitles = combinedSimilarity(
      mkF({ title: 'hardcoded secret', description: '' }),
      mkF({ title: 'hardcoded secret', description: '' })
    );
    expect(identicalTitles).toBeCloseTo(1.0);

    const disjointTitles = combinedSimilarity(
      mkF({ title: 'alpha beta gamma', description: '' }),
      mkF({ title: 'delta epsilon zeta', description: '' })
    );
    expect(disjointTitles).toBe(0);
  });

  it('returns 0 when no field has usable tokens on both sides', () => {
    const empty = combinedSimilarity(
      mkF({ title: 'is it a', description: 'the of' }),
      mkF({ title: 'was there', description: '' })
    );
    expect(empty).toBe(0);
  });
});

describe('hasOpposingSentiment', () => {
  it('detects opposing title terms', () => {
    const a = mkF({ title: 'Function lacks error handling' });
    const b = mkF({ title: 'Function has error handling' });
    expect(hasOpposingSentiment(a, b)).toBe(true);
  });

  it('detects missing vs present', () => {
    const a = mkF({ title: 'Missing rate limiting on login endpoint' });
    const b = mkF({ title: 'Rate limiting present on login endpoint' });
    expect(hasOpposingSentiment(a, b)).toBe(true);
  });

  it('respects word boundaries: "unsafe" is not "safe"', () => {
    const a = mkF({ title: 'Unsafe deserialization of user input', description: 'x' });
    const b = mkF({ title: 'Unsafe deserialization risk here', description: 'y' });
    expect(hasOpposingSentiment(a, b)).toBe(false);

    const c = mkF({ title: 'Safe deserialization pattern used', description: 'z' });
    expect(hasOpposingSentiment(a, c)).toBe(true);
  });

  it('treats a text containing both terms of a pair as taking no position', () => {
    // "is not" contains both sides of the not/is pair — no stance either way
    const a = mkF({ title: 'Input is not validated' });
    const b = mkF({ title: 'Input is validated' });
    expect(hasOpposingSentiment(a, b)).toBe(false);
  });

  it('returns false for unrelated titles', () => {
    const a = mkF({ title: 'SQL injection in query builder' });
    const b = mkF({ title: 'Race condition in cache invalidation' });
    expect(hasOpposingSentiment(a, b)).toBe(false);
  });
});

describe('deduplicateFindings — intra-review dedup', () => {
  it('collapses repeats of the same finding within one review', () => {
    const f = mkF({ title: 'Hardcoded secret in config', description: 'The secret is hardcoded in source' });
    const reviews = [mkReview('m1', 'general', [f, { ...f, id: 'f2' }, { ...f, id: 'f3' }])];
    const groups = deduplicateFindings(reviews);
    expect(groups).toHaveLength(1);
    // A stuttering model must not look like 3 independent confirmations
    expect(groups[0]!.members).toHaveLength(1);
  });
});

describe('deduplicateFindings — contradiction veto', () => {
  it('refuses to merge findings with opposing conclusions', () => {
    const a = mkF({
      title: 'Missing rate limiting on login endpoint',
      description: 'Login route allows unlimited attempts',
    });
    const b = mkF({
      id: 'b1',
      title: 'Rate limiting present on login endpoint',
      description: 'Login route throttles attempts correctly',
      startLine: 11,
      endLine: 11,
    });
    const reviews = [mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])];
    const groups = deduplicateFindings(reviews);
    // High word overlap + same location, but opposite conclusions → stay separate
    expect(groups).toHaveLength(2);
  });

  it('does not veto merges on generic pairs — those merge and dispute later', () => {
    // lacks/has is a generic pair: too noisy to fragment a duplicate group.
    // The voter surfaces the contradiction as an intra-group dispute instead.
    const a = mkF({
      title: 'Function lacks error handling',
      description: 'Failures from the API call are unhandled',
    });
    const b = mkF({
      id: 'b1',
      title: 'Function has error handling gaps',
      description: 'Failures from the API call are unhandled',
    });
    const reviews = [mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])];
    const groups = deduplicateFindings(reviews);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(2);
  });
});

describe('deduplicateFindings — weighted similarity', () => {
  it('no longer merges on description similarity alone', () => {
    const a = mkF({
      title: 'SQL injection risk',
      description: 'User input flows into database query without sanitization',
    });
    const b = mkF({
      id: 'b1',
      title: 'Unvalidated query parameter',
      description: 'User input flows into database query without escaping applied',
    });
    const reviews = [mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])];
    // Old Math.max(titleSim, descSim) would merge these (descSim ≈ 0.67);
    // weighted similarity requires the titles to carry signal too
    const groups = deduplicateFindings(reviews);
    expect(groups).toHaveLength(2);
  });
});

describe('deduplicateFindings — category soft gate', () => {
  it('merges near-identical findings across categories', () => {
    // Models disagree on category boundaries constantly; identical text at
    // the same location is the same finding regardless of the label
    const a = mkF({ category: 'correctness' });
    const b = mkF({ id: 'b1', category: 'best-practices' });
    const reviews = [mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])];
    const groups = deduplicateFindings(reviews);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(2);
  });

  it('requires stronger similarity for cross-category merges', () => {
    // Combined similarity 0.3: enough within a category, not across (0.45)
    const a = mkF({ title: 'missing null check', description: 'alpha beta gamma', category: 'correctness' });
    const b = mkF({ id: 'b1', title: 'missing bounds check', description: 'delta epsilon zeta', category: 'best-practices' });
    const reviews = [mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])];
    expect(deduplicateFindings(reviews)).toHaveLength(2);

    // The same pair within one category merges
    const sameCat = [
      mkReview('m1', 'general', [a]),
      mkReview('m2', 'general', [{ ...b, category: 'correctness' as const }]),
    ];
    expect(deduplicateFindings(sameCat)).toHaveLength(1);
  });

  it('caps the cross-category threshold at 1.0', () => {
    // A configured threshold of 0.7 would put the cross-category bar at
    // 1.05 — identical findings must still be able to merge
    const a = mkF({ category: 'correctness' });
    const b = mkF({ id: 'b1', category: 'best-practices' });
    const reviews = [mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])];
    expect(deduplicateFindings(reviews, 0.7)).toHaveLength(1);
  });
});

describe('deduplicateFindings — group coherence', () => {
  it('splits transitive chains whose ends are dissimilar', () => {
    // Identical text, but lines 1 / 8 / 15 with window 5:
    // A overlaps B, B overlaps C, A does not overlap C
    const a = mkF({ id: 'a', startLine: 1, endLine: 1 });
    const b = mkF({ id: 'b', startLine: 8, endLine: 8 });
    const c = mkF({ id: 'c', startLine: 15, endLine: 15 });
    const reviews = [
      mkReview('m1', 'r1', [a]),
      mkReview('m2', 'r2', [b]),
      mkReview('m3', 'r3', [c]),
    ];
    const groups = deduplicateFindings(reviews);
    // Union-find alone would chain all three into one group
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.members.length).sort()).toEqual([1, 2]);
  });
});
