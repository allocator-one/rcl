import { describe, it, expect } from 'vitest';
import { evaluateCiGate } from '../src/ci.js';
import type { ConsensusFinding, ReviewResult } from '../src/consensus/types.js';
import { deriveReviewerHealth, type ReviewerHealth } from '../src/report/reviewer-health.js';

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

describe('evaluateCiGate with gating annotations (RCL-23)', () => {
  it('does not block on an important finding gated as none (refuted single-model)', () => {
    const f = { ...finding('important'), gating: { reason: 'none' as const } };
    const verdict = evaluateCiGate(
      result({ successfulReviews: 3, totalReviews: 3, findings: [f] })
    );
    expect(verdict.exitCode).toBe(0);
  });

  it('blocks on findings gated as consensus, critical, or verified', () => {
    for (const reason of ['consensus', 'critical', 'verified'] as const) {
      const f = { ...finding('important'), gating: { reason } };
      const verdict = evaluateCiGate(
        result({ successfulReviews: 3, totalReviews: 3, findings: [f] })
      );
      expect(verdict.exitCode).toBe(1);
    }
  });

  it('falls back to severity for findings without gating annotations', () => {
    const verdict = evaluateCiGate(
      result({ successfulReviews: 3, totalReviews: 3, findings: [finding('important')] })
    );
    expect(verdict.exitCode).toBe(1);
  });
});

function health(successes: number): ReviewerHealth {
  const roster = Array.from({ length: 3 }, (_, index) => ({ seat: `seat-${index}`, model: `model-${index}`, role: 'general', route: 'provider' }));
  const cells = roster.map(seat => ({ ...seat, id: `${seat.seat}:0`, chunk: 0, chunkDigest: 'a'.repeat(64) }));
  return deriveReviewerHealth({ version: 1, roster, cells, chunks: [{ index: 0, total: 1, digest: 'a'.repeat(64) }] },
    cells.slice(0, successes).map(cell => ({ cell: cell.id, review: { model: cell.model, role: cell.role, provider: cell.route, status: 'success', findings: [], durationMs: 1 } })),
    { version: 1, fraction: 2 / 3 });
}

describe('evaluateCiGate with validated reviewer health', () => {
  it('fails below quorum even when legacy totals look successful and there are no findings', () => {
    const report = result({ successfulReviews: 18, totalReviews: 18 });
    const verdict = evaluateCiGate(report, health(1));
    expect(verdict.exitCode).toBe(1);
    expect(verdict.message).toContain('1/3');
    expect(verdict.message).toContain('2');
    expect(evaluateCiGate(report)).toEqual({ exitCode: 0 });
  });

  it('passes at quorum but keeps original actionable findings blocking and unchanged', () => {
    const clean = result({ successfulReviews: 2, totalReviews: 3 });
    expect(evaluateCiGate(clean, health(2))).toEqual({ exitCode: 0 });
    const actionable = result({ successfulReviews: 2, totalReviews: 3, findings: [finding('important')] });
    const before = JSON.stringify(actionable);
    expect(evaluateCiGate(actionable, health(2)).exitCode).toBe(1);
    expect(JSON.stringify(actionable)).toBe(before);
  });

  it('refuses a deserialized or forged health projection instead of trusting its threshold', () => {
    const forged = { ...health(1), conclusive: true, policy: { version: 1, fraction: 2 / 3, seatCount: 3, minimumSuccessful: 1 } };
    expect(() => evaluateCiGate(result({ successfulReviews: 3, totalReviews: 3 }), forged as ReviewerHealth)).toThrow(/validated/i);
  });
});
