import type { Finding, ModelReview, DeduplicatedGroup } from './types.js';
import { DEFAULT_THRESHOLDS } from '../config/defaults.js';

/** Title similarity carries more signal than description similarity. */
const TITLE_WEIGHT = 0.6;
const DESC_WEIGHT = 0.4;

/**
 * Common English function words that carry no similarity signal.
 * Negations (no, not, never) are deliberately kept — they distinguish
 * opposite findings.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'with', 'as', 'by', 'from', 'into',
  'via', 'when', 'which', 'their', 'there', 'than', 'then',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      // Unicode-aware: keep letters/numbers in all scripts — an ASCII-only
      // filter would tokenize non-English findings to empty sets, which
      // read as identical (similarity 1.0) and merge unrelated findings
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  );
}

function jaccardOfSets(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * Compute Jaccard similarity between two strings (word-level tokenization).
 * Single characters and stopwords are ignored; short signal tokens like
 * "xss", "id", or "no" are kept.
 */
export function jaccardSimilarity(a: string, b: string): number {
  return jaccardOfSets(tokenize(a), tokenize(b));
}

/**
 * Weighted title+description similarity. Both fields contribute, so a short
 * generic title alone can no longer merge two unrelated findings, and a
 * verbose description alone can't either.
 *
 * A field where either side has no usable tokens carries no signal and is
 * excluded, with weights renormalized over the remaining fields — empty
 * descriptions neither grant free similarity nor penalize a strong title
 * match. If no field has usable tokens on both sides, similarity is 0.
 */
export function combinedSimilarity(a: Finding, b: Finding): number {
  const fields = [
    { weight: TITLE_WEIGHT, a: tokenize(a.title), b: tokenize(b.title) },
    { weight: DESC_WEIGHT, a: tokenize(a.description), b: tokenize(b.description) },
  ].filter((f) => f.a.size > 0 && f.b.size > 0);

  const totalWeight = fields.reduce((sum, f) => sum + f.weight, 0);
  if (totalWeight === 0) return 0;

  return fields.reduce((sum, f) => sum + jaccardOfSets(f.a, f.b) * f.weight, 0) / totalWeight;
}

interface OpposingPair {
  a: RegExp;
  b: RegExp;
  /**
   * Specific pairs express a real contradiction about the same predicate and
   * are checked in titles and descriptions, and are eligible to veto merges.
   * Generic pairs (common verbs/particles like no/has, not/is) are too noisy
   * for that — they are checked in titles only, and only used to flag
   * disputes, never to block a merge.
   */
  specific: boolean;
}

