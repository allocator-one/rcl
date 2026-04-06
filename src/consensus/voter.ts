import type { Finding, ModelReview, ConsensusFinding, ConsensusInfo, DeduplicatedGroup } from './types.js';
import type { Role } from '../roles/types.js';
import { CONFIDENCE_THRESHOLDS } from '../config/defaults.js';

const SEVERITY_LEVELS = ['critical', 'important', 'minor', 'nitpick'] as const;
type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

function severityIndex(s: SeverityLevel): number {
  return SEVERITY_LEVELS.indexOf(s);
}

function indexToSeverity(i: number): SeverityLevel {
  const clamped = Math.max(0, Math.min(SEVERITY_LEVELS.length - 1, i));
  return SEVERITY_LEVELS[clamped]!;
}

function bumpSeverity(severity: SeverityLevel, bumps: number): SeverityLevel {
  const idx = severityIndex(severity);
  return indexToSeverity(idx - bumps); // lower index = higher severity
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
 */
function computeDiversity(
  group: DeduplicatedGroup,
  allModels: string[],
  allRoles: string[]
): number {
  const uniqueModels = new Set(group.members.map((m) => m.model));
  const uniqueRoles = new Set(group.members.map((m) => m.role));

  const modelDiversity = allModels.length > 0 ? uniqueModels.size / allModels.length : 0;
  const roleDiversity = allRoles.length > 0 ? uniqueRoles.size / allRoles.length : 0;

  return modelDiversity * 0.5 + roleDiversity * 0.5;
}

/**
 * Layer 2: Relevance score
 * For each reporter's role, check if this category is in their focus area.
 * Expected finding from focused role = 0.5, unexpected = 1.0; take mean.
 */
function computeRelevance(
  group: DeduplicatedGroup,
  roleMap: Map<string, Role>
): number {
  if (group.members.length === 0) return 0.5;

  const scores = group.members.map(({ role: roleName }) => {
    const role = roleMap.get(roleName);
    if (!role) return 1.0; // unknown role — treat as unexpected = high signal

    const category = group.representative.category;
    const isExpected =
      role.focus.includes(category) ||
      role.focus.some((f) => f.includes(category) || category.includes(f));

    return isExpected ? 0.5 : 1.0;
  });

  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
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

  // Find all reviewers whose role is focused on this category
  const relevantReviewers = reviews.filter((r) => {
    if (r.status !== 'success') return false;
    const role = roleMap.get(r.role);
    if (!role) return false;
    return (
      role.focus.includes(category) ||
      role.focus.some((f) => f.includes(category) || category.includes(f))
    );
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
 * Layer 5: Detect opposing/disputed findings at the same location
 */
function detectDisputes(
  group: DeduplicatedGroup,
  allGroups: DeduplicatedGroup[]
): { disputed: boolean; disputeDetails?: string } {
  const rep = group.representative;

  // Look for another group at the same location with a contradicting title/description
  for (const other of allGroups) {
    if (other === group) continue;
    if (other.representative.file !== rep.file) continue;

    // Check if they're at the same location
    const lineDiff = Math.abs(other.representative.startLine - rep.startLine);
    if (lineDiff > 5) continue;

    // Check for opposing sentiment in titles
    const aTitle = rep.title.toLowerCase();
    const bTitle = other.representative.title.toLowerCase();

    const opposingPairs = [
      ['missing', 'present'],
      ['no ', 'has '],
      ['lacks', 'has'],
      ['not ', 'is '],
      ['should add', 'should remove'],
    ];

    for (const [posA, posB] of opposingPairs) {
      if (
        (aTitle.includes(posA) && bTitle.includes(posB)) ||
        (aTitle.includes(posB) && bTitle.includes(posA))
      ) {
        return {
          disputed: true,
          disputeDetails: `Conflicting finding at same location: "${rep.title}" vs "${other.representative.title}"`,
        };
      }
    }
  }

  return { disputed: false };
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

    // Layer 2: Signal scoring
    const diversity = computeDiversity(group, allModels, allRoles);
    const relevance = computeRelevance(group, roleMap);
    const isolation = computeIsolation(group, reviews, roleMap);

    // Layer 3: Raw confidence
    const rawConfidence = diversity * 0.4 + relevance * 0.3 + isolation * 0.3;
    const clampedConfidence = Math.min(1, Math.max(0, rawConfidence));
    const label = confidenceLabel(clampedConfidence);

    // Layer 4: Severity elevation
    let elevatedSeverity = rep.severity as SeverityLevel;
    let bumps = 0;
    const elevation: ConsensusInfo['elevation'] = (() => {
      const uniqueModels = new Set(group.members.map((m) => m.model));
      const uniqueRoles = new Set(group.members.map((m) => m.role));

      if (
        label === 'Very High' &&
        group.members.length >= 3
      ) {
        bumps = 2;
        return 'unanimous';
      }
      if (label === 'High' || label === 'Very High') {
        if (uniqueModels.size >= 2 && uniqueRoles.size >= 2) {
          bumps = 1;
          return 'cross-model';
        }
        if (uniqueRoles.size >= 2) {
          bumps = 1;
          return 'cross-role';
        }
      }
      return 'none';
    })();

    if (bumps > 0) {
      elevatedSeverity = bumpSeverity(rep.severity as SeverityLevel, bumps);
    }

    const elevated = elevatedSeverity !== rep.severity;
    const original_severity = elevated ? rep.severity : undefined;

    // Layer 5: Dispute detection
    const { disputed, disputeDetails } = detectDisputes(group, groups);

    const uniqueModels = [...new Set(group.members.map((m) => m.model))];
    const uniqueRoles = [...new Set(group.members.map((m) => m.role))];

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
      severity: elevatedSeverity,
      consensus,
    };
  });
}
