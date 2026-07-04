import type { ModelReview, ConsensusFinding, ConsensusInfo, DeduplicatedGroup } from './types.js';
import type { Role } from '../roles/types.js';
import { CONFIDENCE_THRESHOLDS, DEFAULT_THRESHOLDS } from '../config/defaults.js';
import { linesOverlap, hasOpposingSentiment } from './deduper.js';

const SEVERITY_LEVELS = ['critical', 'important', 'minor', 'nitpick'] as const;
type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

function severityIndex(s: SeverityLevel): number {
  return SEVERITY_LEVELS.indexOf(s);
}

function indexToSeverity(i: number): SeverityLevel {
  const clamped = Math.max(0, Math.min(SEVERITY_LEVELS.length - 1, i));
  return SEVERITY_LEVELS[clamped]!;
}

function confidenceLabel(
  score: number
): ConsensusInfo['confidenceLabel'] {
  if (score >= CONFIDENCE_THRESHOLDS.veryHigh) return 'Very High';
  if (score >= CONFIDENCE_THRESHOLDS.high) return 'High';
  if (score >= CONFIDENCE_THRESHOLDS.medium) return 'Medium';
  if (score >= CONFIDENCE_THRESHOLDS.low) return 'Low';
  return 'Minimal';
}

/**
 * Layer 2: Diversity score
 * = (unique_models / total_models) * 0.5 + (unique_roles / total_roles) * 0.5
 *
 * Denominators are floored at 2 so a run where only one model succeeded
 * can't score perfect diversity from a single opinion.
 */
function computeDiversity(
  group: DeduplicatedGroup,
  allModels: string[],
  allRoles: string[]
): number {
  const uniqueModels = new Set(group.members.map((m) => m.model));
  const uniqueRoles = new Set(group.members.map((m) => m.role));

  const modelDiversity = uniqueModels.size / Math.max(allModels.length, 2);
  const roleDiversity = uniqueRoles.size / Math.max(allRoles.length, 2);

  return Math.min(1, modelDiversity * 0.5 + roleDiversity * 0.5);
}

/**
 * Layer 2: Relevance score
 * Specialist confirmation raises confidence: if any reporter's role focuses
 * on this category, the finding is validated by someone whose job it is to
 * catch it (1.0). A finding flagged only by non-specialists is weaker
 * evidence (0.5) — if it were real and obvious, the specialist should have
 * seen it too.
 */
function computeRelevance(
  group: DeduplicatedGroup,
  roleMap: Map<string, Role>
): number {
  if (group.members.length === 0) return 0.5;

  const category = group.representative.category;
  const anySpecialist = group.members.some(({ role: roleName }) => {
    const role = roleMap.get(roleName);
    if (!role) return false; // unknown role — can't claim specialist confirmation
    return role.focus.includes(category);
  });

  return anySpecialist ? 1.0 : 0.5;
}

/**
 * Layer 2: Isolation score
 * = flagged_relevant / (flagged_relevant + missed_relevant)
 *
 * "relevant" reviewers = those whose role.focus includes this category
 * flagged_relevant = relevant reviewers who flagged this finding
 * missed_relevant = relevant reviewers who did NOT flag this finding
 */
function computeIsolation(
  group: DeduplicatedGroup,
  reviews: ModelReview[],
  roleMap: Map<string, Role>
): number {
  const category = group.representative.category;

  // Find all reviewers whose role is focused on this category (exact match —
  // substring matching invites false positives as categories grow)
  const relevantReviewers = reviews.filter((r) => {
    if (r.status !== 'success') return false;
    const role = roleMap.get(r.role);
    if (!role) return false;
    return role.focus.includes(category);
  });

  if (relevantReviewers.length === 0) {
    // No focused reviewers — neutral score
    return 0.5;
  }

  const flaggedModels = new Set(group.members.map((m) => `${m.model}::${m.role}`));
  let flaggedRelevant = 0;
  let missedRelevant = 0;

  for (const reviewer of relevantReviewers) {
    const key = `${reviewer.model}::${reviewer.role}`;
    if (flaggedModels.has(key)) {
      flaggedRelevant++;
    } else {
      missedRelevant++;
    }
  }

  const total = flaggedRelevant + missedRelevant;
  return total > 0 ? flaggedRelevant / total : 0.5;
}

/**
 * Layer 5: Detect disputed findings.
 *
 * Two signals:
 * 1. Severity dispersion within the group — members that rate the same
 *    finding 2+ levels apart (e.g. critical vs minor) genuinely disagree.
 * 2. An opposing-conclusion group at the same location. The deduper refuses
 *    to merge contradicting findings, so they surface as separate groups
 *    that this check pairs back up and flags.
 */