function term(t: string): RegExp {
  return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

const OPPOSING_PAIRS: OpposingPair[] = [
  { a: term('missing'), b: term('present'), specific: true },
  { a: term('no'), b: term('has'), specific: false },
  { a: term('lacks'), b: term('has'), specific: false },
  { a: term('not'), b: term('is'), specific: false },
  { a: term('should add'), b: term('should remove'), specific: true },
  { a: term('too complex'), b: term('too simple'), specific: true },
  { a: term('over-engineered'), b: term('under-engineered'), specific: true },
  { a: term('unnecessary'), b: term('necessary'), specific: true },
  { a: term('remove'), b: term('keep'), specific: false },
  { a: term('redundant'), b: term('required'), specific: true },
  { a: term('unsafe'), b: term('safe'), specific: true },
  { a: term('deprecated'), b: term('recommended'), specific: true },
  { a: term('too permissive'), b: term('too restrictive'), specific: true },
];

function textOpposes(
  textA: string,
  textB: string,
  inDescription: boolean,
  specificOnly: boolean
): boolean {
  for (const pair of OPPOSING_PAIRS) {
    if (inDescription && !pair.specific) continue;
    if (specificOnly && !pair.specific) continue;
    const aHasA = pair.a.test(textA);
    const aHasB = pair.b.test(textA);
    const bHasA = pair.a.test(textB);
    const bHasB = pair.b.test(textB);
    // Exclusive containment: each text must contain exactly one term of the
    // pair, and opposite ones. A text containing both terms ("is not …")
    // takes no position and never counts as opposing.
    if ((aHasA && !aHasB && bHasB && !bHasA) || (aHasB && !aHasA && bHasA && !bHasB)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect findings that reach opposite conclusions. Word-boundary matching
 * prevents substring traps ("unsafe" does not match "safe").
 *
 * With `specificOnly`, only high-precision pairs count — used for the merge
 * veto, where a false positive fragments a genuine duplicate group. The
 * default (all pairs) is for dispute flagging, where a false positive just
 * adds a warning.
 */
export function hasOpposingSentiment(a: Finding, b: Finding, specificOnly = false): boolean {
  if (textOpposes(a.title, b.title, false, specificOnly)) return true;
  if (textOpposes(a.description, b.description, true, specificOnly)) return true;
  return false;
}

/**
 * Concept taxonomy for cross-model dedup. Models phrase the same issue so
 * differently that genuine duplicates score only 0.29–0.55 on token
 * similarity (see jaccardThreshold calibration note in config/defaults.ts).
 * When two findings at the SAME location both name the same issue concept,
 * that is stronger evidence of duplication than their wording overlap.
 *
 * Phrases are matched at word boundaries — single generic words ("query",
 * "input", "auth") are deliberately absent because substring taxonomies
 * merge strangers. Calibrated against the fixture corpus in test/fixtures.
 */
const ISSUE_CONCEPTS: Record<string, string[]> = {
  sql_injection: ['sql injection', 'sqli', 'cwe-89'],
  xss: ['xss', 'cross-site scripting', 'cwe-79'],
  command_injection: ['command injection', 'shell injection', 'cwe-78', 'rce'],
  hardcoded_secrets: [
    'hardcoded secret',
    'hardcoded credential',
    'hardcoded password',
    'hardcoded jwt',
    'secret key',
    'api key',
    'cwe-798',
  ],
  auth_bypass: [
    'idor',
    'authorization check',
    'ownership check',
    'auth bypass',
    'authentication bypass',
    'privilege escalation',
  ],
  weak_crypto: ['weak random', 'math.random', 'weak crypto', 'insecure random', 'cwe-338'],
  race_condition: ['race condition', 'toctou', 'pid reuse'],
  memory_leak: ['memory leak', 'unbounded cache', 'unbounded growth'],
  token_exposure: [
    'token exposure',
    'token leak',
    'key exposure',
    'exposed in command line',
    'exfiltration',
  ],
  missing_pagination: ['pagination', 'unbounded query', 'unbounded listing'],
};

const CONCEPT_MATCHERS = Object.entries(ISSUE_CONCEPTS).map(([concept, phrases]) => ({
  concept,
  patterns: phrases.map((p) => {
    // \b only works when the phrase starts and ends on word characters —
    // reject taxonomy entries that would silently never (or wrongly) match.
    if (!/^[\p{L}\p{N}].*[\p{L}\p{N}]$/u.test(p)) {
      throw new Error(`ISSUE_CONCEPTS phrase must start and end with a word character: "${p}"`);
    }
    // Spaces match any whitespace run so "cross-site\n  scripting" still
    // hits — a missed match only means falling back to token similarity
    // (under-merge), but there's no reason to be brittle about line wraps.
    return new RegExp(
      `\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}\\b`,
      'i'
    );
  }),
}));

/**
 * Concepts per finding are memoized: the deduper compares every pair, so
 * uncached extraction would run the full taxonomy regex scan O(n²·k) times.
 */
const conceptCache = new WeakMap<Finding, Set<string>>();

function extractConcepts(finding: Finding): Set<string> {
  const cached = conceptCache.get(finding);
  if (cached) return cached;
  const text = `${finding.title} ${finding.description}`;
  const out = new Set<string>();
  for (const { concept, patterns } of CONCEPT_MATCHERS) {
    if (patterns.some((re) => re.test(text))) out.add(concept);
  }
  conceptCache.set(finding, out);
  return out;
}

const CONCEPT_BOOST_BASE = 0.8;
const CONCEPT_BOOST_PER_EXTRA = 0.05;

/**
 * Concept-level similarity: 0.8+ when both findings name the same issue
 * concept AND their line ranges strictly overlap. Proximity within the
 * dedup window is deliberately NOT enough — two different SQL injections a
 * few lines apart share the concept but are different findings, and the
 * fixture corpus shows genuine cross-model duplicates point at overlapping
 * ranges. Benchmarked in the RCL-9 PR: fixture recall 0.70 → 1.00 at
 * precision 1.00, no new false merges on adversarial same-concept pairs
 * (the ungated code-council version added one).
 */
export function conceptSimilarity(a: Finding, b: Finding): number {
  if (!linesOverlap(a, b, 0)) return 0;
  const conceptsA = extractConcepts(a);
  if (conceptsA.size === 0) return 0;
  const conceptsB = extractConcepts(b);
  let overlap = 0;
  for (const c of conceptsA) if (conceptsB.has(c)) overlap++;
  if (overlap === 0) return 0;
  return Math.min(1.0, CONCEPT_BOOST_BASE + (overlap - 1) * CONCEPT_BOOST_PER_EXTRA);
}

interface TaggedFinding {
  finding: Finding;
  model: string;
  role: string;
}

export function linesOverlap(a: Finding, b: Finding, window: number): boolean {
  // Ranges overlap when the gap between them is at most `window` lines.
  // Expanding BOTH ranges by the window would double the configured
  // distance (a window of 5 merging findings 10 lines apart).
  return a.startLine - window <= b.endLine && b.startLine - window <= a.endLine;
}

function areSameFile(a: Finding, b: Finding): boolean {
  return a.file === b.file;
}

function sameCategory(a: Finding, b: Finding): boolean {
  return a.category === b.category;
}

/**
 * Models routinely disagree on category boundaries (correctness vs
 * best-practices, security vs correctness), so a category mismatch is
 * evidence that findings differ — not proof. Cross-category pairs may still
 * merge, but only on stronger text similarity.
 */
const CROSS_CATEGORY_FACTOR = 1.5;

function areDuplicates(
  a: Finding,
  b: Finding,
  jaccardThreshold: number,
  lineWindow: number
): boolean {
  if (!areSameFile(a, b)) return false;
  if (!linesOverlap(a, b, lineWindow)) return false;
  // Never merge findings that clearly reach opposite conclusions — they must
  // surface as separate (disputed) groups rather than silently collapse into
  // one. Only specific pairs veto; generic-pair contradictions merge and are
  // flagged as intra-group disputes by the voter instead.
  if (hasOpposingSentiment(a, b, true)) return false;

  // Cap at 0.9 so a high configured threshold can't silently make
  // cross-category merges (near-)impossible — a bar of 1.0 would only ever
  // match token-identical findings
  const threshold = sameCategory(a, b)
    ? jaccardThreshold
    : Math.min(0.9, jaccardThreshold * CROSS_CATEGORY_FACTOR);
  // max(): the concept boost can add merges token similarity misses, but
  // must never take one away that tokens alone would have made.
  return Math.max(combinedSimilarity(a, b), conceptSimilarity(a, b)) >= threshold;
}

/**
 * Choose the representative finding from a group:
 * - Prefer higher severity
 * - Break ties by description length (more detail wins)
 */
function chooseRepresentative(members: TaggedFinding[]): TaggedFinding {
  const severityOrder = { critical: 0, important: 1, minor: 2, nitpick: 3 };

  return members.reduce((best, curr) => {
    const bestScore = severityOrder[best.finding.severity];
    const currScore = severityOrder[curr.finding.severity];
    if (currScore < bestScore) return curr;
    if (currScore === bestScore && curr.finding.description.length > best.finding.description.length)
      return curr;
    return best;
  });
}

/**
 * Union-Find grouping with path compression.
 */
function groupTagged(
  items: TaggedFinding[],
  jaccardThreshold: number,
  lineWindow: number
): TaggedFinding[][] {
  const parent = items.map((_, i) => i);

  function find(i: number): number {
    if (parent[i] !== i) parent[i] = find(parent[i]!);
    return parent[i]!;
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (
        areDuplicates(items[i]!.finding, items[j]!.finding, jaccardThreshold, lineWindow)
      ) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent[rootJ] = rootI;
      }
    }
  }

  const groups = new Map<number, TaggedFinding[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const existing = groups.get(root) ?? [];
    existing.push(items[i]!);
    groups.set(root, existing);
  }
  return [...groups.values()];
}

/**
 * Union-Find is transitive: A≈B and B≈C put A and C in one group even when
 * A and C are dissimilar. Split such chains by greedily re-clustering around
 * representatives — every member of a final group is a duplicate of its
 * representative, not just of some neighbor.
 */
function splitIncoherent(
  members: TaggedFinding[],
  jaccardThreshold: number,
  lineWindow: number
): TaggedFinding[][] {
  const result: TaggedFinding[][] = [];
  let remaining = members;
  while (remaining.length > 0) {
    const rep = chooseRepresentative(remaining);
    const coherent: TaggedFinding[] = [];
    const rest: TaggedFinding[] = [];
    for (const m of remaining) {
      if (m === rep || areDuplicates(rep.finding, m.finding, jaccardThreshold, lineWindow)) {
        coherent.push(m);
      } else {
        rest.push(m);
      }
    }
    result.push(coherent);
    remaining = rest;
  }
  return result;
}

/**
 * Cross-model wording diverges much more than the ordinary pairwise dedup
 * threshold allows. A relaxed lexical edge is only safe when it is backed by
 * independent agreement: at least three distinct model-role assignments must participate in
 * the resulting location cluster. This turns agreement into evidence for a
 * merge without weakening the normal threshold for one- and two-model noise.
 *
 * The 0.20 title floor is calibrated against the RCL-17 production corpus.
 * A title edge also needs overlap in either the description or proposed fix;
 * title proximity alone is not enough to bridge separate defects at the same
 * lines. Weighted graph communities and a 2-core keep sparse lexical bridges
 * from merging a whole hunk. A fringe variant can join only when two different
 * reviewer assignments support one unambiguous corroborated community.
 */
const CORROBORATED_TITLE_THRESHOLD = 0.2; // title-token Jaccard
const CORROBORATED_DETAIL_THRESHOLD = 0.1; // description/fix token Jaccard
const CORROBORATED_MIN_REVIEWERS = 3; // distinct model::role assignments
const CORROBORATED_MIN_DENSITY = 0.2; // observed / possible relaxed edges
const CORROBORATED_ATTACHMENT_THRESHOLD = 0.12; // weighted title+description score
const CORROBORATED_ATTACHMENT_FIX_THRESHOLD = 0.15; // fix-token Jaccard for one-anchor variants
const CORROBORATED_ATTACHMENT_SUPPORT = 2; // distinct model::role assignments
const CORROBORATED_SINGLE_ANCHOR_SUPPORT = 3; // extra support for one-token bridges
const CORROBORATED_MAX_ATTACHMENT_ROUNDS = 2; // bound transitive fringe growth
const CORROBORATED_NEIGHBORHOOD_THRESHOLD = 0.11; // loose combined lexical partition
const CORROBORATED_NEIGHBORHOOD_DENSITY = 0.5; // observed / possible weak edges
const CORROBORATED_MAX_NEIGHBORHOOD_SPAN = 50; // broad file-level findings cannot bridge
const CORROBORATED_TIE_EPSILON = 1e-9;

const CORROBORATION_STOPWORDS = new Set([
  ...STOPWORDS,
  'all', 'allow', 'allows', 'any', 'can', 'could', 'did', 'do', 'does',
  'had', 'has', 'have', 'lacks', 'may', 'might', 'missing', 'new', 'no',
  'nil', 'not', 'now', 'only', 'same', 'should', 'still', 'use', 'used', 'uses',
  'using', 'will', 'without', 'would', 'code', 'function', 'issue', 'test', 'tests',
  'config', 'configuration', 'file', 'files', 'generated',
]);

function corroborationTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      // Preserve underscores inside identifiers. Splitting `trigger_label`
      // into two ordinary words lets a shared function name create a false
      // semantic edge between unrelated findings about that function.
      .match(/[\p{L}\p{N}_]+/gu)
      ?.filter((token) => token.length > 1 && !CORROBORATION_STOPWORDS.has(token)) ?? []
  );
}

