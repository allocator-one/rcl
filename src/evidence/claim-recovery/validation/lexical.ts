// Only lexical predicates used to validate retained descriptors; no deduplication entry point.
import type { Finding } from '../../../consensus/types.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
  'this', 'that', 'these', 'those', 'with', 'as', 'by', 'from', 'into',
  'via', 'when', 'which', 'their', 'there', 'than', 'then',
]);

export function tokenize(s: string): Set<string> {
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

