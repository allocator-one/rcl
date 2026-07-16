import type { ModelReview, ConsensusFinding, ConsensusInfo, DeduplicatedGroup } from './types.js';
import type { Role } from '../roles/types.js';
import { CONFIDENCE_THRESHOLDS, DEFAULT_THRESHOLDS } from '../config/defaults.js';
import { linesOverlap, hasOpposingSentiment, combinedSimilarity } from './deduper.js';

/** Thresholds shared with the deduper so both layers use the same geometry. */
export interface ConsensusThresholds {
  lineWindow: number;
  jaccardThreshold: number;
}

const SEVERITY_LEVELS = ['critical', 'important', 'minor', 'nitpick'] as const;
type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

function severityIndex(s: SeverityLevel): number {
  const idx = SEVERITY_LEVELS.indexOf(s);
  // Severities are zod-validated at the parse boundary, but never let an
  // unrecognized value read as MORE severe than critical (-1 sorts above 0
  // in Math.min) — treat it as least severe instead.
  return idx === -1 ? SEVERITY_LEVELS.length - 1 : idx;
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
 * = saturating(unique_models) * 0.5 + saturating(unique_roles) * 0.5
 *
 * Each dimension saturates at half the fleet: agreement from ceil(total/2)
 * reviewers earns full credit, so confidence stays comparable across
 * configuration sizes (3 of 6 models agreeing is not weaker evidence than
 * 2 of 2). The denominator is floored at 2 so a run where only one model
 * succeeded can't score perfect diversity from a single opinion.
 */
function computeDiversity(
  group: DeduplicatedGroup,
  allModels: string[],
  allRoles: string[]
): number {
  const uniqueModels = new Set(group.members.map((m) => m.model));
  const uniqueRoles = new Set(group.members.map((m) => m.role));

  const saturating = (unique: number, total: number): number =>
    Math.min(1, unique / Math.max(2, Math.ceil(total / 2)));

  return saturating(uniqueModels.size, allModels.length) * 0.5 +
    saturating(uniqueRoles.size, allRoles.length) * 0.5;
}

/**
 * Layer 2: Relevance score
 * Specialist confirmation raises confidence: if any reporter's role is a
 * specialist focused on this category, the finding is validated by someone
 * whose job it is to catch it (1.0). A finding flagged only by
 * non-specialists is weaker evidence (0.5) — if it were real and obvious,
 * the specialist should have seen it too.
 *
 * Gated on isSpecialized: the builtin general role lists every category in
 * its focus, so focus membership alone would make every group score 1.0.
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
    return role.isSpecialized && role.focus.includes(category);
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

  // Find all SPECIALIST reviewers focused on this category (exact match —
  // substring matching invites false positives as categories grow; the
  // isSpecialized gate keeps all-focus general reviewers from diluting the
  // signal on every finding)
  const relevantReviewers = reviews.filter((r) => {
    if (r.status !== 'success') return false;
    const role = roleMap.get(r.role);
    if (!role) return false;
    return role.isSpecialized && role.focus.includes(category);
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
 * Layer 5: Detect disputed findings. All applicable signals are collected —
 * a severity disagreement must not mask a semantic contradiction.
 *
 * 1. Severity dispersion within the group — members that rate the same
 *    finding 2+ levels apart (e.g. critical vs minor) genuinely disagree.
 * 2. Opposing conclusions within the group — generic-pair contradictions
 *    don't veto merging in the deduper, so they can share a group and are
 *    surfaced here.
 * 3. An opposing-conclusion group at the same location. Only groups that are
 *    about the same thing (same category, similar text) can conflict —
 *    without that gate, stray "missing"/"present" wording in unrelated
 *    findings on nearby lines produces false disputes.
 */
function detectDisputes(
  group: DeduplicatedGroup,
  allGroups: DeduplicatedGroup[],
  thresholds: ConsensusThresholds
): { disputed: boolean; disputeDetails?: string } {
  const rep = group.representative;
  const reasons: string[] = [];

  const indices = group.members.map((m) => severityIndex(m.finding.severity as SeverityLevel));
  const spread = Math.max(...indices) - Math.min(...indices);
  if (spread >= 2) {
    const highest = indexToSeverity(Math.min(...indices));
    const lowest = indexToSeverity(Math.max(...indices));
    reasons.push(`Reviewers disagree on severity: rated from ${lowest} to ${highest}`);
  }

  intraGroup: for (let i = 0; i < group.members.length; i++) {
    for (let j = i + 1; j < group.members.length; j++) {
      const a = group.members[i]!.finding;
      const b = group.members[j]!.finding;
      if (hasOpposingSentiment(a, b)) {
        reasons.push(`Members reach opposing conclusions: "${a.title}" vs "${b.title}"`);
        break intraGroup;
      }
    }
  }

  for (const other of allGroups) {
    if (other === group) continue;
    if (other.representative.file !== rep.file) continue;
    if (other.representative.category !== rep.category) continue;
    if (!linesOverlap(rep, other.representative, thresholds.lineWindow)) continue;
    if (combinedSimilarity(rep, other.representative) < thresholds.jaccardThreshold) continue;

    if (hasOpposingSentiment(rep, other.representative)) {
      reasons.push(
        `Conflicting finding at same location: "${rep.title}" vs "${other.representative.title}"`
      );
      break;
    }
  }

  if (reasons.length === 0) return { disputed: false };
  return { disputed: true, disputeDetails: reasons.join('; ') };
}

function severityCounts(group: DeduplicatedGroup): Map<SeverityLevel, number> {
  // One vote per (model, role) reviewer — the deduper collapses bridged
  // same-reviewer variants, but groups built elsewhere must not let one
  // reviewer's repeats count as independent support. If a reviewer's
  // variants disagree, their most severe rating is the vote.
  const byReviewer = new Map<string, SeverityLevel>();
  for (const m of group.members) {
    const key = `${m.model}::${m.role}`;
    const s = m.finding.severity as SeverityLevel;
    const existing = byReviewer.get(key);
    if (existing === undefined || severityIndex(s) < severityIndex(existing)) {
      byReviewer.set(key, s);
    }
  }
  const counts = new Map<SeverityLevel, number>();
  for (const s of byReviewer.values()) {
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/**
 * Base severity = the most common severity among members (ties go to the
 * more severe). Agreement speaks to confidence, not severity — a unanimous
 * nitpick stays a nitpick.
 */
function modeSeverity(group: DeduplicatedGroup): SeverityLevel {
  const counts = severityCounts(group);

  let best: SeverityLevel = group.representative.severity as SeverityLevel;
  let bestCount = 0;
  // Iterating critical → nitpick resolves ties toward the more severe level.
  // bestCount starts at 0 so a level nobody assigned can never win — if no
  // member severity is recognized, the representative's severity stands.
  for (const level of SEVERITY_LEVELS) {
    const count = counts.get(level) ?? 0;
    if (count > bestCount) {
      best = level;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The most severe level that at least `minSupport` members assigned, or null.
 * Used as the elevation ceiling: a single outlier rating never drives the
 * final severity — it is surfaced as a severity-dispersion dispute instead.
 */
function mostSevereWithSupport(
  group: DeduplicatedGroup,
  minSupport: number
): SeverityLevel | null {
  const counts = severityCounts(group);
  for (const level of SEVERITY_LEVELS) {
    if ((counts.get(level) ?? 0) >= minSupport) return level;
  }
  return null;
}

/** Report-level filters from config thresholds. */
export interface ReportThresholds {
  minConfidence?: number;
  minConsensusScore?: number;
}

/**
 * Drop findings below the configured confidence floor or below the
 * configured agreement ratio (consensus score over successful reviews).
 * Returns the kept findings and how many were dropped so reports can say
 * so instead of silently narrowing.
 */
export function applyReportThresholds(
  findings: ConsensusFinding[],
  thresholds: ReportThresholds
): { kept: ConsensusFinding[]; dropped: number } {
  const minConfidence = thresholds.minConfidence ?? 0;
  const minScore = thresholds.minConsensusScore ?? 0;
  const kept = findings.filter((f) => {
    if (f.consensus.confidence < minConfidence) return false;
    const agreementRatio = f.consensus.total > 0 ? f.consensus.score / f.consensus.total : 1;
    return agreementRatio >= minScore;
  });
  return { kept, dropped: findings.length - kept.length };
}

export function computeConsensus(
  groups: DeduplicatedGroup[],
  reviews: ModelReview[],
  roleMap: Map<string, Role>,
  thresholds: Partial<ConsensusThresholds> = {}
): ConsensusFinding[] {
  const resolvedThresholds: ConsensusThresholds = {
    lineWindow: thresholds.lineWindow ?? DEFAULT_THRESHOLDS.dedupeLineWindow,
    jaccardThreshold: thresholds.jaccardThreshold ?? DEFAULT_THRESHOLDS.jaccardThreshold,
  };
  const allModels = [...new Set(reviews.filter((r) => r.status === 'success').map((r) => r.model))];
  const allRoles = [...new Set(reviews.filter((r) => r.status === 'success').map((r) => r.role))];

  return groups.map((group): ConsensusFinding => {
    const rep = group.representative;
    const uniqueModels = [...new Set(group.members.map((m) => m.model))];
    const uniqueRoles = [...new Set(group.members.map((m) => m.role))];
    const uniqueReviewers = new Set(group.members.map((m) => `${m.model}::${m.role}`)).size;

    // Layer 2: Signal scoring
    const diversity = computeDiversity(group, allModels, allRoles);
    const relevance = computeRelevance(group, roleMap);
    const isolation = computeIsolation(group, reviews, roleMap);

    // Layer 3: Raw confidence
    const rawConfidence = diversity * 0.4 + relevance * 0.3 + isolation * 0.3;
    const clampedConfidence = Math.min(1, Math.max(0, rawConfidence));
    const label = confidenceLabel(clampedConfidence);

    // Layer 4: Severity elevation.
    // Only applies when members actually disagree on severity, and only up
    // to the most severe level that at least TWO members assigned — a lone
    // outlier rating never drives the final severity (it still shows up as
    // a severity-dispersion dispute). High-confidence agreement resolves a
    // real disagreement upward; it never invents severity.
    const baseSeverity = modeSeverity(group);
    const supportedMax = mostSevereWithSupport(group, 2);

    let elevation: ConsensusInfo['elevation'] = 'none';
    let finalSeverity = baseSeverity;
    if (supportedMax !== null && severityIndex(supportedMax) < severityIndex(baseSeverity)) {
      if (label === 'Very High' && uniqueReviewers >= 3) {
        finalSeverity = supportedMax;
        elevation = 'strong-consensus';
      } else if (
        (label === 'High' || label === 'Very High') &&
        uniqueModels.length >= 2 &&
        uniqueRoles.length >= 2
      ) {
        finalSeverity = supportedMax;
        elevation = 'cross-model';
      } else if ((label === 'High' || label === 'Very High') && uniqueRoles.length >= 2) {
        finalSeverity = supportedMax;
        elevation = 'cross-role';
      }
    }

    const elevated = finalSeverity !== baseSeverity;
    const original_severity = elevated ? baseSeverity : undefined;

    // Layer 5: Dispute detection
    const { disputed, disputeDetails } = detectDisputes(group, groups, resolvedThresholds);

    const consensus: ConsensusInfo = {
      score: uniqueReviewers,
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
