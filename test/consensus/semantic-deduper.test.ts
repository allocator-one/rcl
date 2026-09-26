import { describe, expect, it } from 'vitest';
import { deduplicateSemanticFindings } from '../../src/consensus/semantic-deduper.js';
import { compareClaims, describeClaim } from '../../src/consensus/claim-identity.js';
import type { Finding, ModelReview } from '../../src/consensus/types.js';
import { readFileSync } from 'node:fs';
import { ReviewerPairSchema } from '../../src/config/schema.js';
import { buildCustomRole } from '../../src/roles/loader.js';
import { buildExplicitAssignments } from '../../src/roles/dispatcher.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'cache', file: 'src/cache.ts', startLine: 10, endLine: 12,
    category: 'correctness', severity: 'important',
    title: 'Cache result survives expiry',
    description: 'The search cache returns expired entries without checking their expiry timestamp.',
    suggestedFix: 'Check the expiry timestamp before returning a cached result.',
    ...overrides,
  };
}

function review(model: string, findings: Finding[]): ModelReview {
  return { model, role: 'general', provider: 'test', status: 'success', durationMs: 0, findings };
}

const signature = (reviews: ModelReview[]) => deduplicateSemanticFindings(reviews).map(group => ({
  representative: group.representative.id,
  severity: group.representative.severity,
  members: group.members.map(member => `${member.model}:${member.finding.id}`).sort(),
}));

describe('semantic deduplication before report serialization', () => {
  it('preserves distinct configured reviewer tuples containing delimiters while counting each tuple once', () => {
    const pairs = [{ model: 'local::variant', role: 'general' }, { model: 'local', role: 'variant::general' }]
      .map(pair => ReviewerPairSchema.parse(pair));
    const roles = pairs.map(pair => buildCustomRole({ name: pair.role }));
    const assignments = buildExplicitAssignments(pairs, new Map(roles.map(role => [role.name, role])));
    expect(assignments).toHaveLength(2);
    const reviews = assignments.map(({ model, role, provider }) => ({
      ...review(model, [finding(), finding({ id: 'stronger', severity: 'critical' })]), role: role.name, provider,
    }));
    const before = JSON.stringify(reviews);
    const groups = deduplicateSemanticFindings(reviews);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map(({ model, role }) => ({ model, role })))
      .toEqual(expect.arrayContaining(pairs));
    expect(groups[0]!.members).toHaveLength(2);
    expect(groups[0]!.members.every(member => member.finding.severity === 'critical')).toBe(true);
    expect(JSON.stringify(reviews)).toBe(before);
  });
  it.each(['category', 'location provenance'] as const)('breaks representative ties deterministically by %s', field => {
    const a = finding();
    const b = field === 'category' ? { ...a, category: 'security' as const } : { ...a,
      locationProvenance: { version: 1 as const, source: 'parser' as const, reason: 'reversed_range' as const,
        originalStartLine: a.endLine, originalEndLine: a.startLine } };
    const forward = deduplicateSemanticFindings([review('one', [a, b])]);
    const reversed = deduplicateSemanticFindings([review('one', [b, a])]);
    expect(forward).toHaveLength(1);
    expect(reversed).toEqual(forward);
  });
  it('evaluates the current finding content on every invocation', () => {
    const a = finding();
    const b = finding({ id: 'other' });
    const reviews = [review('one', [a]), review('two', [b])];
    expect(deduplicateSemanticFindings(reviews)).toHaveLength(1);
    b.description += ' The cache must also reject entries from a different tenant.';
    expect(deduplicateSemanticFindings(reviews)).toHaveLength(2);
  });
  it('preserves the original CopyButton, Toast, and bounded-search independent allegations', () => {
    const { sightings } = JSON.parse(readFileSync(new URL('../fixtures/semantic-claims.json', import.meta.url), 'utf8'));
    for (const [left, right] of [[0, 2], [1, 3], [4, 5]]) {
      const a = { ...sightings[left!].original_finding, startLine: 10, endLine: 12 };
      const b = { ...sightings[right!].original_finding, startLine: 10, endLine: 12 };
      expect(deduplicateSemanticFindings([review('model', [a, b])])).toHaveLength(2);
    }
  });
  it.each([
    ['ios-44-r1-di-test-detection', 'Test-runner detection is DEBUG-only; release test plans hit the real Keychain', 'Environment-variable test detection is heuristic and can be spoofed/miss cases'],
    ['harness-cli-9-r16-empty-body-guard', 'Empty/whitespace comment rejected only for --body-file', 'Empty-file body passes for non-comment fields and may clear values on update'],
    ['ao-7484-r2-aria-checked-roles', 'Checked menu roles do not require aria-checked', 'menuitemradio role offered without any enforcement of radio-group semantics'],
  ])('keeps independent actionable claims in the %s legacy family separate', (file, left, right) => {
    const corpus = JSON.parse(readFileSync(new URL(`../fixtures/undermerge-corpus/${file}.json`, import.meta.url), 'utf8'));
    const groups = deduplicateSemanticFindings(corpus.reviews);
    const a = groups.find(group => group.members.some(member => member.finding.title === left));
    const b = groups.find(group => group.members.some(member => member.finding.title === right));
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });
  it('groups a supported paraphrase without a title-overlap floor and retains highest severity', () => {
    const original = finding();
    const paraphrase = finding({ id: 'paraphrase', severity: 'critical', startLine: 15, endLine: 16,
      title: 'Expired cache entries are returned',
      description: 'The search cache returns expired entries without checking the expiry timestamp.',
      suggestedFix: 'Check the expiry timestamp before returning the cached result.',
    });
    const reviews = [review('first', [original]), review('second', [paraphrase])];
    expect(signature(reviews)).toEqual([{ representative: 'paraphrase', severity: 'critical',
      members: ['first:cache', 'second:paraphrase'] }]);
    expect(signature([...reviews].reverse())).toEqual(signature(reviews));
  });

  it.each([
    ['numeric constraint', 'Reject status -3 after a transient failure.', 'Reject status 3 after a transient failure.'],
    ['quoted subject', 'The cache waits until `load_account()` completes.', 'The cache waits until `load_org()` completes.'],
    ['ordered condition', 'The cache returns entries before checking their expiry timestamp.', 'The cache returns entries after checking their expiry timestamp.'],
    ['bound direction', 'The cache bound lacks a lower clamp.', 'The cache bound lacks an upper clamp.'],
    ['negated obligation', 'The cache must return expired entries after validation.', 'The cache must not return expired entries after validation.'],
    ['quoted subject with elaboration', 'The cache waits until `load_account()` completes.', 'The cache patiently waits until `load_org()` completes.'],
    ['added constraint', 'The cache retries the request after a transient failure.', 'The cache retries the request at most 3 times after a transient failure.'],
  ])('preserves an independent %s despite identical titles and fixes', (_name, left, right) => {
    const a = finding({ id: 'a', description: left });
    const b = finding({ id: 'b', description: right, severity: 'critical' });
    expect(deduplicateSemanticFindings([review('same-reviewer', [a, b])])).toHaveLength(2);
    const reviewers = Array.from({ length: 6 }, (_, index) => review(`model-${index}`, [index < 3 ? a : b]));
    const groups = deduplicateSemanticFindings(reviewers);
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.members.length).sort()).toEqual([3, 3]);
    expect(signature(reviewers)).toEqual(signature([...reviewers].reverse()));
  });

  it('does not manufacture claim equivalence from taxonomy, location, or reviewer count', () => {
    const reviews = Array.from({ length: 6 }, (_, index) => review(`model-${index}`, [finding({
      id: `claim-${index}`, title: `SQL injection in helper_${index}`,
      description: `The query interpolates \`argument_${index}\` without parameterization.`,
      suggestedFix: 'Parameterize the query before executing it.',
    })]));
    expect(deduplicateSemanticFindings(reviews)).toHaveLength(6);
  });

  it('keeps weak title-only agreement ambiguous even when it reaches the consensus gate', () => {
    const variants = ['alpha amber cobalt delta', 'bravo bronze cyan dune', 'charlie copper crimson drift', 'denver diamond cerulean dusk'];
    const reviews = [0, 0, 1, 1, 2, 3].map((variant, index) => review(`model-${index}`, [finding({
      id: `claim-${index}`, title: `Parser failure ${variants[variant]}`, description: '', suggestedFix: undefined,
    })]));
    expect(deduplicateSemanticFindings(reviews, 0.1, 5, 0.4)).toHaveLength(6);
  });

  it('chooses a deterministic representative and counts a repeated reviewer once', () => {
    const a = finding({ id: 'a' });
    const b = finding({ id: 'b' });
    const reviews = [review('same', [b, a]), review('other', [finding({ id: 'c' })])];
    const groups = deduplicateSemanticFindings(reviews);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.representative.id).toBe('a');
    expect(groups[0]!.members).toHaveLength(2);
    expect(signature(reviews)).toEqual(signature([...reviews].reverse().map(item => ({ ...item, findings: [...item.findings].reverse() }))));
  });
});

