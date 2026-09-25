import { z } from 'zod';
import type { ConsensusFinding } from '../consensus/types.js';
import { CheckpointJournal, checkpointPath, exportCheckpointProof } from '../dispatch/checkpoint.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { inspectReviewerArtifact } from '../report/reviewer-artifact.js';
import { sha256Hex, stableStringify, type RunHeaderInput } from '../report/run-header.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';
import { originalRunReportSchema } from '../telemetry/recovery/source.js';
import { loadConvergeAttemptState } from './attempt-budget.js';
import { loadConvergeRunState, processRoundReport, type RoundReport } from './run-state.js';
import { ownedNativeTargetCommonDir, withNativeTarget, withOwnedNativeOperation, type NativeTargetOwnership } from './target-ownership.js';

export interface ProcessRetainedRoundOptions {
  gitCommonDir: string;
  target: string;
  round: number;
  reportBytes: string;
  maxRounds?: number;
  currentHeadSha: string;
  ownership?: NativeTargetOwnership;
}

/** Retained-mode guard binding; legacy launch input hashing is unchanged. */
export function retainedLaunchInputSha256(capturedInputsSha256: string,
  run: Pick<RunHeaderInput, 'target' | 'roster' | 'spec'>): string {
  if (!/^[a-f0-9]{64}$/.test(capturedInputsSha256)) throw new Error('retained_report_invalid_capture_digest');
  return sha256Hex(stableStringify({ version: 1, kind: 'retained-review-launch', capturedInputsSha256,
    target: run.target, roster: run.roster, ...(run.spec === undefined ? {} : { spec: run.spec }) }));
}

/**
 * Admit only the completed original guarded launch, under the same native
 * ownership used for validation. Serialized health/counters are comparison
 * claims; the sealed local proof and spent native claim supply their evidence.
 * Successor admission and verifier authority remain unsupported here.
 */
export async function processRetainedRoundReport(input: ProcessRetainedRoundOptions): Promise<RoundReport> {
  const options = { ...input, target: input.target.trim() };
  if (!options.target || !Number.isSafeInteger(options.round) || options.round < 1 ||
    !/^[a-f0-9]{40}$/.test(options.currentHeadSha) || typeof options.reportBytes !== 'string' ||
    Buffer.byteLength(options.reportBytes, 'utf8') > MAX_ARTIFACT_BYTES) throw new Error('retained_report_invalid_input');
  const decoded = decodeOriginalReport(options.reportBytes);
  if (decoded.transformations.length) throw new Error('retained_report_unsupported_representation');
  const runId = z.object({ run: z.object({ id: z.uuid() }) }).parse(decoded.value).run.id;
  const processOwned = async (ownership: NativeTargetOwnership): Promise<RoundReport> => {
    const commonDir = await ownedNativeTargetCommonDir(ownership, options.gitCommonDir, options.target);
    const journal = await CheckpointJournal.inspectRead(checkpointPath(commonDir, options.target, runId));
    const plan = journal.getPlan(), bindings = await journal.readBindings();
    if (bindings.source !== undefined || bindings.operation !== undefined) {
      throw new Error('retained_report_supplemented_authority_unsupported');
    }
    if (!(await journal.read()).finalized) throw new Error('retained_report_unsealed_checkpoint');
    const terminal = await journal.readTerminalReport();
    if (!terminal) throw new Error('retained_report_missing_terminal');
    if (terminal.reportBytes !== options.reportBytes || terminal.reportSha256 !== sha256Hex(options.reportBytes)) {
      throw new Error('retained_report_terminal_mismatch');
    }
    const inspected = inspectReviewerArtifact(terminal.reviewerArtifactBytes, {
      expectedReportBytes: options.reportBytes, expectedRunId: runId, expectedTarget: options.target, expectedPlan: plan,
    });
    const proof = await exportCheckpointProof(journal);
    if (proof.digest !== inspected.proof.digest || proof.bytes !== inspected.proof.bytes ||
      inspected.assembly.projection.proofs.length !== 1) throw new Error('retained_report_checkpoint_mismatch');
    if (inspected.descriptor.kind !== 'original' || !inspected.launch) throw new Error('retained_report_original_launch_required');
    if (options.currentHeadSha !== plan.headSha) throw new Error('retained_report_head_mismatch');
    const health = inspected.artifact.health;
    if (!health.conclusive) throw new Error('retained_report_inconclusive_health');
    const [native, attempts] = await Promise.all([
      loadConvergeRunState(commonDir, options.target), loadConvergeAttemptState(commonDir, options.target),
    ]);
    const launch = native?.lastLaunch, claim = inspected.launch.originalNativeClaim;
    const spent = attempts?.attempts.find(item => item.attempt === claim.attempt);
    const expectedHealth = { version: 1, policy: health.policy, successfulSeats: health.successfulSeats.length };
    if (!launch || launch.status !== 'completed' || launch.runId !== runId || launch.headSha !== plan.headSha ||
      launch.round !== options.round || launch.round !== claim.round || launch.attempt !== claim.attempt ||
      launch.inputSha256 !== retainedLaunchInputSha256(inspected.captured.digest, inspected.assembly.run) ||
      launch.reportJsonSha256 !== terminal.reportSha256 || launch.successfulReviews !== health.successfulSeats.length ||
      launch.totalReviews !== health.policy.seatCount || stableStringify(launch.reviewerHealth) !== stableStringify(expectedHealth) ||
      attempts?.attemptsUsed !== claim.attempt || !spent || spent.pid !== launch.pid) {
      throw new Error('retained_report_native_launch_mismatch');
    }
    // Minority provider errors and pending server delivery do not change the
    // derived complete-seat quorum. This operation admits locally only.
    if (inspected.artifact.validation.gate.validation !== 'deterministic') {
      throw new Error('retained_report_verifier_evidence_required');
    }
    // Shape validation does not replace the exact object or discard gating and
    // modern report identities. The artifact already proved its entire body.
    originalRunReportSchema.parse(decoded.value);
    const findings = (decoded.value as { findings: ConsensusFinding[] }).findings;
    return processRoundReport({ gitCommonDir: commonDir, target: options.target, round: options.round,
      findings, runId, reportSha256: terminal.reportSha256, maxRounds: options.maxRounds, ownership });
  };
  return options.ownership
    ? withOwnedNativeOperation(options.ownership, options.gitCommonDir, options.target, processOwned)
    : withNativeTarget(options.gitCommonDir, options.target, processOwned);
}
