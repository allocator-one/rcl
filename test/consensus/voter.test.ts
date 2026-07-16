import { describe, it, expect } from 'vitest';
import { computeConsensus } from '../../src/consensus/voter.js';
import { getRoleByName } from '../../src/roles/builtin.js';
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
  // The REAL builtin general role: isSpecialized false, but its focus lists
  // every category. A stub with focus [] hid the all-focus gating bug — the
  // fixture must stay honest (rcl-7mw.9).
  ['general', getRoleByName('general')!],
  ['bp-1', mkRole('bp-1', ['best-practices'])],
  ['bp-2', mkRole('bp-2', ['best-practices'])],
  ['bp-3', mkRole('bp-3', ['best-practices'])],
  ['bp-4', mkRole('bp-4', ['best-practices'])],
  ['bp-5', mkRole('bp-5', ['best-practices'])],
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

  it('general reviewers never count as specialists despite their all-category focus', () => {
    const f = mkF();
    const reviews = [mkReview('m1', 'general', [f]), mkReview('m2', 'general', [f])];
    const groups = [
      mkGroup(f, [
        { finding: f, model: 'm1', role: 'general' },
        { finding: f, model: 'm2', role: 'general' },
      ]),
    ];

    const [result] = computeConsensus(groups, reviews, ROLES);

    // diversity 0.75 (2/2 models, 1 role), relevance 0.5 (no specialist
    // confirmation), isolation 0.5 (no specialized security reviewer ran).
    // Counting generals as specialists would score this 0.9.
    expect(result!.consensus.confidence).toBeCloseTo(0.6);
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

  it('saturates at half the fleet: 3-of-6 models scores like 2-of-2', () => {
    const f = mkF();
    const setup = (totalModels: number, flagging: number) => {
      const reviews = Array.from({ length: totalModels }, (_, i) =>
        mkReview(`m${i + 1}`, 'general', i < flagging ? [f] : [])
      );
      const groups = [
        mkGroup(
          f,
          Array.from({ length: flagging }, (_, i) => ({
            finding: f,
            model: `m${i + 1}`,
            role: 'general',
          }))
        ),
      ];
      return computeConsensus(groups, reviews, ROLES)[0]!;
    };

    // Larger fleets must not systematically depress confidence: half the
    // fleet agreeing earns full model-diversity credit either way
    expect(setup(6, 3).consensus.confidence).toBeCloseTo(setup(2, 2).consensus.confidence);
    // ...while below half it still discriminates
    expect(setup(6, 1).consensus.confidence).toBeLessThan(setup(6, 3).consensus.confidence);
  });
});

