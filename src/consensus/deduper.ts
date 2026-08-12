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
  lineWindow: number = DEFAULT_THRESHOLDS.dedupeLineWindow
): DeduplicatedGroup[] {
  // Flatten all findings with attribution, deduplicating within each review first
  const all: TaggedFinding[] = [];
  for (const review of reviews) {
    if (review.status !== 'success') continue;
    all.push(...dedupeWithinReview(review, jaccardThreshold, lineWindow));
  }

  if (all.length === 0) return [];

  const result: DeduplicatedGroup[] = [];
  for (const members of groupTagged(all, jaccardThreshold, lineWindow)) {
    for (const coherent of splitIncoherent(members, jaccardThreshold, lineWindow)) {
      const collapsed = collapseSameReviewer(coherent);
      result.push({
        representative: chooseRepresentative(collapsed).finding,
        members: collapsed,
      });
    }
  }

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
