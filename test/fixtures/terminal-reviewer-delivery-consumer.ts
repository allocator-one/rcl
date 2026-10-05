import {
  deliverTerminalReviewerRun,
  type TerminalReviewerDeliveryOptions,
  type TerminalReviewerDeliveryResult,
} from '../../dist/telemetry/terminal-reviewer-delivery.js';
import type { TelemetryRuntime } from '../../dist/telemetry/deliver.js';

declare const runtime: TelemetryRuntime;

async function consumePublished458Contract(options: TerminalReviewerDeliveryOptions): Promise<TerminalReviewerDeliveryResult> {
  const result = await deliverTerminalReviewerRun(runtime, options);
  result.outcome.exitCode;
  result.reportSha256.toUpperCase();
  result.reviewerArtifactSha256.toUpperCase();
  return result;
}

void consumePublished458Contract({ target: 'rcl-159', runId: '00000000-0000-4000-8000-000000000159' });
