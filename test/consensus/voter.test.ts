import { describe, it, expect } from 'vitest';
import { computeConsensus } from '../../src/consensus/voter.js';
import type { Finding, ModelReview, DeduplicatedGroup } from '../../src/consensus/types.js';
import type { Role } from '../../src/roles/types.js';

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

function mkReview(
  model: string,
  role: string,
  findings: Finding[] = [],
  status: ModelReview['status'] = 'success'
): ModelReview {
  return { model, role, provider: 'test', findings, durationMs: 0, status };
}

function mkRole(name: string, focus: string[]): Role {
  return { name, systemPrompt: '', focus, description: '', isSpecialized: focus.length > 0 };
}

function mkGroup(
  representative: Finding,
  members: Array<{ finding: Finding; model: string; role: string }>
): DeduplicatedGroup {
  return { representative, members };
}

const ROLES = new Map<string, Role>([
  ['security-auditor', mkRole('security-auditor', ['security'])],
  ['general', mkRole('general', [])],
  ['bp-1', mkRole('bp-1', ['best-practices'])],
  ['bp-2', mkRole('bp-2', ['best-practices'])],
  ['bp-3', mkRole('bp-3', ['best-practices'])],
]);

describe('computeConsensus — relevance', () => {
  it('specialist confirmation raises confidence above non-specialist-only findings', () => {
    const fSpec = mkF({ id: 's1', file: 'src/a.ts' });
    const fGen = mkF({ id: 'g1', file: 'src/b.ts' });
    const reviews = [
      mkReview('m1', 'security-auditor', [fSpec]),
      mkReview('m2', 'general', [fGen]),
    ];
    const groups = [
      mkGroup(fSpec, [{ finding: fSpec, model: 'm1', role: 'security-auditor' }]),
      mkGroup(fGen, [{ finding: fGen, model: 'm2', role: 'general' }]),
    ];

    const [spec, gen] = computeConsensus(groups, reviews, ROLES);

    // diversity 0.5, relevance 1.0 (specialist flagged), isolation 1/1
    expect(spec!.consensus.confidence).toBeCloseTo(0.8);
    // diversity 0.5, relevance 0.5, isolation 0/1 (the specialist missed it)
    expect(gen!.consensus.confidence).toBeCloseTo(0.35);
    expect(spec!.consensus.confidence).toBeGreaterThan(gen!.consensus.confidence);
  });

  it('uses exact focus matching, not substring matching', () => {
    const f = mkF({ category: 'api-design' });
    const reviews = [mkReview('m1', 'api-reviewer', [f])];
    const roles = new Map<string, Role>([['api-reviewer', mkRole('api-reviewer', ['api'])]]);
    const groups = [mkGroup(f, [{ finding: f, model: 'm1', role: 'api-reviewer' }])];

    const [result] = computeConsensus(groups, reviews, roles);

    // focus 'api' ≠ category 'api-design': no specialist confirmation (0.5),
    // no relevant reviewers for isolation (0.5), solo-model diversity (0.5)
    // → 0.5 * 0.4 + 0.5 * 0.3 + 0.5 * 0.3 = 0.5. Substring matching would
    // have treated the role as focused and scored higher.
    expect(result!.consensus.confidence).toBeCloseTo(0.5);
  });
});

describe('computeConsensus — diversity', () => {
  it('caps solo-model reviews below perfect diversity', () => {
    const f = mkF();
    const reviews = [mkReview('m1', 'general', [f])];
    const groups = [mkGroup(f, [{ finding: f, model: 'm1', role: 'general' }])];

    const [result] = computeConsensus(groups, reviews, ROLES);

    // A single successful model must not score 1.0 diversity:
    // diversity 0.5, relevance 0.5, isolation 0.5 → confidence 0.5, not 0.8
    expect(result!.consensus.confidence).toBeCloseTo(0.5);
    expect(result!.consensus.confidenceLabel).toBe('Medium');
  });
});

