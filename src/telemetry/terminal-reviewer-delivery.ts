import type { ReviewResult } from '../consensus/types.js';
import { resolveGitCommonDir } from '../converge/attempt-budget.js';
import { loadReviewerLineage } from '../evidence/reviewer-lineage.js';
import { sha256Hex } from '../report/run-header.js';
import { deliverRun, type DeliveryOutcome, type TelemetryRuntime } from './deliver.js';

export interface TerminalReviewerDeliveryOptions {
  target: string;
  runId: string;
  commonDir?: string;
  cwd?: string;
}

export interface TerminalReviewerDeliveryResult {
  outcome: DeliveryOutcome;
  reportSha256: string;
  reviewerArtifactSha256: string;
}

/**
 * Reopen an immutable terminal checkpoint pair and retry only its Harness
 * delivery. Lineage inspection authenticates the exact report and private
 * artifact locally; this path never launches a reviewer or verifier.
 */
export async function deliverTerminalReviewerRun(
  runtime: TelemetryRuntime,
  options: TerminalReviewerDeliveryOptions,
): Promise<TerminalReviewerDeliveryResult> {
  const commonDir = options.commonDir ?? await resolveGitCommonDir(options.cwd);
  const lineage = await loadReviewerLineage({ commonDir, target: options.target, runId: options.runId });
  const { inspected, terminal } = lineage.latest;
  const result = JSON.parse(terminal.reportBytes) as ReviewResult;
  const outcome = await deliverRun(runtime, {
    result,
    artifacts: { report_json: terminal.reportBytes },
    reviewerArtifact: inspected.artifact,
    evidenceRequired: true,
  });
  return {
    outcome,
    reportSha256: sha256Hex(terminal.reportBytes),
    reviewerArtifactSha256: sha256Hex(terminal.reviewerArtifactBytes),
  };
}
