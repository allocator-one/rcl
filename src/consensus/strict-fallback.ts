import { VerificationPassTimeoutError, type GatingInfo } from './gating.js';
import type { ConsensusFinding, ReviewResult } from './types.js';

/**
 * The strict fallback (RCL-160, RCL-167; Harness IO-14611). When a
 * verified-consensus run's whole verification pass fails, the round falls
 * back to severity gating: every kept critical or important finding blocks,
 * without a verifier verdict. The report says so explicitly rather than by
 * leaving its findings unlabelled, which delivery would read as `none`:
 *
 *   - `run.gating.strict_fallback` is `{version: 1, cause}`;
 *   - every kept critical or important finding is a `strict_fallback`
 *     blocker whose verification is `unavailable`;
 *   - every other finding, kept or in the appendix, is `none` without
 *     verification;
 *   - the CI exit code is positive and there are no verification statistics.
 *
 * Harness counts such a run only once it holds the run's `report_json`.
 */
export type StrictFallbackCause = 'verification_pass_timeout' | 'verification_pass_failed';

export interface StrictFallbackMarker {
  version: 1;
  cause: StrictFallbackCause;
}

const CAUSES = new Set<unknown>(['verification_pass_timeout', 'verification_pass_failed']);
const BLOCKING_SEVERITIES = new Set<unknown>(['critical', 'important']);

const NOTES: Record<StrictFallbackCause, string> = {
  verification_pass_timeout: 'The whole verification pass timed out; this finding blocks on its severity, unverified.',
  verification_pass_failed: 'The whole verification pass failed; this finding blocks on its severity, unverified.',
};

/** How a failed verification pass is declared. */
export function strictFallbackCause(failure: unknown): StrictFallbackCause {
  return failure instanceof VerificationPassTimeoutError ? 'verification_pass_timeout' : 'verification_pass_failed';
}

/**
 * Labels a failed pass's findings as the strict fallback, without changing
 * the inputs. With no kept critical or important finding there is nothing the
 * pass could have decided, so no fallback is declared and everything is
 * `none`, as a completed pass would have labelled it.
 */
export function applyStrictFallback(
  findings: ConsensusFinding[],
  appendix: ConsensusFinding[],
  cause: StrictFallbackCause,
  verificationModel: string | undefined,
): { findings: ConsensusFinding[]; appendix: ConsensusFinding[]; marker?: StrictFallbackMarker } {
  const blocker: GatingInfo = {
    reason: 'strict_fallback',
    verification: { ...(verificationModel !== undefined ? { model: verificationModel } : {}), verdict: 'unavailable', note: NOTES[cause] },
  };
  const label = (finding: ConsensusFinding, gating: GatingInfo): ConsensusFinding => ({ ...structuredClone(finding), gating: structuredClone(gating) });
  const kept = findings.map((f) => label(f, BLOCKING_SEVERITIES.has(f.severity) ? blocker : { reason: 'none' }));
  return {
    findings: kept,
    appendix: appendix.map((f) => label(f, { reason: 'none' })),
    ...(kept.some((f) => f.gating!.reason === 'strict_fallback') ? { marker: { version: 1, cause } } : {}),
  };
}

/** Whether a run's gating map declares the strict fallback. */
export function declaresStrictFallback(gating: unknown): boolean {
  return typeof gating === 'object' && gating !== null && Object.hasOwn(gating, 'strict_fallback');
}

function validMarker(marker: unknown): boolean {
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return false;
  const keys = Object.keys(marker);
  const { version, cause } = marker as Record<string, unknown>;
  return keys.length === 2 && version === 1 && CAUSES.has(cause);
}

type ReportLike = Pick<ReviewResult, 'run' | 'findings' | 'belowThresholdFindings' | 'stats'>;

/**
 * Checks a report against the strict-fallback contract, as Harness checks
 * its envelope: the first problem, or undefined when the report neither
 * declares nor claims the fallback, or keeps to it exactly.
 */
export function strictFallbackProblem(report: ReportLike): string | undefined {
  const groups = [
    ['findings', report.findings ?? []],
    ['belowThresholdFindings', report.belowThresholdFindings ?? []],
  ] as const;
  const gating = report.run?.gating;
  if (!declaresStrictFallback(gating)) {
    for (const [group, findings] of groups) {
      const index = findings.findIndex((f) => f?.gating?.reason === 'strict_fallback');
      if (index >= 0) return `${group}.${index} is a strict_fallback blocker without run.gating.strict_fallback`;
    }
    return undefined;
  }
  if (!validMarker(gating!.strict_fallback)) {
    return 'run.gating.strict_fallback must be {version: 1, cause: verification_pass_timeout | verification_pass_failed}';
  }
  if (gating!.mode !== 'verified-consensus') return 'a strict fallback requires run.gating.mode verified-consensus';
  if (!(typeof report.run!.ci_exit_code === 'number' && report.run!.ci_exit_code > 0)) {
    return 'a strict fallback requires a positive run.ci_exit_code';
  }
  if (report.stats?.verification != null) return 'a strict fallback allows no stats.verification';
  let blockers = 0;
  for (const [group, findings] of groups) {
    for (const [index, finding] of findings.entries()) {
      if (group === 'findings' && BLOCKING_SEVERITIES.has(finding?.severity)) {
        if (finding.gating?.reason !== 'strict_fallback' || finding.gating.verification?.verdict !== 'unavailable') {
          return `${group}.${index} must be a strict_fallback blocker with unavailable verification`;
        }
        blockers += 1;
      } else if (finding?.gating?.reason !== 'none' || finding.gating.verification !== undefined) {
        return `${group}.${index} must be gating none without verification`;
      }
    }
  }
  return blockers > 0 ? undefined : 'a strict fallback requires at least one critical or important blocker';
}
