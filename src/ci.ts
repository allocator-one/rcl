import type { ReviewResult } from './consensus/types.js';
import { assertReviewerHealth, type ReviewerHealth } from './report/reviewer-health.js';

export interface CiVerdict {
  exitCode: number;
  message?: string;
}

/**
 * Decide the CI exit status for a completed review.
 *
 * A run where every reviewer errored produces zero findings — which without
 * this check looks identical to "clean" and exits 0, greenlighting code that
 * was never actually reviewed. That case fails first; blocking findings fail
 * second. New proof-bearing reports pass a validated frozen-matrix health
 * projection; legacy callers retain the original zero-success rule.
 */
export function evaluateCiGate(result: ReviewResult, health?: ReviewerHealth): CiVerdict {
  if (health !== undefined) {
    assertReviewerHealth(health);
    if (!health.conclusive) {
      return {
        exitCode: 1,
        message: `CI: ${health.successfulSeats.length}/${health.policy.seatCount} blocking reviewers completed every required chunk; ${health.policy.minimumSuccessful} required. Reviewer health is inconclusive. Exiting with code 1.`,
      };
    }
  }
  if (result.stats.successfulReviews === 0) {
    return {
      exitCode: 1,
      message: `CI: 0/${result.stats.totalReviews} reviewers succeeded — nothing was reviewed. Exiting with code 1.`,
    };
  }

  // Gating-annotated findings (RCL-23) block on their gating reason —
  // consensus, critical, or verified — so a refuted single-model claim no
  // longer fails CI. Legacy reports without annotations keep the pure
  // severity gate.
  const blocking = result.findings.filter((f) =>
    f.gating
      ? f.gating.reason !== 'none'
      : f.severity === 'critical' || f.severity === 'important'
  );
  if (blocking.length > 0) {
    return {
      exitCode: 1,
      message: `CI: ${blocking.length} blocking finding(s) found. Exiting with code 1.`,
    };
  }

  return { exitCode: 0 };
}