function corroborationFieldSimilar(a: string | undefined, b: string | undefined): boolean {
  const tokensA = corroborationTokens(a ?? '');
  const tokensB = corroborationTokens(b ?? '');
  // At least one shared semantic token must remain after generic language is
  // removed. A shared code identifier alone is only evidence that findings
  // discuss the same function, not the same defect within that function.
  const shared = [...tokensA].filter((token) => tokensB.has(token));
  return shared.some((token) => !token.includes('_')) || shared.length >= 2;
}

function nonEmptyFieldSimilarity(a: string | undefined, b: string | undefined): number {
  const tokensA = tokenize(a ?? '');
  const tokensB = tokenize(b ?? '');
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  return jaccardOfSets(tokensA, tokensB);
}

function compatibleClaimKinds(a: Finding, b: Finding): boolean {
  const conceptsA = extractConcepts(a);
  const conceptsB = extractConcepts(b);
  return !(
    conceptsA.size > 0 &&
    conceptsB.size > 0 &&
    ![...conceptsA].some((concept) => conceptsB.has(concept))
  );
}

function relaxedLocationDuplicate(a: Finding, b: Finding, lineWindow: number): boolean {
  if (!areSameFile(a, b)) return false;
  if (!linesOverlap(a, b, lineWindow)) return false;
  if (hasOpposingSentiment(a, b, true)) return false;
  // Type-contract findings frequently sit beside runtime nil/error-handling
  // findings and repeat the same nouns, but require a different fix. Do not
  // let the relaxed path use one as a bridge into the other; the ordinary
  // similarity path remains available for genuinely near-identical wording.
  if (!compatibleClaimKinds(a, b)) return false;
  const descriptionSimilarity = nonEmptyFieldSimilarity(a.description, b.description);
  const fixSimilarity = nonEmptyFieldSimilarity(a.suggestedFix, b.suggestedFix);
  return (
    jaccardSimilarity(a.title, b.title) >= CORROBORATED_TITLE_THRESHOLD &&
    corroborationFieldSimilar(a.title, b.title) &&
    Math.max(descriptionSimilarity, fixSimilarity) >= CORROBORATED_DETAIL_THRESHOLD
  );
}