function detectDisputes(
  group: DeduplicatedGroup,
  allGroups: DeduplicatedGroup[]
): { disputed: boolean; disputeDetails?: string } {
  const rep = group.representative;

  const indices = group.members.map((m) => severityIndex(m.finding.severity as SeverityLevel));
  const spread = Math.max(...indices) - Math.min(...indices);
  if (spread >= 2) {
    const highest = indexToSeverity(Math.min(...indices));
    const lowest = indexToSeverity(Math.max(...indices));
    return {
      disputed: true,
      disputeDetails: `Reviewers disagree on severity: rated from ${lowest} to ${highest}`,
    };
  }

  for (const other of allGroups) {
    if (other === group) continue;
    if (other.representative.file !== rep.file) continue;
    if (!linesOverlap(rep, other.representative, DEFAULT_THRESHOLDS.dedupeLineWindow)) continue;

    if (hasOpposingSentiment(rep, other.representative)) {
      return {
        disputed: true,
        disputeDetails: `Conflicting finding at same location: "${rep.title}" vs "${other.representative.title}"`,
      };
    }
  }

  return { disputed: false };
}

/**
 * Base severity = the most common severity among members (ties go to the
 * more severe). Agreement speaks to confidence, not severity — a unanimous
 * nitpick stays a nitpick.
 */
function modeSeverity(group: DeduplicatedGroup): SeverityLevel {
  const counts = new Map<SeverityLevel, number>();
  for (const m of group.members) {
    const s = m.finding.severity as SeverityLevel;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }

  let best: SeverityLevel = group.representative.severity as SeverityLevel;
  let bestCount = -1;
  // Iterating critical → nitpick resolves ties toward the more severe level
  for (const level of SEVERITY_LEVELS) {
    const count = counts.get(level) ?? 0;
    if (count > bestCount) {
      best = level;
      bestCount = count;
    }
  }
  return best;
}

export function computeConsensus(
  groups: DeduplicatedGroup[],
  reviews: ModelReview[],
  roleMap: Map<string, Role>
): ConsensusFinding[] {
  const allModels = [...new Set(reviews.filter((r) => r.status === 'success').map((r) => r.model))];
  const allRoles = [...new Set(reviews.filter((r) => r.status === 'success').map((r) => r.role))];

  return groups.map((group): ConsensusFinding => {
    const rep = group.representative;
    const uniqueModels = [...new Set(group.members.map((m) => m.model))];
    const uniqueRoles = [...new Set(group.members.map((m) => m.role))];

    // Layer 2: Signal scoring
    const diversity = computeDiversity(group, allModels, allRoles);
    const relevance = computeRelevance(group, roleMap);
    const isolation = computeIsolation(group, reviews, roleMap);

    // Layer 3: Raw confidence
    const rawConfidence = diversity * 0.4 + relevance * 0.3 + isolation * 0.3;
    const clampedConfidence = Math.min(1, Math.max(0, rawConfidence));
    const label = confidenceLabel(clampedConfidence);

    // Layer 4: Severity elevation.
    // Only applies when members actually disagree on severity, and never
    // elevates past the highest severity any member assigned. High-confidence
    // agreement resolves the disagreement upward; it never invents severity.
    const baseSeverity = modeSeverity(group);
    const maxSeverity = indexToSeverity(
      Math.min(...group.members.map((m) => severityIndex(m.finding.severity as SeverityLevel)))
    );

    let elevation: ConsensusInfo['elevation'] = 'none';
    let finalSeverity = baseSeverity;
    if (maxSeverity !== baseSeverity) {
      if (label === 'Very High' && group.members.length >= 3) {
        finalSeverity = maxSeverity;
        elevation = 'unanimous';
      } else if (
        (label === 'High' || label === 'Very High') &&
        uniqueModels.length >= 2 &&
        uniqueRoles.length >= 2
      ) {
        finalSeverity = maxSeverity;
        elevation = 'cross-model';
      } else if ((label === 'High' || label === 'Very High') && uniqueRoles.length >= 2) {
        finalSeverity = maxSeverity;
        elevation = 'cross-role';
      }
    }

    const elevated = finalSeverity !== baseSeverity;
    const original_severity = elevated ? baseSeverity : undefined;

    // Layer 5: Dispute detection
    const { disputed, disputeDetails } = detectDisputes(group, groups);

    const consensus: ConsensusInfo = {
      score: group.members.length,
      total: reviews.filter((r) => r.status === 'success').length,
      models: uniqueModels,
      roles: uniqueRoles,
      crossRole: uniqueRoles.length >= 2,
      crossModel: uniqueModels.length >= 2,
      elevated,
      original_severity,
      elevation,
      confidence: clampedConfidence,
      confidenceLabel: label,
      disputed: disputed || undefined,
      disputeDetails,
    };

    return {
      ...rep,
      severity: finalSeverity,
      consensus,
    };
  });
}