describe('computeConsensus — severity', () => {
  function threeReviewerSetup(severities: [Finding['severity'], Finding['severity'], Finding['severity']]) {
    const findings = severities.map((severity, i) =>
      mkF({ id: `f${i}`, severity, category: 'best-practices' })
    );
    const reviews = [
      mkReview('m1', 'bp-1', [findings[0]!]),
      mkReview('m2', 'bp-2', [findings[1]!]),
      mkReview('m3', 'bp-3', [findings[2]!]),
    ];
    // Representative is the highest-severity member, matching the deduper's choice
    const severityOrder = { critical: 0, important: 1, minor: 2, nitpick: 3 };
    const rep = [...findings].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])[0]!;
    const groups = [
      mkGroup(rep, [
        { finding: findings[0]!, model: 'm1', role: 'bp-1' },
        { finding: findings[1]!, model: 'm2', role: 'bp-2' },
        { finding: findings[2]!, model: 'm3', role: 'bp-3' },
      ]),
    ];
    return computeConsensus(groups, reviews, ROLES)[0]!;
  }

  it('a unanimous nitpick stays a nitpick', () => {
    const result = threeReviewerSetup(['nitpick', 'nitpick', 'nitpick']);

    expect(result.consensus.confidenceLabel).toBe('Very High');
    expect(result.severity).toBe('nitpick');
    expect(result.consensus.elevated).toBe(false);
    expect(result.consensus.elevation).toBe('none');
  });

  it('elevates a disputed severity to the max any member assigned, from the mode', () => {
    const result = threeReviewerSetup(['critical', 'minor', 'minor']);

    // mode = minor, max = critical; Very High confidence resolves upward
    expect(result.severity).toBe('critical');
    expect(result.consensus.elevated).toBe(true);
    expect(result.consensus.original_severity).toBe('minor');
    expect(result.consensus.elevation).toBe('unanimous');
    // A 2+ level severity spread is also surfaced as a dispute
    expect(result.consensus.disputed).toBe(true);
    expect(result.consensus.disputeDetails).toContain('severity');
  });

  it('never elevates past the highest member severity', () => {
    const f1 = mkF({ id: 'f1', severity: 'important', category: 'best-practices' });
    const f2 = mkF({ id: 'f2', severity: 'minor', category: 'best-practices' });
    const reviews = [mkReview('m1', 'bp-1', [f1]), mkReview('m2', 'bp-2', [f2])];
    const groups = [
      mkGroup(f1, [
        { finding: f1, model: 'm1', role: 'bp-1' },
        { finding: f2, model: 'm2', role: 'bp-2' },
      ]),
    ];

    const [result] = computeConsensus(groups, reviews, ROLES);

    // Old behavior: High/Very High + cross-model would blind-bump important → critical.
    // Now: 1-1 tie resolves to the more severe member (important) and stops there.
    expect(result!.consensus.confidenceLabel).toBe('Very High');
    expect(result!.severity).toBe('important');
    expect(result!.consensus.elevated).toBe(false);
    expect(result!.consensus.disputed).toBeUndefined();
  });
});

describe('computeConsensus — disputes', () => {
  it('flags severity dispersion of 2+ levels within a group', () => {
    const f1 = mkF({ id: 'f1', severity: 'critical' });
    const f2 = mkF({ id: 'f2', severity: 'nitpick' });
    const reviews = [mkReview('m1', 'general', [f1]), mkReview('m2', 'general', [f2])];
    const groups = [
      mkGroup(f1, [
        { finding: f1, model: 'm1', role: 'general' },
        { finding: f2, model: 'm2', role: 'general' },
      ]),
    ];

    const [result] = computeConsensus(groups, reviews, ROLES);

    expect(result!.consensus.disputed).toBe(true);
    expect(result!.consensus.disputeDetails).toContain('nitpick');
    expect(result!.consensus.disputeDetails).toContain('critical');
  });

  it('flags opposing-conclusion groups at overlapping lines', () => {
    // endLine overlap that a startLine-only diff (38 apart) would miss
    const f1 = mkF({ id: 'f1', title: 'Missing input validation', startLine: 10, endLine: 50 });
    const f2 = mkF({ id: 'f2', title: 'Input validation present', startLine: 48, endLine: 48 });
    const reviews = [mkReview('m1', 'general', [f1]), mkReview('m2', 'general', [f2])];
    const groups = [
      mkGroup(f1, [{ finding: f1, model: 'm1', role: 'general' }]),
      mkGroup(f2, [{ finding: f2, model: 'm2', role: 'general' }]),
    ];

    const results = computeConsensus(groups, reviews, ROLES);

    expect(results[0]!.consensus.disputed).toBe(true);
    expect(results[0]!.consensus.disputeDetails).toContain('Conflicting');
    expect(results[1]!.consensus.disputed).toBe(true);
  });
});