function relaxedLocationWeight(a: Finding, b: Finding, lineWindow: number): number {
  if (!relaxedLocationDuplicate(a, b, lineWindow)) return 0;
  return (
    jaccardSimilarity(a.title, b.title) * 0.25 +
    nonEmptyFieldSimilarity(a.description, b.description) * 0.2 +
    nonEmptyFieldSimilarity(a.suggestedFix, b.suggestedFix) * 0.55
  );
}

function groupsRelaxedWeight(
  a: TaggedFinding[],
  b: TaggedFinding[],
  lineWindow: number
): number {
  let weight = 0;
  for (const left of a) {
    for (const right of b) {
      if (`${left.model}::${left.role}` === `${right.model}::${right.role}`) continue;
      weight = Math.max(
        weight,
        relaxedLocationWeight(left.finding, right.finding, lineWindow)
      );
    }
  }
  return weight;
}

function groupsShareLocation(
  a: TaggedFinding[],
  b: TaggedFinding[],
  lineWindow: number
): boolean {
  return a.every((left) =>
    b.every(
      (right) =>
        areSameFile(left.finding, right.finding) &&
        linesOverlap(left.finding, right.finding, lineWindow)
    )
  );
}

function clustersClaimsAreCompatible(
  a: TaggedFinding[][],
  b: TaggedFinding[][]
): boolean {
  return a.every((left) =>
    b.every((right) =>
      left.every((leftMember) =>
        right.every((rightMember) =>
          compatibleClaimKinds(leftMember.finding, rightMember.finding)
        )
      )
    )
  );
}

function clustersAreCompatible(
  a: TaggedFinding[][],
  b: TaggedFinding[][],
  lineWindow: number
): boolean {
  return a.every((left) =>
    b.every((right) => groupsShareLocation(left, right, lineWindow))
  ) && clustersClaimsAreCompatible(a, b);
}

function clustersShareFile(a: TaggedFinding[][], b: TaggedFinding[][]): boolean {
  const filesA = new Set(a.flat().map((member) => member.finding.file));
  const filesB = new Set(b.flat().map((member) => member.finding.file));
  return filesA.size === filesB.size && [...filesA].every((file) => filesB.has(file));
}

function splitCompatibleChains(
  component: TaggedFinding[][],
  lineWindow: number
): TaggedFinding[][][] {
  const clusters: TaggedFinding[][][] = [];
  const ordered = [...component].sort((a, b) => {
    const left = chooseRepresentative(a).finding;
    const right = chooseRepresentative(b).finding;
    return left.file.localeCompare(right.file) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      left.title.localeCompare(right.title);
  });
  for (const group of ordered) {
    const compatible = clusters.find((cluster) =>
      clustersAreCompatible([group], cluster, lineWindow)
    );
    if (compatible) compatible.push(group);
    else clusters.push([group]);
  }
  return clusters;
}

function distinctReviewers(groups: TaggedFinding[][]): number {
  return new Set(
    groups.flatMap((group) =>
      group.map((member) => `${member.model}::${member.role}`)
    )
  ).size;
}

function relaxedEdgeDensity(
  groups: TaggedFinding[][],
  indexes: Map<TaggedFinding[], number>,
  adjacency: Array<Set<number>>
): number {
  if (groups.length < 2) return 0;
  let edges = 0;
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const leftIndex = indexes.get(groups[i]!);
      const rightIndex = indexes.get(groups[j]!);
      if (leftIndex === undefined || rightIndex === undefined) {
        throw new Error('Corroborated group is missing from its adjacency index');
      }
      if (adjacency[leftIndex]!.has(rightIndex)) edges++;
    }
  }
  return edges / ((groups.length * (groups.length - 1)) / 2);
}

