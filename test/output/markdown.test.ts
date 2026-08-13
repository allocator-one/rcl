import { describe, it, expect } from 'vitest';
import { toMarkdown } from '../../src/output/markdown.js';
import type {
  AgreementTier,
  ConsensusFinding,
  ReviewResult,
} from '../../src/consensus/types.js';

function mkFinding(over: {
  tier: AgreementTier;
  severity?: ConsensusFinding['severity'];
  title?: string;
  disputed?: boolean;
  confidence?: number;
  models?: string[];
}): ConsensusFinding {
  return {
    id: 'f1',
    file: 'src/a.ts',
    startLine: 10,
    endLine: 12,
    severity: over.severity ?? 'minor',
    category: 'correctness',
    title: over.title ?? 'A finding',
    description: 'Something looks wrong here.',
    consensus: {
      score: over.models?.length ?? 1,
      total: 4,
      models: over.models ?? ['m1'],
      roles: ['general'],
      crossRole: false,
      crossModel: (over.models?.length ?? 1) >= 2,
      elevated: false,
      elevation: 'none',
      confidence: over.confidence ?? 0.5,
      confidenceLabel: 'Medium',
      tier: over.tier,
      disputed: over.disputed || undefined,
      disputeDetails: over.disputed ? 'Reviewers disagree on severity' : undefined,
      positions: over.disputed
        ? [
            {
              model: 'm1',
              role: 'general',
              severity: 'critical',
              title: 'Definitely broken',
              excerpt: 'This will corrupt data.',
            },
            {
              model: 'm2',
              role: 'general',
              severity: 'minor',
              title: 'Slightly off',
              excerpt: 'Cosmetic at worst.',
            },
          ]
        : undefined,
    },
  };
}

function mkResult(
  findings: ConsensusFinding[],
  belowThresholdFindings?: ConsensusFinding[]
): ReviewResult {
  return {
    reviews: [
      { model: 'm1', role: 'general', provider: 'test', findings: [], durationMs: 1000, status: 'success' },
      { model: 'm2', role: 'general', provider: 'test', findings: [], durationMs: 1000, status: 'success' },
      { model: 'm3', role: 'general', provider: 'test', findings: [], durationMs: 1000, status: 'success' },
    ],
    findings,
    ...(belowThresholdFindings ? { belowThresholdFindings } : {}),
    stats: {
      totalReviews: 3,
      successfulReviews: 3,
      totalRawFindings: findings.length,
      totalDeduped: findings.length,
      belowThreshold: belowThresholdFindings?.length ?? 0,
      durationMs: 2000,
    },
  };
}

