import { describe, it, expect } from 'vitest';
import { evaluateCiGate } from '../src/ci.js';
import type { ConsensusFinding, ReviewResult } from '../src/consensus/types.js';

function finding(severity: ConsensusFinding['severity']): ConsensusFinding {
  return {
    id: 'f',
    file: 'a.ts',
    startLine: 1,
    endLine: 1,
    severity,
    category: 'security',
    title: 't',
    description: 'd',
    consensus: {
      score: 1,
      total: 1,
      models: ['m'],
      roles: ['general'],
      crossRole: false,
      crossModel: false,
      elevated: false,
      elevation: 'none',
      confidence: 0.5,
      confidenceLabel: 'Medium',
    },
  };
}

function result(over: {
  successfulReviews: number;
  totalReviews: number;
  findings?: ConsensusFinding[];
}): ReviewResult {
  return {
    reviews: [],
    findings: over.findings ?? [],
    stats: {
      totalReviews: over.totalReviews,
      successfulReviews: over.successfulReviews,
      totalRawFindings: 0,
      totalDeduped: over.findings?.length ?? 0,
      belowThreshold: 0,
      durationMs: 1,
    },
  };
}

describe('evaluateCiGate', () => {
  it('fails when every reviewer errored, even with zero findings', () => {
    const verdict = evaluateCiGate(result({ successfulReviews: 0, totalReviews: 6 }));
    expect(verdict.exitCode).toBe(1);
    expect(verdict.message).toContain('0/6');
  });

  it('fails on blocking findings', () => {
    const verdict = evaluateCiGate(
      result({ successfulReviews: 3, totalReviews: 3, findings: [finding('critical')] })
    );
    expect(verdict.exitCode).toBe(1);
    expect(verdict.message).toContain('blocking');
  });

  it('passes on a successful run with only minor findings', () => {
    const verdict = evaluateCiGate(
      result({ successfulReviews: 3, totalReviews: 3, findings: [finding('minor')] })
    );
    expect(verdict.exitCode).toBe(0);
  });

  it('the zero-success check takes precedence over the findings check', () => {
    const verdict = evaluateCiGate(result({ successfulReviews: 0, totalReviews: 3 }));
    expect(verdict.message).toContain('nothing was reviewed');
  });
});
