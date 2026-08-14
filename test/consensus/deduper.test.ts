import { describe, it, expect } from 'vitest';
import {
  jaccardSimilarity,
  combinedSimilarity,
  conceptSimilarity,
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

  it('preserves non-ASCII tokens', () => {
    // ASCII-only tokenization emptied both sets, scoring unrelated
    // non-English findings as identical (1.0)
    expect(jaccardSimilarity('验证缺失', '验证缺失')).toBe(1.0);
    expect(jaccardSimilarity('验证缺失', 'проверка отсутствует')).toBe(0.0);
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

  it('caps the cross-category threshold at 0.9', () => {
    // A configured threshold of 0.7 would put the cross-category bar at
    // 1.05 — near-identical (not just token-identical) findings must still
    // be able to merge
    const a = mkF({
      title: 'missing null check on user data values in parser',
      category: 'correctness',
    });
    const b = mkF({
      id: 'b1',
      title: 'missing null check on user data values',
      category: 'best-practices',
    });
    const reviews = [mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])];
    expect(deduplicateFindings(reviews, 0.7)).toHaveLength(1);
  });
});

describe('deduplicateFindings — line window semantics', () => {
  it('merges findings exactly window lines apart', () => {
    // gap of exactly 5 lines with the default window of 5
    const a = mkF({ id: 'a', startLine: 10, endLine: 10 });
    const b = mkF({ id: 'b', startLine: 15, endLine: 15 });
    const reviews = [mkReview('m1', 'r1', [a]), mkReview('m2', 'r2', [b])];
    expect(deduplicateFindings(reviews)).toHaveLength(1);
  });

  it('does not merge findings beyond the window — the window is not applied to both sides', () => {
    // gap of 6 lines: outside window 5. Expanding BOTH ranges by the window
    // (the old behavior) would have merged anything up to 10 lines apart.
    const a = mkF({ id: 'a', startLine: 10, endLine: 10 });
    const b = mkF({ id: 'b', startLine: 16, endLine: 16 });
    const reviews = [mkReview('m1', 'r1', [a]), mkReview('m2', 'r2', [b])];
    expect(deduplicateFindings(reviews)).toHaveLength(2);
  });
});