/**
 * Split a weak-similarity graph into weighted modularity communities before
 * treating a connected component as one concept. This is the key over-merge
 * boundary: several independently corroborated defects can occupy the same
 * hunk, and a few shared diff tokens must not bridge those concepts together.
 */
function relaxedCommunities(weights: Array<Map<number, number>>): number[] {
  const count = weights.length;
  const labels = Array.from({ length: count }, (_, index) => index);
  const degrees = weights.map((row) =>
    [...row.values()].reduce((sum, weight) => sum + weight, 0)
  );
  const totalWeight = degrees.reduce((sum, degree) => sum + degree, 0) / 2;
  if (totalWeight === 0) return labels;

  const communityDegrees = [...degrees];
  const communitySizes = Array.from({ length: count }, () => 1);
  for (let pass = 0; pass < Math.max(1, count * count); pass++) {
    let moved = false;
    for (let index = 0; index < count; index++) {
      if (degrees[index] === 0) continue;
      const current = labels[index]!;
      const weightByCommunity = new Map<number, number>();
      for (const [neighbor, weight] of weights[index]!) {
        const label = labels[neighbor]!;
        weightByCommunity.set(label, (weightByCommunity.get(label) ?? 0) + weight);
      }

      // Remove the node before evaluating insertion into each neighboring
      // community. This is the standard first phase of weighted Louvain; the
      // previous implementation compared against stale community totals.
      communityDegrees[current] = Math.max(
        0,
        communityDegrees[current]! - degrees[index]!
      );
      communitySizes[current]!--;
      const emptyCommunity = communitySizes.findIndex((size) => size === 0);
      const candidates = new Set([
        ...weightByCommunity.keys(),
        current,
        ...(emptyCommunity >= 0 ? [emptyCommunity] : []),
      ]);
      let best = current;
      let bestGain =
        (weightByCommunity.get(current) ?? 0) -
        (communityDegrees[current]! * degrees[index]!) / (2 * totalWeight);
      for (const candidate of candidates) {
        const gain =
          (weightByCommunity.get(candidate) ?? 0) -
          (communityDegrees[candidate]! * degrees[index]!) / (2 * totalWeight);
        if (gain > bestGain + CORROBORATED_TIE_EPSILON ||
            (best !== current &&
              Math.abs(gain - bestGain) <= CORROBORATED_TIE_EPSILON &&
              candidate < best)) {
          best = candidate;
          bestGain = gain;
        }
      }

      communityDegrees[best] += degrees[index]!;
      communitySizes[best]!++;
      labels[index] = best;
      if (best !== current) moved = true;
    }
    if (!moved) break;
  }
  return labels;
}

interface AgreementCluster {
  groups: TaggedFinding[][];
  corroborated: boolean;
}

function conceptAnchors(groups: TaggedFinding[][]): Set<string> {
  const members = groups.flat();
  const reviewers = new Map<string, Set<string>>();
  for (const member of members) {
    for (const token of corroborationTokens(member.finding.title)) {
      const tokenReviewers = reviewers.get(token) ?? new Set<string>();
      tokenReviewers.add(`${member.model}::${member.role}`);
      reviewers.set(token, tokenReviewers);
    }
  }
  const reviewerCount = distinctReviewers(groups);
  // A one-reviewer fringe must never manufacture its own semantic anchor;
  // only an independently corroborated target contributes anchor evidence.
  const support = Math.max(2, Math.ceil(reviewerCount * 0.4));
  return new Set(
    [...reviewers]
      .filter(([, tokenReviewers]) => tokenReviewers.size >= support)
      .map(([token]) => token)
  );
}

function sharedAnchorCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count++;
  return count;
}

function agreementClusterKey(cluster: AgreementCluster): string {
  const finding = chooseRepresentative(cluster.groups.flat()).finding;
  const members = cluster.groups.flat()
    .map((member) => `${member.model}::${member.role}::${member.finding.id}`)
    .sort()
    .join('\0');
  return `${finding.file}\0${String(finding.startLine).padStart(10, '0')}\0${String(finding.endLine).padStart(10, '0')}\0${finding.title}\0${finding.id}\0${members}`;
}

function compareAgreementClusters(a: AgreementCluster, b: AgreementCluster): number {
  const left = agreementClusterKey(a);
  const right = agreementClusterKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergeAnchoredCommunities(
  clusters: AgreementCluster[],
  lineWindow: number
): AgreementCluster[] {
  const remaining = [...clusters].sort(compareAgreementClusters);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < remaining.length; i++) {
      const target = remaining[i]!;
      if (!target.corroborated) continue;
      for (let j = i + 1; j < remaining.length; j++) {
        const candidate = remaining[j]!;
        if (!candidate.corroborated ||
            !clustersAreCompatible(target.groups, candidate.groups, lineWindow)) {
          continue;
        }
        const targetAnchors = conceptAnchors(target.groups);
        const candidateAnchors = conceptAnchors(candidate.groups);
        if (targetAnchors.size === 0 || candidateAnchors.size === 0) continue;
        const shared = [...targetAnchors].filter((token) => candidateAnchors.has(token));
        if (shared.length < 2 &&
            !shared.some((token) => token.length >= 6 && !token.includes('_'))) continue;
        const hasCrossEdge = target.groups.flat().some((left) =>
          candidate.groups.flat().some((right) =>
            `${left.model}::${left.role}` !== `${right.model}::${right.role}` &&
            relaxedLocationWeight(left.finding, right.finding, lineWindow) > 0
          )
        );
        // Anchors alone only prove that both communities discuss the same
        // code. Require an observed semantic edge as evidence that they make
        // the same claim; this keeps two defects in one helper separate.
        if (!hasCrossEdge) continue;

        target.groups.push(...candidate.groups);
        candidate.groups = [];
        remaining.splice(j, 1);
        remaining.sort(compareAgreementClusters);
        merged = true;
        break outer;
      }
    }
  }
  return remaining;
}

