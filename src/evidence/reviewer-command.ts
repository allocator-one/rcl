import { CheckpointJournal, checkpointPath } from '../dispatch/checkpoint.js';
import { decodeRecoveryOperation } from '../dispatch/recovery-operation.js';
import { validateLaunchProviders } from '../converge/launch-preflight.js';
import { loadConvergeAttemptState } from '../converge/attempt-budget.js';
import { loadConvergeRunState, writeState } from '../converge/run-state.js';
import { retainedLaunchInputSha256 } from '../converge/retained-report.js';
import { withNativeTarget } from '../converge/target-ownership.js';
import { renderReportArtifacts } from '../output/artifacts.js';
import type { ReviewResult } from '../consensus/types.js';
import type { RunHeaderInput } from '../report/run-header.js';
import { deliverRun, type DeliveryOutcome, type TelemetryRuntime } from '../telemetry/deliver.js';
import type { Attestation } from '../telemetry/attest.js';
import { AttestedReviewerDelivery } from '../telemetry/attested-reviewer-delivery.js';
import { createReviewerRecoveryPreflight } from '../telemetry/reviewer-preflight.js';
import { applyReviewerRecovery, resumeReviewerRecovery, type ApplyReviewerRecoveryOptions, type ReviewerRecoveryPreflight } from './reviewer-recovery.js';
import { loadReviewerLineage } from './reviewer-lineage.js';

export interface ReviewerCommandOptions {
  mode: 'apply' | 'resume';
  commonDir: string;
  target: string;
  runId: string;
  successorRunId: string;
  currentHeadSha: string;
  freshCaptureBytes: string;
  currentRunBindings: Pick<RunHeaderInput, 'target' | 'roster' | 'spec'>;
  runtime: TelemetryRuntime;
  attestation?: Attestation;
  rclVersion: string;
  runner: RunHeaderInput['runner'];
  bounds?: Pick<ApplyReviewerRecoveryOptions, 'operationId' | 'startedAtMs' | 'expiresAtMs' | 'maxAdditionalCalls' | 'maxAttemptsPerCell'>;
}

/** Record delivery only for the still-current exact retained native launch; never admit a round. */
async function markDelivery(options: ReviewerCommandOptions, runId: string, reportSha256: string, pending: boolean): Promise<void> {
  await withNativeTarget(options.commonDir, options.target, async ownership => {
    const state = await loadConvergeRunState(options.commonDir, options.target);
    const attempts = await loadConvergeAttemptState(options.commonDir, options.target);
    const launch = state?.lastLaunch;
    if (!state || !launch || launch.status !== 'completed' || launch.runId !== runId ||
      launch.headSha !== options.currentHeadSha || launch.reportJsonSha256 !== reportSha256 ||
      attempts?.attemptsUsed !== launch.attempt || !attempts.attempts.some(item => item.attempt === launch.attempt && item.pid === launch.pid)) {
      throw new Error('reviewer_recovery_delivery_native_mismatch');
    }
    state.lastLaunch = { ...launch, deliveryPending: pending };
    await writeState(options.commonDir, state, ownership);
  });
}