describe('toMarkdown — agreement tier sections', () => {
  it('orders sections unanimous → majority → minority → disputed → single', () => {
    const md = toMarkdown(
      mkResult([
        mkFinding({ tier: 'single', title: 'single finding' }),
        mkFinding({ tier: 'unanimous', title: 'unanimous finding', models: ['m1', 'm2', 'm3'] }),
        mkFinding({ tier: 'majority', title: 'majority finding', models: ['m1', 'm2'] }),
        mkFinding({ tier: 'minority', title: 'minority finding', models: ['m1', 'm2'] }),
        mkFinding({ tier: 'majority', disputed: true, title: 'disputed finding', models: ['m1', 'm2'] }),
      ])
    );

    const positions = [
      md.indexOf('## ✅ Unanimous'),
      md.indexOf('## 🤝 Majority'),
      md.indexOf('## 👥 Cross-model'),
      md.indexOf('## ⚔️ Disputed'),
      md.indexOf('## 👤 Single model'),
    ];
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('pulls disputed findings out of their count-based tier', () => {
    const md = toMarkdown(
      mkResult([
        mkFinding({ tier: 'majority', disputed: true, title: 'contested', models: ['m1', 'm2'] }),
      ])
    );
    expect(md).toContain('## ⚔️ Disputed');
    expect(md).not.toContain('## 🤝 Majority');
  });

  it('renders disputed findings with per-model positions', () => {
    const md = toMarkdown(
      mkResult([mkFinding({ tier: 'majority', disputed: true, models: ['m1', 'm2'] })])
    );
    expect(md).toContain('**Positions:**');
    expect(md).toContain('**m1** (general) rated **critical**: Definitely broken — This will corrupt data.');
    expect(md).toContain('**m2** (general) rated **minor**: Slightly off — Cosmetic at worst.');
    expect(md).toContain('⚠ Reviewers disagree on severity');
  });

  it('sorts by severity within a section', () => {
    const md = toMarkdown(
      mkResult([
        mkFinding({ tier: 'single', severity: 'minor', title: 'lesser problem' }),
        mkFinding({ tier: 'single', severity: 'critical', title: 'worse problem' }),
      ])
    );
    expect(md.indexOf('worse problem')).toBeLessThan(md.indexOf('lesser problem'));
  });

  it('summarizes agreement counts', () => {
    const md = toMarkdown(
      mkResult([
        mkFinding({ tier: 'unanimous', models: ['m1', 'm2', 'm3'] }),
        mkFinding({ tier: 'single' }),
        mkFinding({ tier: 'single' }),
      ])
    );
    expect(md).toContain('**Agreement:** 1 unanimous · 0 majority · 0 minority · 0 disputed · 2 single');
  });

  it('omits empty sections', () => {
    const md = toMarkdown(mkResult([mkFinding({ tier: 'single' })]));
    expect(md).not.toContain('## ✅ Unanimous');
    expect(md).not.toContain('## ⚔️ Disputed');
    expect(md).toContain('## 👤 Single model');
  });

  it('keeps the empty-state message when there are no findings', () => {
    const md = toMarkdown(mkResult([]));
    expect(md).toContain('## ✅ No Issues Found');
  });
});

describe('toMarkdown — below-threshold appendix', () => {
  it('renders dropped findings in a collapsed, demoted section', () => {
    const md = toMarkdown(
      mkResult(
        [mkFinding({ tier: 'single', title: 'kept finding' })],
        [mkFinding({ tier: 'single', title: 'dropped but worth checking', confidence: 0.1 })]
      )
    );
    expect(md).toContain('## 🕵️ Worth checking — below report thresholds (1)');
    expect(md).toContain('<details>');
    expect(md).toContain('dropped but worth checking');
    // appendix renders after all finding sections
    expect(md.indexOf('Worth checking')).toBeGreaterThan(md.indexOf('kept finding'));
  });

  it('never counts appendix findings in the severity summary', () => {
    const md = toMarkdown(
      mkResult([], [mkFinding({ tier: 'single', severity: 'minor' })])
    );
    expect(md).toContain('| 🔵 minor | 0 |');
    // The empty state must not claim "clean" while the appendix disagrees
    expect(md).toContain('## ✅ No Findings Above Report Thresholds');
    expect(md).not.toContain('All reviewers returned clean results');
    expect(md).toContain('## 🕵️ Worth checking');
  });

  it('sanitizes file paths and model names in appendix lines', () => {
    const evil = mkFinding({ tier: 'single', title: 'x' });
    evil.file = 'src/`pwn`.ts<script>';
    evil.consensus.models = ['@attacker/model'];
    const md = toMarkdown(mkResult([], [evil]));
    expect(md).not.toContain('<script>');
    expect(md).not.toContain('`pwn`');
    expect(md).toContain('`@attacker/model`'); // mention neutralized in backticks
  });

  it('caps the rendered appendix at 20 entries and points at the JSON for the rest', () => {
    const dropped = Array.from({ length: 25 }, (_, i) =>
      mkFinding({ tier: 'single', title: `dropped-${i}` })
    );
    const md = toMarkdown(mkResult([], dropped));
    expect(md).toContain('Show 20 of 25');
    expect(md).toContain('dropped-19');
    expect(md).not.toContain('dropped-20');
    expect(md).toContain('…and 5 more — see the JSON output');
  });

  it('renders no appendix when belowThresholdFindings is absent', () => {
    const md = toMarkdown(mkResult([mkFinding({ tier: 'single' })]));
    expect(md).not.toContain('Worth checking');
    expect(md).not.toContain('<details>');
  });
});

// RCL-14: the skills tell people to read reports from files, never from
// console scrollback — so degraded coverage has to be IN the report.
describe('toMarkdown — degraded coverage', () => {
  function reviewerResult(reviews: ReviewResult['reviews']): ReviewResult {
    return {
      reviews,
      findings: [],
      stats: {
        totalReviews: reviews.length,
        successfulReviews: reviews.filter((r) => r.status === 'success').length,
        totalRawFindings: 0,
        totalDeduped: 0,
        belowThreshold: 0,
        durationMs: 1000,
      },
    };
  }

  const clean = {
    model: 'm1',
    role: 'general',
    provider: 'test',
    findings: [],
    durationMs: 1000,
    status: 'success' as const,
  };

  it('warns above the reviewer table when a reviewer was wholly lost', () => {
    const md = toMarkdown(
      reviewerResult([
        clean,
        {
          ...clean,
          model: 'openrouter/x-ai/grok-4.5',
          role: 'test-coverage',
          status: 'parse_failed',
          droppedFindings: 6,
          error: 'All 6 finding(s) failed schema validation',
        },
      ])
    );

    expect(md).toContain('Degraded coverage');
    expect(md).toContain('6 finding(s) could not be parsed');
    expect(md).toContain('openrouter/x-ai/grok-4.5/test-coverage');
    expect(md.indexOf('Degraded coverage')).toBeLessThan(md.indexOf('## Reviewers'));
  });

  it('shows the dropped count beside the findings count', () => {
    const md = toMarkdown(reviewerResult([{ ...clean, droppedFindings: 2 }]));

    expect(md).toContain('0 (2 dropped)');
    expect(md).toContain('⚠️'); // banner marker
  });

  it('says nothing about degradation on a clean run', () => {
    const md = toMarkdown(reviewerResult([clean]));

    expect(md).not.toContain('Degraded coverage');
    expect(md).not.toContain('dropped)');
  });
});
