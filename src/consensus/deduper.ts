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
  return combinedSimilarity(a, b) >= threshold;
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
      result.push({
        representative: chooseRepresentative(coherent).finding,
        members: coherent,
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