/** Public orchestration reuses the actual guard, exact stored operation, and current scoped transport. */
export async function executeReviewerCommand(options: ReviewerCommandOptions): Promise<{
  kind: 'completed'; report: ReviewResult; reportBytes: string; delivery: DeliveryOutcome; runId: string;
} | { kind: 'already_quorate'; sourceRunId: string }> {
  let transport: AttestedReviewerDelivery | undefined, transportBytes: string | undefined;
  const coordinator = (bytes: string, kind: 'original' | 'successor') => {
    if (!options.attestation) return undefined;
    if (transport && transportBytes !== bytes) throw new Error('reviewer_recovery_operation_changed');
    transport ??= new AttestedReviewerDelivery(options.attestation, { kind, operationBytes: bytes, rclVersion: options.rclVersion });
    transportBytes = bytes; return transport;
  };
  const preflight = async (request: ReviewerRecoveryPreflight, bytes: string) => {
    validateLaunchProviders(options.currentRunBindings.roster.filter(seat => seat.lane !== 'async').map(seat => seat.provider));
    if (options.runtime.level !== 'full' || !options.runtime.repoManaged || !options.runtime.sink || !options.runtime.credential) {
      throw new Error('reviewer_recovery_capability_unavailable');
    }
    if (options.attestation) await coordinator(bytes, 'successor')!.preflight(request);
    else await createReviewerRecoveryPreflight(options.runtime.sink)(request);
  };
  const current = { commonDir: options.commonDir, target: options.target, successorRunId: options.successorRunId,
    currentHeadSha: options.currentHeadSha, freshCaptureBytes: options.freshCaptureBytes,
    currentRunBindings: options.currentRunBindings, rclVersion: options.rclVersion, runner: options.runner,
    preflight, onLateAuditError: () => { process.stderr.write('A late reviewer observation could not be retained.\n'); } };
  let runId = options.successorRunId;
  if (options.mode === 'apply') {
    if (!options.bounds) throw new Error('reviewer_recovery_bounds_required');
    const result = await applyReviewerRecovery({ ...current, ...options.bounds, sourceRunId: options.runId });
    if (result.kind === 'already_quorate') return result;
  } else {
    // Originals can only redeliver an already sealed terminal. No original
    // crash may reset native accounting or synthesize a new launch.
    const source = await loadReviewerLineage({ commonDir: options.commonDir, target: options.target, runId: options.runId }).catch(() => undefined);
    if (source?.latest.kind === 'original') {
      const entry = source.latest;
      if (source.plan.headSha !== options.currentHeadSha || entry.captured.bytes !== options.freshCaptureBytes ||
        retainedLaunchInputSha256(entry.captured.digest, entry.inspected.assembly.run) !==
        retainedLaunchInputSha256(entry.captured.digest, options.currentRunBindings)) throw new Error('reviewer_recovery_input_mismatch');
      runId = options.runId;
    } else await resumeReviewerRecovery(current);
  }
  const lineage = await loadReviewerLineage({ commonDir: options.commonDir, target: options.target, runId });
  const entry = lineage.latest, parent = lineage.runs.at(-2), report = JSON.parse(entry.terminal.reportBytes) as ReviewResult;
  // A delivery refusal leaves the immutable terminal and its native pending flag
  // intact. Current credentials never authorize changing the stored report.
  await markDelivery(options, runId, entry.terminal.reportSha256, true);
  let delivery: DeliveryOutcome;
  try {
    const attestedReviewer = coordinator(entry.proof.bindings[entry.kind === 'original' ? 'launch' : 'operation']!, entry.kind);
    delivery = await deliverRun(options.runtime, { result: report,
      artifacts: { ...renderReportArtifacts(report), report_json: entry.terminal.reportBytes }, evidenceRequired: true,
      reviewerArtifact: entry.inspected.artifact, ...(attestedReviewer ? { attestedReviewer } : {}),
      ...(parent ? { reviewerSource: { run_id: parent.runId, report_sha256: parent.terminal.reportSha256,
        reviewer_artifact_sha256: parent.inspected.artifact.digest } } : {}) });
  } catch {
    delivery = { status: 'rejected', spooled: false, exitCode: 4, runId,
      line: 'Private delivery pending; preserve this terminal and resume only with its same live scoped session. No reviewers were relaunched.' };
  }
  if (delivery.status === 'recorded') await markDelivery(options, runId, entry.terminal.reportSha256, false);
  return { kind: 'completed', report, reportBytes: entry.terminal.reportBytes, delivery, runId };
}

/** Finalize only an expired saved successor offline; a live unfinished operation must use normal preflight. */
export async function finalizeReviewerLocally(options: Pick<ReviewerCommandOptions,
  'commonDir' | 'target' | 'runId' | 'currentHeadSha' | 'rclVersion' | 'runner'>) {
  const journal = await CheckpointJournal.inspectRead(checkpointPath(options.commonDir, options.target, options.runId));
  const bindings = await journal.readBindings();
  if (!bindings.operation || bindings.launch) throw new Error('reviewer_recovery_local_only_successor_required');
  const operation = decodeRecoveryOperation(bindings.operation);
  if (!(await journal.readTerminalReport()) && Date.now() < operation.expiresAtMs) throw new Error('reviewer_recovery_local_only_operation_live');
  const source = await loadReviewerLineage({ commonDir: options.commonDir, target: options.target, runId: operation.sourceRunId });
  return resumeReviewerRecovery({ ...options, successorRunId: options.runId, freshCaptureBytes: source.latest.captured.bytes,
    currentRunBindings: source.latest.inspected.assembly.run,
    preflight: async () => { throw new Error('reviewer_recovery_local_only_paid_work_forbidden'); },
    adapterFactory: () => { throw new Error('reviewer_recovery_local_only_provider_forbidden'); },
    onLateAuditError: () => { throw new Error('reviewer_recovery_local_only_late_result'); } });
}