function agreementClusters(
  groups: TaggedFinding[][],
  lineWindow: number
): AgreementCluster[] {
  groups = [...groups].sort((a, b) => {
    const left = agreementClusterKey({ groups: [a], corroborated: false });
    const right = agreementClusterKey({ groups: [b], corroborated: false });
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const weights = groups.map(() => new Map<number, number>());
  const adjacency = groups.map(() => new Set<number>());
  const indexes = new Map(groups.map((group, index) => [group, index]));
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const weight = groupsRelaxedWeight(groups[i]!, groups[j]!, lineWindow);
      if (weight === 0) continue;
      weights[i]!.set(j, weight);
      weights[j]!.set(i, weight);
      adjacency[i]!.add(j);
      adjacency[j]!.add(i);
    }
  }

  const communities = relaxedCommunities(weights);
  for (let i = 0; i < groups.length; i++) {
    for (const j of adjacency[i]!) {
      if (communities[i] !== communities[j]) adjacency[i]!.delete(j);
    }
  }

  // Keep only the graph's 2-core as corroboration evidence. A chain of weak
  // similarities can otherwise pull unrelated findings into one component;
  // every core group must have two independent semantic links. Peeled fringe
  // components remain available for the stricter attachment pass below.
  const inCore = groups.map(() => true);
  const degree = adjacency.map((neighbors) => neighbors.size);
  const queue = degree.flatMap((value, index) => (value < 2 ? [index] : []));
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor]!;
    if (!inCore[index]) continue;
    inCore[index] = false;
    for (const neighbor of adjacency[index]!) {
      if (!inCore[neighbor]) continue;
      degree[neighbor]!--;
      if (degree[neighbor]! < 2) queue.push(neighbor);
    }
  }

  function connectedComponents(wantedCore: boolean): TaggedFinding[][][] {
    const seen = new Set<number>();
    const out: TaggedFinding[][][] = [];
    for (let start = 0; start < groups.length; start++) {
      if (inCore[start] !== wantedCore || seen.has(start)) continue;
      const indexes: number[] = [];
      const pending = [start];
      seen.add(start);
      while (pending.length > 0) {
        const index = pending.pop()!;
        indexes.push(index);
        for (const neighbor of adjacency[index]!) {
          if (inCore[neighbor] !== wantedCore || seen.has(neighbor)) continue;
          seen.add(neighbor);
          pending.push(neighbor);
        }
      }
      out.push(indexes.map((index) => groups[index]!));
    }
    return out;
  }

  const coreClusters = connectedComponents(true)
    .flatMap((component) => splitCompatibleChains(component, lineWindow))
    .map((component): AgreementCluster => ({
      groups: component,
      corroborated:
        distinctReviewers(component) >= CORROBORATED_MIN_REVIEWERS &&
        relaxedEdgeDensity(component, indexes, adjacency) >= CORROBORATED_MIN_DENSITY,
    }));
  const fringeClusters = connectedComponents(false).map(
    (component): AgreementCluster => ({ groups: component, corroborated: false })
  );
  return mergeAnchoredCommunities([...coreClusters, ...fringeClusters], lineWindow);
}

function attachmentEvidence(
  singleton: TaggedFinding,
  cluster: AgreementCluster,
  lineWindow: number
): { support: number; strength: number } {
  const supporters = new Map<string, number>();
  const targetAnchors = conceptAnchors(cluster.groups);
  const singletonAnchors = corroborationTokens(
    `${singleton.finding.title} ${singleton.finding.description ?? ''} ${singleton.finding.suggestedFix ?? ''}`
  );
  const anchorCount = sharedAnchorCount(singletonAnchors, targetAnchors);
  const singletonReviewer = `${singleton.model}::${singleton.role}`;
  const fixSupport = new Set(
    cluster.groups.flat()
      .filter((member) =>
        `${member.model}::${member.role}` !== singletonReviewer &&
        nonEmptyFieldSimilarity(singleton.finding.suggestedFix, member.finding.suggestedFix) >=
          CORROBORATED_ATTACHMENT_FIX_THRESHOLD
      )
      .map((member) => `${member.model}::${member.role}`)
  ).size;
  if (anchorCount < 2 && !(anchorCount === 1 && fixSupport >= 2)) {
    return { support: 0, strength: 0 };
  }
  for (const group of cluster.groups) {
    for (const member of group) {
      if (!areSameFile(singleton.finding, member.finding)) continue;
      if (!linesOverlap(singleton.finding, member.finding, lineWindow)) continue;
      if (hasOpposingSentiment(singleton.finding, member.finding, true)) continue;
      if (!compatibleClaimKinds(singleton.finding, member.finding)) continue;
      if (!corroborationFieldSimilar(singleton.finding.title, member.finding.title)) continue;
      const key = `${member.model}::${member.role}`;
      if (key === singletonReviewer) continue;
      const similarity = combinedSimilarity(singleton.finding, member.finding);
      if (similarity >= CORROBORATED_ATTACHMENT_THRESHOLD) {
        supporters.set(key, Math.max(supporters.get(key) ?? 0, similarity));
      }
    }
  }
  if (anchorCount === 1 && supporters.size < CORROBORATED_SINGLE_ANCHOR_SUPPORT) {
    return { support: 0, strength: 0 };
  }
  return {
    support: supporters.size,
    strength: [...supporters.values()].reduce((sum, value) => sum + value, 0),
  };
}

