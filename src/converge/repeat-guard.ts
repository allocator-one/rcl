import { createHash } from 'node:crypto';
import { DEFAULT_THRESHOLDS } from '../config/defaults.js';
import { tokenize } from '../consensus/deduper.js';
import type { ConsensusFinding } from '../consensus/types.js';

/**
 * Repeat-only rounds (RCL-199). Claim matching across rounds is exact, so a
 * reworded or relocated repeat of a dismissed claim got a fresh identity and
 * went back to triage. In the prod ledger about a quarter of dismissals
 * re-raised a claim already dismissed on the same pull request.
 *
 * When every gating finding a round would put in front of triage repeats a
 * standing dismissal, those findings are suppressed and the round converges.
 * One genuinely new gating finding keeps the whole round actionable, and an
 * escalation to critical past the dismissed severity still gates (RCL-30).
 * Matching is lexical and stricter than the deduper, because a match removes
 * a finding from triage instead of merging it: same file and category, line
 * ranges within the line window, and both title and description overlap at
 * the deduper's Jaccard threshold. On the prod ledger of seven loop pull
 * requests, none of the findings this matched was later fixed.
 */

export interface RepeatOf {
  identity: string;
  dismissedRound: number;
}

export interface PriorClaim {
  key: string;
  file: string;
  category: string;
  startLine: number;
  endLine: number;
  title: string;
  descriptionTokens?: string[];
  /** Set only for a standing dismissal, or a repeat of one: then it names the dismissed root. */
  dismissal?: { identity: string; round: number; severity: string };
}

/** Hashed so the ledger keeps description overlap without retaining claim prose. */
export function descriptionTokenDigests(finding: Pick<ConsensusFinding, 'description'>): string[] {
  return [...tokenize(finding.description)]
    .map(token => createHash('sha256').update(token).digest('hex').slice(0, 12)).sort();
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * The standing dismissal this finding repeats, if any. A finding is ambiguous
 * and repeats nothing when it also resembles an open or fixed prior claim (a
 * fixed claim coming back is a regression to triage), or when any resembled
 * dismissal would re-gate at its severity.
 */
export function dismissedRepeatOf(finding: ConsensusFinding, prior: readonly PriorClaim[],
  lineWindow: number): RepeatOf | undefined {
  const threshold = DEFAULT_THRESHOLDS.jaccardThreshold;
  const title = tokenize(finding.title);
  const description = new Set(descriptionTokenDigests(finding));
  const similar = prior.filter(entry => entry.file === finding.file && entry.category === finding.category &&
    finding.startLine <= entry.endLine + lineWindow && entry.startLine <= finding.endLine + lineWindow &&
    entry.descriptionTokens !== undefined && overlap(title, tokenize(entry.title)) >= threshold &&
    overlap(description, new Set(entry.descriptionTokens)) >= threshold);
  if (similar.some(entry => entry.dismissal === undefined ||
    finding.severity === 'critical' && entry.dismissal.severity !== 'critical')) return undefined;
  const match = [...similar]
    .sort((left, right) => left.dismissal!.round - right.dismissal!.round ||
      left.dismissal!.identity.localeCompare(right.dismissal!.identity))[0];
  return match && { identity: match.dismissal!.identity, dismissedRound: match.dismissal!.round };
}

export function repeatSuppressReason(repeatOf: RepeatOf): string {
  return `repeats ${repeatOf.identity}, dismissed in round ${repeatOf.dismissedRound} — same file and lines with ` +
    'overlapping wording, in a round with no other new gating finding; escalation to critical re-gates (RCL-199)';
}
