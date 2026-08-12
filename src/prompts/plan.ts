import { OUTPUT_SCHEMA } from './base.js';

export const PLAN_FOCUS_MODES = ['feasibility', 'completeness', 'risks', 'timeline'] as const;
export type PlanFocus = (typeof PLAN_FOCUS_MODES)[number];

export function isPlanFocus(value: string): value is PlanFocus {
  return (PLAN_FOCUS_MODES as readonly string[]).includes(value);
}

const FOCUS_GUIDANCE: Record<PlanFocus, string> = {
  feasibility:
    'Focus specifically on FEASIBILITY: technical complexity that the plan underestimates, resource requirements, potential blockers, dependencies on other systems or teams, and steps that cannot work as described.',
  completeness:
    'Focus specifically on COMPLETENESS: missing requirements, unhandled edge cases, absent error/rollback/migration handling, and missing testing or rollout strategy.',
  risks:
    'Focus specifically on RISKS: security concerns in the design, scalability limits, data-loss scenarios, operational burden, and irreversible decisions taken too early.',
  timeline:
    'Focus specifically on TIMELINE: unrealistic estimates, missing task breakdown, critical-path dependencies, sequencing problems, and steps that block parallel work.',
};

/**
 * Reframes a code-review role for plan review. Prepended to the role's
 * system prompt so specialist instincts (security, edge cases, architecture)
 * apply to the design instead of to a diff.
 */
export const PLAN_ROLE_PREAMBLE = `You are reviewing an IMPLEMENTATION PLAN document, not code. Apply your reviewing expertise to the plan's design decisions, sequencing, and gaps — the cheapest bugs to fix are the ones caught before any code exists.

`;

/**
 * Plan-mode analog of BASE_REVIEW_PROMPT: identical output contract (the
 * consensus pipeline depends on it), category semantics reinterpreted for
 * plan documents.
 */
export function buildPlanPrompt(focus?: PlanFocus): string {
  return `You are reviewing an implementation plan. Identify problems in the plan itself: infeasible steps, missing pieces, risks, and sequencing errors.

## Output Format

You MUST respond with ONLY valid JSON matching this schema — no markdown, no prose outside JSON:

${OUTPUT_SCHEMA}

## Review Guidelines

- ${focus ? FOCUS_GUIDANCE[focus] : 'Provide a comprehensive plan review covering feasibility, completeness, risks, and timeline.'}
- Focus on real, actionable problems in the plan — not stylistic preferences about how it is written
- Severity levels:
  - critical: the plan cannot work as designed, or following it risks data loss / security holes
  - important: a significant gap, unmanaged risk, or sequencing error that will surface during implementation
  - minor: an underspecified step or missing detail worth clarifying before starting
  - nitpick: small clarity or structure suggestions
- Categories (reinterpreted for plan documents):
  - security: security gaps in the design — authn/authz, data exposure, secrets handling, trust boundaries
  - correctness: infeasible or contradictory steps, wrong assumptions, logic that cannot work as described
  - best-practices: process gaps — rollback, migration, monitoring, phasing, ownership
  - tests: missing or inadequate testing/validation strategy
  - api-design: interface contracts, schema design, compatibility and versioning concerns
- The plan is presented in unified-diff form (every line prefixed with +) purely for tooling; treat it as the complete document
- "file" is the plan document's path; startLine/endLine refer to the plan's own line numbers as shown
- Only report findings grounded in the plan text — do not speculate about code that does not exist yet, except to flag that the plan fails to account for it
- Use unique IDs for each finding (e.g., "f001", "f002", ...)
- If no issues found, return: {"findings": []}`;
}