function mergeCorroboratedLocationClusters(
  groups: TaggedFinding[][],
  lineWindow: number
): TaggedFinding[][] {
  const clusters = agreementClusters(groups, lineWindow);

  // A lone wording variant can sit just below the calibrated title floor.
  // Attach it only to one unambiguous corroborated cluster, with support from
  // at least two distinct reviewer assignments. Multi-member components are
  // absorbed only when every member supports the same target; this keeps a
  // nearby second concept such as ao-7536's log-capture cluster separate.
  for (
    let round = 0;
    round < Math.min(clusters.length, CORROBORATED_MAX_ATTACHMENT_ROUNDS);
    round++
  ) {
    const attachments: Array<{ candidate: AgreementCluster; target: AgreementCluster }> = [];
    for (const candidate of clusters) {
      if (candidate.corroborated) continue;
      // A strict group already backed by several reviewers is independent
      // evidence for a concept, even when it has no relaxed graph core of its
      // own. Do not absorb that consensus into a neighboring community.
      if (distinctReviewers(candidate.groups) >= CORROBORATED_MIN_REVIEWERS) continue;
      const candidateMembers = candidate.groups.flat();
      if (candidateMembers.length === 0) continue;

      const ranked = clusters
        .filter((target) =>
          target !== candidate &&
          target.corroborated &&
          clustersShareFile(candidate.groups, target.groups) &&
          clustersClaimsAreCompatible(candidate.groups, target.groups)
        )
        .map((target) => {
          const evidence = candidateMembers.map((member) =>
            attachmentEvidence(member, target, lineWindow)
          );
          const supports = evidence.map((item) => item.support);
          return {
            target,
            support: Math.min(...supports),
            strength: evidence.reduce((sum, item) => sum + item.strength, 0),
            size: target.groups.flat().length,
            key: chooseRepresentative(target.groups.flat()).finding.title,
          };
        })
        .filter(({ support }) => support >= CORROBORATED_ATTACHMENT_SUPPORT)
        .sort(
          (a, b) =>
            b.support - a.support ||
            b.strength - a.strength ||
            b.size - a.size ||
            a.key.localeCompare(b.key)
        );
      if (ranked.length === 0) continue;
      if (
        ranked[1] &&
        ranked[0]!.support === ranked[1].support &&
        Math.abs(ranked[0]!.strength - ranked[1].strength) <= CORROBORATED_TIE_EPSILON &&
        ranked[0]!.size === ranked[1].size
      ) {
        continue;
      }

      attachments.push({ candidate, target: ranked[0]!.target });
    }

    if (attachments.length === 0) break;
    // Apply a round only after every candidate was ranked against the same
    // frozen state. Later rounds may use the newly attached evidence without
    // making peers in the same round order-dependent.
    for (const { candidate, target } of attachments) {
      target.groups.push(...candidate.groups);
      candidate.groups = [];
    }
  }

  // Fringe evidence can provide the first real lexical edge between two
  // independently corroborated communities. Revisit anchor merging once
  // after attachment so that bridge is considered, while still requiring an
  // observed cross-community edge rather than anchors alone.
  const mergedClusters = mergeAnchoredCommunities(
    clusters.filter((cluster) => cluster.groups.length > 0),
    lineWindow
  );

  return mergedClusters.flatMap((cluster) => {
    if (cluster.groups.length === 0) return [];
    if (!cluster.corroborated) return cluster.groups;
    return [cluster.groups.flat()];
  });
}

/**
 * Rescue agreement that has no lexical center at all. This pass only considers
 * weak one- or two-reviewer groups: a group already backed by three reviewers
 * is evidence for an independent concept and is never absorbed by proximity.
 * A connected file/line neighborhood merges only when its combined distinct
 * reviewers would clear the report's agreement gate. This is the vocabulary-
 * independent signal RCL-17 was missing, while the strength guard preserves
 * nearby minority concepts such as ao-7467's typespec finding.
 */