it('preserves every raw assertion and counts one vote per model-role assignment', () => {
  const reviews = [review('same', [finding({id:'a'}), finding({id:'b',severity:'critical'})]),
    { ...review('same', [finding({id:'c'})]),role:'security' },review('other', [finding({id:'d'})])];
  const original = JSON.stringify(reviews);
  const groups = deduplicateSemanticFindings(reviews);
  expect(groups).toHaveLength(1);
  expect(groups[0]!.members).toHaveLength(3);
  expect(groups[0]!.representative.id).toBe('b');
  expect(new Set(groups[0]!.members.map(m=>`${m.model}::${m.role}`)).size).toBe(3);
  expect(JSON.stringify(reviews)).toBe(original);
});
it('keeps an ambiguous bridge separate from two incompatible established claims', () => {
  const fix = 'Validate cached record expiry timestamp before returning stored request result';
  const a = finding({id:'a',title:'Cache',severity:'critical',suggestedFix:`${fix} alpha beta gamma delta.`});
  const b = finding({id:'b',title:'Cache',severity:'critical',suggestedFix:`${fix} epsilon zeta eta theta.`});
  const bridge = finding({id:'bridge',title:'Cache',suggestedFix:`${fix} alpha beta epsilon zeta.`});
  expect(compareClaims(describeClaim(a),describeClaim(b))).toBeUndefined();
  expect(compareClaims(describeClaim(a),describeClaim(bridge))).toBeDefined();
  expect(compareClaims(describeClaim(b),describeClaim(bridge))).toBeDefined();
  const reviews = [review('a',[a]),review('b',[b]),review('bridge',[bridge])];
  const groups = deduplicateSemanticFindings(reviews);
  expect(groups).toHaveLength(3);
  expect(deduplicateSemanticFindings([...reviews].reverse())).toEqual(groups);
});
