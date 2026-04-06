import { describe, it, expect } from 'vitest';
import { jaccardSimilarity, deduplicateFindings } from '../../src/consensus/deduper.js';
import type { ModelReview } from '../../src/consensus/types.js';
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
