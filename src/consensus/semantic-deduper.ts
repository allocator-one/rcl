import type { Finding, ModelReview, DeduplicatedGroup } from './types.js';
import { DEFAULT_THRESHOLDS } from '../config/defaults.js';
import { compareClaims, describeClaim } from './claim-identity.js';
import { linesOverlap } from './deduper.js';

interface TaggedFinding {
  finding: Finding;
  model: string;
  role: string;
}

// The producer selects this path only after validating recovered native proof.
// Ordinary reviews retain the legacy deduper and its configuration semantics.
const SEVERITY_ORDER = { critical: 0, important: 1, minor: 2, nitpick: 3 };

function compareMembers(a: TaggedFinding, b: TaggedFinding): number {
  const severity = SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity];
  if (severity !== 0) return severity;
  const detail = b.finding.description.length - a.finding.description.length;
  if (detail !== 0) return detail;
  const location = a.finding.file.localeCompare(b.finding.file) ||
    a.finding.startLine - b.finding.startLine || a.finding.endLine - b.finding.endLine;
  if (location !== 0) return location;
  const key = (member: TaggedFinding) => {
    const f = member.finding;
    const p = f.locationProvenance;
    return JSON.stringify([f.file, f.startLine, f.endLine, f.title, f.description, f.suggestedFix,
      f.id, f.severity, f.category, p ? [p.version, p.source, p.reason, p.originalStartLine, p.originalEndLine] : null,
      member.model, member.role]);
  };
  const left = key(a);
  const right = key(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Location selects candidates; only positive, complete claim evidence can merge
 * them. Lexical/taxonomy scores remain available for diagnostics and disputes,
 * but cannot discard an allegation or lend it another reviewer's agreement.
 *
 * Keep the positional threshold arguments compatible with existing callers.
 * The consensus threshold still applies in the voter/reporting stage.
 */
export function deduplicateSemanticFindings(
  reviews: ModelReview[],
  _jaccardThreshold: number = DEFAULT_THRESHOLDS.jaccardThreshold,
  lineWindow: number = DEFAULT_THRESHOLDS.dedupeLineWindow,
  _minConsensusScore: number = DEFAULT_THRESHOLDS.minConsensusScore
): DeduplicatedGroup[] {
  const members = reviews.filter(review => review.status === 'success')
    .flatMap(review => review.findings.map(finding => ({ finding, model: review.model, role: review.role })))
    .sort(compareMembers);
  const descriptors = new Map(members.map(member => [member.finding, describeClaim(member.finding)]));
  const groups: TaggedFinding[][] = [];
  for (const member of members) {
    const matches = groups.filter(group => group.every(other =>
      member.finding.file === other.finding.file &&
      linesOverlap(member.finding, other.finding, lineWindow) &&
      compareClaims(descriptors.get(member.finding)!, descriptors.get(other.finding)!) !== undefined));
    // Ambiguous attachment must not choose a neighbor by incidental input order.
    if (matches.length === 1) matches[0]!.push(member);
    else groups.push([member]);
  }
  const result = groups.map(group => {
    const distinct = new Map<string, TaggedFinding>();
    for (const member of group) {
      const key = JSON.stringify([member.model, member.role]);
      // Members are sorted by severity/detail/stable content. Count one vote
      // from a reviewer without dropping a stronger version of this claim.
      if (!distinct.has(key)) distinct.set(key, member);
    }
    return { representative: group[0]!.finding, members: [...distinct.values()] };
  });
  return result.sort((a, b) => SEVERITY_ORDER[a.representative.severity] - SEVERITY_ORDER[b.representative.severity] ||
    a.representative.file.localeCompare(b.representative.file) ||
    a.representative.startLine - b.representative.startLine ||
    a.representative.title.localeCompare(b.representative.title) ||
    a.representative.id.localeCompare(b.representative.id));
}