describe('computeConsensus — severity', () => {
  function reviewerSetup(severities: Array<Finding['severity']>) {
    const findings = severities.map((severity, i) =>
      mkF({ id: `f${i}`, severity, category: 'best-practices' })
    );
    const reviews = findings.map((f, i) => mkReview(`m${i + 1}`, `bp-${i + 1}`, [f]));
    // Representative is the highest-severity member, matching the deduper's choice
    const severityOrder = { critical: 0, important: 1, minor: 2, nitpick: 3 };
    const rep = [...findings].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])[0]!;
    const groups = [
      mkGroup(
        rep,
        findings.map((finding, i) => ({ finding, model: `m${i + 1}`, role: `bp-${i + 1}` }))
      ),
    ];
    return computeConsensus(groups, reviews, ROLES)[0]!;
  }

  it('a unanimous nitpick stays a nitpick', () => {
    const result = reviewerSetup(['nitpick', 'nitpick', 'nitpick']);

    expect(result.consensus.confidenceLabel).toBe('Very High');
    expect(result.severity).toBe('nitpick');
    expect(result.consensus.elevated).toBe(false);
    expect(result.consensus.elevation).toBe('none');
  });

  it('a single outlier rating never drives the final severity', () => {
    const result = reviewerSetup(['critical', 'minor', 'minor']);

    // Only one member said critical — the mode (minor) stands, and the
    // disagreement is surfaced as a dispute instead of an elevation
    expect(result.severity).toBe('minor');
    expect(result.consensus.elevated).toBe(false);
    expect(result.consensus.elevation).toBe('none');
    expect(result.consensus.disputed).toBe(true);
    expect(result.consensus.disputeDetails).toContain('severity');
  });

  it('elevates to the most severe level at least two members assigned', () => {
    const result = reviewerSetup(['critical', 'critical', 'minor', 'minor', 'minor']);

    // mode = minor (3 votes), but critical has 2 independent supporters;
    // Very High confidence resolves the disagreement upward
    expect(result.severity).toBe('critical');
    expect(result.consensus.elevated).toBe(true);
    expect(result.consensus.original_severity).toBe('minor');
    expect(result.consensus.elevation).toBe('strong-consensus');
    expect(result.consensus.disputed).toBe(true);
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

describe('computeConsensus — reviewer vote uniqueness', () => {
  it('counts severity votes per (model, role) reviewer, not per member', () => {
    // m1 rated the same issue critical twice (bridged variants); m2 and m3
    // each said minor. Per-member counting would give critical a 2-2 tie
    // (resolved toward critical); per-reviewer it is 1 critical vs 2 minor.
    const f1 = mkF({ id: 'x1', severity: 'critical', category: 'best-practices' });
    const f2 = mkF({ id: 'x2', severity: 'critical', category: 'best-practices' });
    const f3 = mkF({ id: 'x3', severity: 'minor', category: 'best-practices' });
    const f4 = mkF({ id: 'x4', severity: 'minor', category: 'best-practices' });
    const reviews = [
      mkReview('m1', 'bp-1', [f1, f2]),
      mkReview('m2', 'bp-2', [f3]),
      mkReview('m3', 'bp-3', [f4]),
    ];
    const groups = [
      mkGroup(f1, [
        { finding: f1, model: 'm1', role: 'bp-1' },
        { finding: f2, model: 'm1', role: 'bp-1' },
        { finding: f3, model: 'm2', role: 'bp-2' },
        { finding: f4, model: 'm3', role: 'bp-3' },
      ]),
    ];

    const [result] = computeConsensus(groups, reviews, ROLES);

    expect(result!.severity).toBe('minor');
    expect(result!.consensus.score).toBe(3);
    expect(result!.consensus.disputed).toBe(true);
  });
});

describe('computeConsensus — disputes', () => {
  it('treats unrecognized severities as least severe, not phantom-critical', () => {
    // severityIndex(-1) fed into Math.min used to read an unknown severity
    // as MORE severe than critical, fabricating a dispute nobody voiced
    const f1 = mkF({ id: 'f1', severity: 'blocker' as Finding['severity'] });
    const f2 = mkF({ id: 'f2', severity: 'nitpick' });
    const reviews = [mkReview('m1', 'general', [f1]), mkReview('m2', 'general', [f2])];
    const groups = [
      mkGroup(f2, [
        { finding: f1, model: 'm1', role: 'general' },
        { finding: f2, model: 'm2', role: 'general' },
      ]),
    ];

    const [result] = computeConsensus(groups, reviews, ROLES);

    expect(result!.consensus.disputed).toBeUndefined();
    expect(result!.severity).toBe('nitpick');
  });

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

  it('flags opposing conclusions between members of the same group', () => {
    // Generic pairs (lacks/has) don't veto merging — the contradiction must
    // surface as an intra-group dispute instead
    const f1 = mkF({ id: 'f1', title: 'Function lacks error handling' });
    const f2 = mkF({ id: 'f2', title: 'Function has error handling gaps' });
    const reviews = [mkReview('m1', 'general', [f1]), mkReview('m2', 'general', [f2])];
    const groups = [
      mkGroup(f1, [
        { finding: f1, model: 'm1', role: 'general' },
        { finding: f2, model: 'm2', role: 'general' },
      ]),
    ];

    const [result] = computeConsensus(groups, reviews, ROLES);

    expect(result!.consensus.disputed).toBe(true);
    expect(result!.consensus.disputeDetails).toContain('opposing conclusions');
  });

  it('does not flag unrelated groups whose text incidentally contains opposing terms', () => {
    // Different issues on nearby lines: one description mentions "present",
    // the other "missing" — without a same-thing gate this was a false dispute
    const f1 = mkF({
      id: 'f1',
      title: 'Severity dispersion hides conflicts',
      description: 'When both signals are present only one is reported',
    });
    const f2 = mkF({
      id: 'f2',
      title: 'Line window ignores configuration',
      description: 'Custom thresholds lead to missing disputes downstream',
      startLine: 12,
      endLine: 12,
    });
    const reviews = [mkReview('m1', 'general', [f1]), mkReview('m2', 'general', [f2])];
    const groups = [
      mkGroup(f1, [{ finding: f1, model: 'm1', role: 'general' }]),
      mkGroup(f2, [{ finding: f2, model: 'm2', role: 'general' }]),
    ];

    const results = computeConsensus(groups, reviews, ROLES);

    expect(results[0]!.consensus.disputed).toBeUndefined();
    expect(results[1]!.consensus.disputed).toBeUndefined();
  });

  it('honors a configured line window for cross-group dispute detection', () => {
    const f1 = mkF({ id: 'f1', title: 'Missing input validation', startLine: 10, endLine: 10 });
    const f2 = mkF({ id: 'f2', title: 'Input validation present', startLine: 25, endLine: 25 });
    const reviews = [mkReview('m1', 'general', [f1]), mkReview('m2', 'general', [f2])];
    const groups = [
      mkGroup(f1, [{ finding: f1, model: 'm1', role: 'general' }]),
      mkGroup(f2, [{ finding: f2, model: 'm2', role: 'general' }]),
    ];

    // 15 lines apart: outside the default window of 5...
    const defaults = computeConsensus(groups, reviews, ROLES);
    expect(defaults[0]!.consensus.disputed).toBeUndefined();

    // ...and still outside a window of 10 — the window must not be applied
    // to both sides (10 + 10 ≥ 15 was the old doubled behavior)
    const stillOutside = computeConsensus(groups, reviews, ROLES, { lineWindow: 10 });
    expect(stillOutside[0]!.consensus.disputed).toBeUndefined();

    // ...but inside a configured window of 15
    const widened = computeConsensus(groups, reviews, ROLES, { lineWindow: 15 });
    expect(widened[0]!.consensus.disputed).toBe(true);
  });

  it('collects multiple dispute reasons instead of short-circuiting', () => {
    // Group with 2+ level severity dispersion AND a conflicting neighbor group
    const f1 = mkF({ id: 'f1', title: 'Missing input validation', severity: 'critical' });
    const f2 = mkF({ id: 'f2', title: 'Missing validation of input', severity: 'nitpick' });
    const f3 = mkF({ id: 'f3', title: 'Input validation present', startLine: 11, endLine: 11 });
    const reviews = [
      mkReview('m1', 'general', [f1]),
      mkReview('m2', 'general', [f2]),
      mkReview('m3', 'general', [f3]),
    ];
    const groups = [
      mkGroup(f1, [
        { finding: f1, model: 'm1', role: 'general' },
        { finding: f2, model: 'm2', role: 'general' },
      ]),
      mkGroup(f3, [{ finding: f3, model: 'm3', role: 'general' }]),
    ];

    const [result] = computeConsensus(groups, reviews, ROLES);

    expect(result!.consensus.disputed).toBe(true);
    expect(result!.consensus.disputeDetails).toContain('severity');
    expect(result!.consensus.disputeDetails).toContain('Conflicting');
  });
});