function mergeAgreementNeighborhoods(
  groups: TaggedFinding[][],
  lineWindow: number,
  minimumReviewers: number
): TaggedFinding[][] {
  function groupsTouch(a: TaggedFinding[], b: TaggedFinding[]): boolean {
    return a.some((left) =>
      b.some(
        (right) =>
          areSameFile(left.finding, right.finding) &&
          linesOverlap(left.finding, right.finding, lineWindow)
      )
    );
  }

  function weakSimilarity(a: TaggedFinding[], b: TaggedFinding[]): number {
    let similarity = 0;
    for (const left of a) {
      for (const right of b) {
        similarity = Math.max(
          similarity,
          combinedSimilarity(left.finding, right.finding)
        );
      }
    }
    return similarity;
  }

  const strong = groups.filter(
    (group) => distinctReviewers([group]) >= CORROBORATED_MIN_REVIEWERS
  );
  const eligible = groups.map((group) =>
    distinctReviewers([group]) < CORROBORATED_MIN_REVIEWERS &&
    group.every(
      (member) =>
        member.finding.endLine - member.finding.startLine <=
        CORROBORATED_MAX_NEIGHBORHOOD_SPAN
    ) &&
    !strong.some((established) => groupsTouch(group, established))
  );
  const parent = groups.map((_, index) => index);
  const adjacency = groups.map(() => new Set<number>());

  function find(index: number): number {
    if (parent[index] !== index) parent[index] = find(parent[index]!);
    return parent[index]!;
  }

  for (let i = 0; i < groups.length; i++) {
    if (!eligible[i]) continue;
    for (let j = i + 1; j < groups.length; j++) {
      if (!eligible[j]) continue;
      if (!groupsTouch(groups[i]!, groups[j]!)) continue;
      if (weakSimilarity(groups[i]!, groups[j]!) < CORROBORATED_NEIGHBORHOOD_THRESHOLD) {
        continue;
      }
      const rootI = find(i);
      const rootJ = find(j);
      if (rootI !== rootJ) parent[rootJ] = rootI;
      adjacency[i]!.add(j);
      adjacency[j]!.add(i);
    }
  }

  const components = new Map<number, number[]>();
  for (let index = 0; index < groups.length; index++) {
    if (!eligible[index]) continue;
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(index);
    components.set(root, component);
  }

  const mergedAt = new Map<number, TaggedFinding[]>();
  const consumed = new Set<number>();
  for (const indexes of components.values()) {
    const component = indexes.map((index) => groups[index]!);
    if (component.length < 3 || component.length > minimumReviewers - 2) continue;
    if (distinctReviewers(component) !== minimumReviewers) continue;
    let edges = 0;
    for (let i = 0; i < indexes.length; i++) {
      for (let j = i + 1; j < indexes.length; j++) {
        if (!adjacency[indexes[i]!]!.has(indexes[j]!)) continue;
        edges++;
      }
    }
    const possibleEdges = (indexes.length * (indexes.length - 1)) / 2;
    if (edges / possibleEdges < CORROBORATED_NEIGHBORHOOD_DENSITY) continue;
    mergedAt.set(indexes[0]!, component.flat());
    for (const index of indexes.slice(1)) consumed.add(index);
  }

  return groups.flatMap((group, index) => {
    const merged = mergedAt.get(index);
    if (merged) return [merged];
    return consumed.has(index) ? [] : [group];
  });
}

/**
 * Intra-review dedup is pairwise, so two dissimilar variants from one review
 * can still land in the same final group via a bridge finding from another
 * review. Collapse same-(model, role) members so a single reviewer never
 * counts twice in consensus scores or the elevation support guard.
 */
function collapseSameReviewer(members: TaggedFinding[]): TaggedFinding[] {
  const byReviewer = new Map<string, TaggedFinding[]>();
  for (const m of members) {
    const key = `${m.model}::${m.role}`;
    const existing = byReviewer.get(key) ?? [];
    existing.push(m);
    byReviewer.set(key, existing);
  }
  return [...byReviewer.values()].map((group) =>
    group.length === 1 ? group[0]! : chooseRepresentative(group)
  );
}

/**
 * A single model sometimes emits the same finding more than once. Collapse
 * those first so repeats can't masquerade as independent confirmations and
 * inflate consensus scores.
 */
function dedupeWithinReview(
  review: ModelReview,
  jaccardThreshold: number,
  lineWindow: number
): TaggedFinding[] {
  const tagged: TaggedFinding[] = review.findings.map((finding) => ({
    finding,
    model: review.model,
    role: review.role,
  }));
  return groupTagged(tagged, jaccardThreshold, lineWindow).map((g) => chooseRepresentative(g));
}

export function deduplicateFindings(
  reviews: ModelReview[],
  jaccardThreshold: number = DEFAULT_THRESHOLDS.jaccardThreshold,
  lineWindow: number = DEFAULT_THRESHOLDS.dedupeLineWindow,
  minConsensusScore: number = DEFAULT_THRESHOLDS.minConsensusScore
): DeduplicatedGroup[] {
  // Flatten all findings with attribution, deduplicating within each review first
  const all: TaggedFinding[] = [];
  for (const review of reviews) {
    if (review.status !== 'success') continue;
    all.push(...dedupeWithinReview(review, jaccardThreshold, lineWindow));
  }

  if (all.length === 0) return [];

  const strictGroups: TaggedFinding[][] = [];
  for (const members of groupTagged(all, jaccardThreshold, lineWindow)) {
    for (const coherent of splitIncoherent(members, jaccardThreshold, lineWindow)) {
      strictGroups.push(collapseSameReviewer(coherent));
    }
  }

  const corroborated = mergeCorroboratedLocationClusters(strictGroups, lineWindow);
  const successfulReviews = reviews.filter((review) => review.status === 'success').length;
  const minimumReviewers = Math.max(
    CORROBORATED_MIN_REVIEWERS,
    Math.ceil(successfulReviews * minConsensusScore)
  );
  const result: DeduplicatedGroup[] = mergeAgreementNeighborhoods(
    corroborated,
    lineWindow,
    minimumReviewers
  ).map((members) => {
    const collapsed = collapseSameReviewer(members);
    return {
      representative: chooseRepresentative(collapsed).finding,
      members: collapsed,
    };
  });

  // Sort by severity then file
  const severityOrder = { critical: 0, important: 1, minor: 2, nitpick: 3 };
  result.sort((a, b) => {
    const sevDiff =
      severityOrder[a.representative.severity] -
      severityOrder[b.representative.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.representative.file.localeCompare(b.representative.file);
  });

  return result;
}