describe('deduplicateFindings — same-reviewer collapse', () => {
  it('collapses same-reviewer variants that a bridge finding pulls into one group', () => {
    // a1 and a2 (same review) are pairwise dissimilar, but b bridges both.
    // The final group must count m1/r1 once, or one model's repeated
    // finding masquerades as independent confirmation.
    const a1 = mkF({ id: 'a1', title: 'alpha beta gamma three', description: '', severity: 'minor' });
    const a2 = mkF({ id: 'a2', title: 'delta epsilon zeta three', description: '', severity: 'minor' });
    const b = mkF({
      id: 'b',
      title: 'alpha beta gamma delta epsilon zeta three',
      description: '',
      severity: 'critical',
    });
    const reviews = [mkReview('m1', 'r1', [a1, a2]), mkReview('m2', 'r2', [b])];

    const groups = deduplicateFindings(reviews);

    expect(groups).toHaveLength(1);
    const keys = groups[0]!.members.map((m) => `${m.model}::${m.role}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(groups[0]!.members).toHaveLength(2);
  });
});

describe('deduplicateFindings — corroborated location clusters', () => {
  const variants = [
    mkF({ id: 'a', title: 'Icon name match is an unclosed prefix, not an exact name', description: 'Prefix accepts alpha variant.', suggestedFix: 'Require an exact quoted alpha match.', category: 'tests' }),
    mkF({ id: 'b', title: 'Partial icon-name match can still collide with similarly-prefixed icons', description: 'Prefix allows beta collision.', suggestedFix: 'Require an exact quoted beta match.', category: 'tests' }),
    mkF({ id: 'c', title: 'Icon-name scoping pattern is incomplete and can match the wrong log line', description: 'Prefix matches gamma scope.', suggestedFix: 'Require an exact quoted gamma match.', category: 'tests' }),
  ];

  it('merges weakly worded location matches when three distinct models corroborate them', () => {
    expect(combinedSimilarity(variants[0]!, variants[1]!)).toBeLessThan(0.3);
    const groups = deduplicateFindings([
      mkReview('m1', 'general', [variants[0]!]),
      mkReview('m2', 'tests', [variants[1]!]),
      mkReview('m3', 'edge-cases', [variants[2]!]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(3);
  });

  it('does not treat only two reviewer assignments as corroboration', () => {
    const groups = deduplicateFindings([
      mkReview('m1', 'general', [variants[0]!]),
      mkReview('m2', 'edge-cases', [variants[1]!]),
    ]);

    expect(groups).toHaveLength(2);
  });

  it('keeps a runtime nil defect separate from a neighboring typespec defect', () => {
    const runtime = [
      mkF({ id: 'r1', title: 'nil terms fall through to custom behavior', description: 'A nil value selects the wrong runtime branch.', suggestedFix: 'Handle nil before custom terms.', category: 'correctness' }),
      mkF({ id: 'r2', title: 'custom branch incorrectly handles nil terms', description: 'The nil input reaches incorrect runtime behavior.', suggestedFix: 'Add an explicit nil branch.', category: 'correctness' }),
      mkF({ id: 'r3', title: 'nil input takes the wrong behavior path', description: 'Runtime handling sends nil through the custom path.', suggestedFix: 'Treat nil as the default case.', category: 'correctness' }),
    ];
    const contracts = [
      mkF({ id: 's1', title: '@spec omits the reachable nil return', description: 'The return type excludes nil.', suggestedFix: 'Add nil to the @spec.', category: 'correctness' }),
      mkF({ id: 's2', title: 'Typespec excludes a possible nil result', description: 'The declared return type cannot represent nil.', suggestedFix: 'Widen the typespec with nil.', category: 'correctness' }),
      mkF({ id: 's3', title: 'Return type should include nil', description: 'The @spec is narrower than the nil result.', suggestedFix: 'Declare the nil return type.', category: 'correctness' }),
    ];
    const groups = deduplicateFindings([
      ...runtime.map((finding, index) => mkReview(`runtime-${index}`, 'general', [finding])),
      ...contracts.map((finding, index) => mkReview(`contract-${index}`, 'general', [finding])),
    ]);

    const runtimeGroup = groups.find((group) =>
      group.members.some((member) => member.finding.id === 'r1')
    );
    const contractGroup = groups.find((group) =>
      group.members.some((member) => member.finding.id === 's1')
    );
    expect(runtimeGroup).toBeDefined();
    expect(contractGroup).toBeDefined();
    expect(runtimeGroup).not.toBe(contractGroup);
  });

  it('is deterministic when review order changes', () => {
    const reviews = [
      mkReview('m1', 'general', [variants[0]!]),
      mkReview('m2', 'tests', [variants[1]!]),
      mkReview('m3', 'edge-cases', [variants[2]!]),
    ];
    const signature = (ordered: ModelReview[]) => deduplicateFindings(ordered).map((group) =>
      group.members.map((member) => member.finding.id).sort().join(',')
    ).sort();

    expect(signature(reviews)).toEqual(signature([...reviews].reverse()));
  });
});

describe('conceptSimilarity — taxonomy boost', () => {
  it('boosts same-concept findings at the same location regardless of wording', () => {
    const a = mkF({
      title: 'IDOR: missing authorization on DELETE endpoint',
      description: 'Any authenticated user can delete arbitrary accounts.',
      startLine: 14,
      endLine: 17,
    });
    const b = mkF({
      id: 'b1',
      title: 'Missing authorization check allows any user to delete any account',
      description: 'The handler never verifies ownership before deleting.',
      startLine: 14,
      endLine: 20,
    });
    expect(conceptSimilarity(a, b)).toBeGreaterThanOrEqual(0.8);
  });

  it('is location-gated: same concept in nearby but non-overlapping ranges gets no boost', () => {
    // Two DIFFERENT sql injections 2 lines apart must not be asserted
    // same-instance by concept alone
    const a = mkF({
      title: 'SQL injection in buildUserQuery',
      description: 'Username concatenated into the SELECT statement.',
      startLine: 10,
      endLine: 12,
    });
    const b = mkF({
      id: 'b1',
      title: 'SQL injection in buildOrderQuery',
      description: 'OrderId interpolated into the SQL string.',
      startLine: 14,
      endLine: 16,
    });
    expect(conceptSimilarity(a, b)).toBe(0);
  });

  it('returns 0 when concepts differ', () => {
    const sqli = mkF({ title: 'SQL injection in DELETE endpoint', description: 'x' });
    const idor = mkF({ id: 'b1', title: 'IDOR on DELETE endpoint', description: 'y' });
    expect(conceptSimilarity(sqli, idor)).toBe(0);
  });

  it('matches punctuation-adjacent phrases like CWE ids', () => {
    // Raised (and disputed) by the dogfood council: \b must still match
    // when the phrase sits against parentheses/punctuation in the text.
    // (A build-time guard rejects taxonomy phrases that don't start/end on
    // word characters, where \b would misbehave.)
    const a = mkF({ title: 'Query concatenation (CWE-89) in handler', description: 'x' });
    const b = mkF({ id: 'b1', title: 'String interpolation into SQL, CWE-89.', description: 'y' });
    expect(conceptSimilarity(a, b)).toBeGreaterThanOrEqual(0.8);
  });

  it('matches multi-word phrases across line wraps and extra whitespace', () => {
    // Surfaced by `rcl discuss` with the models that flagged the taxonomy
    // regexes: literal single-space phrases missed wrapped occurrences.
    const a = mkF({ title: 'Unescaped output', description: 'Classic cross-site\n   scripting vector.' });
    const b = mkF({ id: 'b1', title: 'XSS in template', description: 'y' });
    expect(conceptSimilarity(a, b)).toBeGreaterThanOrEqual(0.8);
  });

  it('matches phrases at word boundaries, not substrings', () => {
    // "unsafe" must not trigger via "safe"; "authorization check" must not
    // fire on the bare word "auth" the way substring taxonomies do
    const a = mkF({ title: 'OAuth flow refactor', description: 'Moves the oauthor module.' });
    const b = mkF({ id: 'b1', title: 'Authentication tidy-up', description: 'Renames helpers.' });
    expect(conceptSimilarity(a, b)).toBe(0);
  });

  it('grows with additional shared concepts, capped at 1.0', () => {
    const a = mkF({
      title: 'SQL injection and XSS in render path',
      description: 'Unescaped user input reaches both the query and the DOM.',
    });
    const b = mkF({
      id: 'b1',
      title: 'XSS and SQL injection in the same handler',
      description: 'Template and query both take raw input.',
    });
    const one = conceptSimilarity(
      mkF({ title: 'SQL injection here', description: 'x' }),
      mkF({ id: 'c1', title: 'SQL injection there', description: 'y' })
    );
    expect(one).toBeCloseTo(0.8);
    expect(conceptSimilarity(a, b)).toBeCloseTo(0.85);
  });
});

describe('deduplicateFindings — taxonomy boost integration', () => {
  it('merges differently-worded same-concept duplicates that token similarity splits', () => {
    const a = mkF({
      title: 'IDOR: missing authorization on DELETE endpoint',
      description: 'Any authenticated user can delete arbitrary accounts by id.',
      startLine: 14,
      endLine: 17,
      severity: 'important',
    });
    const b = mkF({
      id: 'b1',
      title: 'Missing ownership check allows account takeover via delete',
      description: 'The route handler trusts the request user id.',
      startLine: 14,
      endLine: 20,
      severity: 'critical',
    });
    // Token similarity alone splits this pair (that is the calibration gap
    // this feature closes); the concept boost merges it
    expect(combinedSimilarity(a, b)).toBeLessThan(0.3);
    const groups = deduplicateFindings([mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toHaveLength(2);
  });

  it('opposing conclusions still veto a concept-boosted merge', () => {
    const a = mkF({
      title: 'SQL injection risk is missing input escaping',
      description: 'Query is vulnerable to sql injection.',
    });
    const b = mkF({
      id: 'b1',
      title: 'SQL injection protection present via input escaping',
      description: 'Escaping makes sql injection impossible here.',
    });
    const groups = deduplicateFindings([mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])]);
    expect(groups).toHaveLength(2);
  });

  it('keeps two different same-concept findings in nearby lines separate', () => {
    const a = mkF({
      title: 'Hardcoded password for postgres',
      description: 'Connection string embeds a hardcoded password.',
      file: 'src/config.ts',
      startLine: 5,
      endLine: 5,
    });
    const b = mkF({
      id: 'b1',
      title: 'Hardcoded API key for payment provider',
      description: 'A live key sits next to the database settings.',
      file: 'src/config.ts',
      startLine: 8,
      endLine: 8,
    });
    const groups = deduplicateFindings([mkReview('m1', 'general', [a]), mkReview('m2', 'general', [b])]);
    expect(groups).toHaveLength(2);
  });
});

describe('deduplicateFindings — fixture corpus ground truth', () => {
  // The corpus is the judge (RCL-9): these are the human-labeled duplicate
  // clusters across the three fixture reviews. Baseline token similarity
  // reached recall 0.70 here (missing c004|g004, g004|gem005, c005|g005);
  // the taxonomy boost reaches 1.00 at precision 1.00.
  const TRUTH: string[][] = [
    ['c001', 'gem001', 'g001'], // hardcoded JWT secret
    ['c002', 'gem003'], // SQLi in getUserData
    ['c003', 'gem002'], // admin check uses username instead of role
    ['c004', 'gem005', 'g004'], // IDOR / missing authz on DELETE
    ['gem004', 'g003'], // SQLi in DELETE endpoint
    ['c005', 'g005'], // pagination / unbounded query
    ['g002'], // any-cast singleton
  ];

  function loadFixture(file: string, model: string): ModelReview {
    const raw = JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8')) as {
      findings: Finding[];
    };
    return { model, role: 'general', provider: 'test', findings: raw.findings, durationMs: 0, status: 'success' };
  }

  it('reproduces the ground-truth clustering exactly (precision 1.0, recall 1.0)', () => {
    const groups = deduplicateFindings([
      loadFixture('review-claude.json', 'claude'),
      loadFixture('review-gemini.json', 'gemini'),
      loadFixture('review-gpt.json', 'gpt'),
    ]);
    const predicted = groups
      .map((g) => g.members.map((m) => m.finding.id).sort())
      .sort((x, y) => x[0]!.localeCompare(y[0]!));
    const expected = TRUTH.map((c) => [...c].sort()).sort((x, y) => x[0]!.localeCompare(y[0]!));
    expect(predicted).toEqual(expected);
  });
});

describe('deduplicateFindings — group coherence', () => {
  it('splits transitive chains whose ends are dissimilar', () => {
    // Identical text, but lines 1 / 6 / 11 with window 5:
    // A overlaps B, B overlaps C, A does not overlap C
    const a = mkF({ id: 'a', startLine: 1, endLine: 1 });
    const b = mkF({ id: 'b', startLine: 6, endLine: 6 });
    const c = mkF({ id: 'c', startLine: 11, endLine: 11 });
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
