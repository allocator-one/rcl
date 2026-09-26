import type { SealedAsyncProof } from '../dispatch/checkpoint-async-context.js';
import { z } from 'zod';
import { decodeSupplementalAsync, isSupplementalAsync, type SupplementalAsync } from './supplemental-async.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { decodeCapturedInputs, type CapturedReviewerInputs } from '../dispatch/captured-inputs.js';
import { decodeCheckpointProof, isCheckpointProof, type CheckpointProof, type FrozenCheckpointPlan } from '../dispatch/checkpoint.js';
import { decodeOriginalLaunch, type OriginalLaunch } from '../dispatch/original-launch.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';
import { decodeRecoveryOperation, type RecoveryOperation } from '../dispatch/recovery-operation.js';
import { originalRunReportSchema } from '../telemetry/recovery/source.js';
import { reviewerEvidenceDescriptorSchema, reviewerEvidenceSourceSchema, type ReviewerEvidenceDescriptor, type ReviewerEvidenceSource } from './reviewer-evidence-schema.js';
export { reviewerEvidenceDescriptorSchema, type ReviewerEvidenceDescriptor } from './reviewer-evidence-schema.js';
import { sha256Hex, stableStringify, type RunHeader } from './run-header.js';

/** Shared artifact limit; the complete serialized report must fit, not merely its proof. */
export const MAX_REVIEWER_REPORT_BYTES = MAX_ARTIFACT_BYTES;
export const MAX_REVIEWER_LINEAGE_DEPTH = 32;
const inspected = new WeakSet<object>();

export interface InspectedReviewerReport {
  readonly reportBytes: string;
  readonly reportSha256: string;
  readonly runId: string;
  readonly prTarget: string;
  readonly descriptor: ReviewerEvidenceDescriptor;
  readonly proof: CheckpointProof;
  readonly captured: CapturedReviewerInputs;
  readonly supplementalAsync?: SupplementalAsync;
  readonly asyncExecution?: SealedAsyncProof;
  readonly operation?: RecoveryOperation;
  /** Absent for legacy structural proofs; inspection alone never grants launch eligibility. */
  readonly launch?: OriginalLaunch;
  readonly nativeClaim?: { target: string; attempt?: number; round?: number };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function bound(bytes: string): void {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > MAX_REVIEWER_REPORT_BYTES ||
    Buffer.from(bytes, 'utf8').toString('utf8') !== bytes) throw new Error('reviewer_report_invalid_bytes');
}

function capturedProof(proof: CheckpointProof): CapturedReviewerInputs {
  if (!isCheckpointProof(proof)) throw new Error('reviewer_checkpoint_not_validated');
  const bytes = proof.bindings['captured-inputs'];
  if (bytes === undefined) throw new Error('reviewer_checkpoint_missing_capture');
  return decodeCapturedInputs(bytes, proof.plan);
}

/** Validate local launch bindings without treating its historical deadline as a new launch. */
function originalLaunch(proof: CheckpointProof, captured: CapturedReviewerInputs): OriginalLaunch | undefined {
  const bytes = proof.bindings.launch;
  if (bytes === undefined) return undefined;
  if (proof.bindings.source !== undefined || proof.bindings.operation !== undefined) {
    throw new Error('reviewer_mixed_launch_bindings');
  }
  const launch = decodeOriginalLaunch(bytes);
  if (launch.target !== proof.plan.target || launch.planDigest !== proof.plan.digest ||
    launch.capturedInputsSha256 !== captured.digest) throw new Error('reviewer_original_launch_mismatch');
  return launch;
}

/** Compact descriptor derived from the existing sealed journal, never its own report hash. */
export function describeReviewerEvidence(proof: CheckpointProof, supplementalAsync?: SupplementalAsync): ReviewerEvidenceDescriptor {
  const captured = capturedProof(proof), launch = originalLaunch(proof, captured);
  if (captured.aggregation && !isSupplementalAsync(supplementalAsync)) throw new Error('reviewer_missing_async_snapshot');
  if (supplementalAsync && (!isSupplementalAsync(supplementalAsync) || !captured.aggregation)) {
    throw new Error('reviewer_missing_aggregation_snapshot');
  }
  const base = { version: 1 as const, checkpoint_schema: 1 as const, plan_sha256: proof.plan.digest,
    checkpoint_sha256: proof.digest, captured_inputs_sha256: captured.digest,
    policy: { version: 1 as const, fraction: captured.policy.fraction },
    ...(captured.aggregation ? { aggregation_sha256: captured.aggregation.digest, supplemental_async_sha256: supplementalAsync!.digest } : {}) };
  const sourceBytes = proof.bindings.source, operationBytes = proof.bindings.operation;
  if (sourceBytes === undefined && operationBytes === undefined) return freeze({ ...base, kind: 'original',
    ...(launch ? { launch_sha256: sha256Hex(proof.bindings.launch!) } : {}) });
  if (sourceBytes === undefined || operationBytes === undefined) throw new Error('reviewer_successor_missing_bindings');
  const operation = decodeRecoveryOperation(operationBytes);
  let source: ReviewerEvidenceSource;
  try { source = reviewerEvidenceSourceSchema.parse(JSON.parse(sourceBytes)); }
  catch { throw new Error('reviewer_invalid_source_binding'); }
  if (stableStringify(source) !== sourceBytes || operation.target !== proof.plan.target ||
    operation.planDigest !== proof.plan.digest || operation.capturedInputsSha256 !== captured.digest ||
    source.run_id !== operation.sourceRunId || source.report_sha256 !== operation.sourceReportSha256 ||
    source.checkpoint_sha256 !== operation.sourceCheckpointSha256) throw new Error('reviewer_source_operation_mismatch');
  return freeze({ ...base, kind: 'supplemented', source, operation_id: operation.operationId });
}

/** Exact local source reference; persists in the successor's existing journal before paid work. */
export function reviewerSourceBinding(source: InspectedReviewerReport): string {
  if (!inspected.has(source)) throw new Error('reviewer_report_not_inspected');
  return stableStringify({ run_id: source.runId, report_sha256: source.reportSha256, checkpoint_sha256: source.proof.digest });
}

/**
 * Inspect immutable artifact, capture and target bindings. This is deliberately
 * not an approval/admission API: callers must additionally validate the complete
 * ancestry, aggregation/contribution projections, server receipt, producer
 * authority, successful-seat health and the current native launch claim.
 */
export function inspectReviewerEvidenceReport(
  reportBytes: string, expectedPlan?: FrozenCheckpointPlan, expectedPrTarget?: string,
): InspectedReviewerReport {
  bound(reportBytes);
  const raw = decodeOriginalReport(reportBytes).value;
  const report = originalRunReportSchema.safeParse(raw);
  if (!report.success || !raw || typeof raw !== 'object') throw new Error('reviewer_invalid_report');
  const input = raw as Record<string, unknown>, rawRun = input.run as Record<string, unknown>;
  const descriptor = reviewerEvidenceDescriptorSchema.safeParse(rawRun.reviewer_evidence);
  const artifact = z.object({ checkpoint: z.string(), supplemental_async: z.string().optional() }).strict().safeParse(input.reviewerEvidence);
  if (!descriptor.success || !artifact.success) throw new Error('reviewer_report_missing_proof');
  const proof = decodeCheckpointProof(artifact.data.checkpoint, expectedPlan);
  const supplementalAsync = artifact.data.supplemental_async === undefined ? undefined : decodeSupplementalAsync(artifact.data.supplemental_async);
  const actual = describeReviewerEvidence(proof, supplementalAsync);
  if (stableStringify(actual) !== stableStringify(descriptor.data)) throw new Error('reviewer_descriptor_mismatch');
  const captured = capturedProof(proof), run = report.data.run;
  const target = assertReviewerRunBindings(run, proof, captured, expectedPrTarget);
  const operation = actual.kind === 'supplemented' ? decodeRecoveryOperation(proof.bindings.operation!) : undefined;
  const launch = originalLaunch(proof, captured);
  if (operation && operation.successorRunId !== run.id) throw new Error('reviewer_report_successor_mismatch');
  const result = freeze({ reportBytes, reportSha256: sha256Hex(reportBytes), runId: run.id, prTarget: target,
    descriptor: actual, proof, captured, ...(operation ? { operation } : {}), ...(launch ? { launch } : {}),
    ...(supplementalAsync ? { supplementalAsync } : {}),
    ...(run.converge ? { nativeClaim: run.converge } : {}) });
  inspected.add(result);
  return result;
}

/** Check the original target and prepared inputs before aggregation can dispatch verification. */
export function assertReviewerRunBindings(
  run: Pick<RunHeader, 'id' | 'target' | 'converge' | 'roster' | 'config_sha256' | 'context_files'> & { spec?: { sha256: string } },
  proof: CheckpointProof, captured: CapturedReviewerInputs, expectedPrTarget?: string,
): string {
  if (!isCheckpointProof(proof) || proof.bindings['captured-inputs'] !== captured.bytes ||
    captured.plan.digest !== proof.plan.digest) throw new Error('reviewer_checkpoint_missing_capture');
  const launch = originalLaunch(proof, captured);
  if (launch && (run.id !== launch.runId || run.converge?.target !== launch.target ||
    run.converge.attempt !== launch.originalNativeClaim.attempt || run.converge.round !== launch.originalNativeClaim.round)) {
    throw new Error('reviewer_report_launch_mismatch');
  }
  const target = run.target.repo && run.target.pr_number ? `${run.target.repo.toLowerCase()}#${run.target.pr_number}` : undefined;
  // Native convergence uses an opaque accounting key (for example rcl-105).
  // Keep it distinct from the actual PR; neither key can replace the other.
  const planPrTarget = /^[^/\s]+\/[^/#\s]+#[1-9]\d*$/.test(proof.plan.target)
    ? proof.plan.target.toLowerCase() : undefined;
  if (!target || (planPrTarget !== undefined ? target !== planPrTarget : run.converge?.target !== proof.plan.target) ||
    expectedPrTarget !== undefined && target !== expectedPrTarget.toLowerCase() || run.target.head_sha !== proof.plan.headSha ||
    run.target.diff_sha256 !== proof.plan.patchSha256 || run.config_sha256 !== proof.plan.configSha256 ||
    run.converge && run.converge.target !== proof.plan.target) throw new Error('reviewer_report_target_mismatch');
  // base_sha is an observed upstream tip, not the captured effective merge base.
  // expectedPlan supplies the independently refreshed material-input comparison.
  const roster = run.roster.filter(seat => seat.lane === 'blocking' || seat.lane === 'secondary')
    .map(seat => ({ model: seat.model, role: seat.role, route: seat.provider }));
  if (stableStringify(roster) !== stableStringify(proof.plan.roster.map(({ model, role, route }) => ({ model, role, route })))) {
    throw new Error('reviewer_report_roster_mismatch');
  }
  if (captured.async) {
    const asyncRoster = run.roster.filter(row => row.lane === 'async');
    const expected = proof.plan.chunks.flatMap(chunk => asyncRoster.map(row =>
      ({ chunk: chunk.index, model: row.model, role: row.role, provider: row.provider }))).slice(0, 8);
    const actual = captured.async.calls.map(({ ref }) => ({ chunk: ref.chunk, model: ref.model, role: ref.role, provider: ref.provider }));
    if (stableStringify(actual) !== stableStringify(expected)) throw new Error('reviewer_report_async_roster_mismatch');
  }
  if ((run.spec?.sha256 ?? sha256Hex('')) !== proof.plan.specSha256) throw new Error('reviewer_report_spec_mismatch');
  const context = JSON.parse(captured.contextBytes) as Array<{ label: string; sha256: string }>;
  if (stableStringify(run.context_files) !== stableStringify(context.map(doc => ({ path: doc.label, sha256: doc.sha256 })))) {
    throw new Error('reviewer_report_context_mismatch');
  }
  return target;
}

/** Validates a report-shaped chain. The caller separately establishes how each pair was inspected. */
function validateChain<T extends InspectedReviewerReport>(reports: readonly T[]): readonly T[] {
  if (reports.length === 0 || reports.length > MAX_REVIEWER_LINEAGE_DEPTH) throw new Error('reviewer_lineage_depth');
  const runIds = new Set<string>(), operationIds = new Set<string>();
  let previous: InspectedReviewerReport | undefined;
  for (const report of reports) {
    const id = report.runId.toLowerCase();
    if (runIds.has(id)) throw new Error('reviewer_lineage_duplicate_run');
    runIds.add(id);
    if (!previous) {
      if (report.descriptor.kind !== 'original') throw new Error('reviewer_lineage_missing_origin');
    } else {
      if (report.descriptor.kind !== 'supplemented' || !report.operation) throw new Error('reviewer_lineage_missing_source');
      if (report.asyncExecution?.bytes !== previous.asyncExecution?.bytes || report.asyncExecution?.digest !== previous.asyncExecution?.digest) throw new Error('reviewer_lineage_async_execution_mismatch');
      if (report.supplementalAsync?.digest !== previous.supplementalAsync?.digest) throw new Error('reviewer_lineage_async_mismatch');
      if (report.prTarget !== previous.prTarget) throw new Error('reviewer_lineage_target_mismatch');
      const source = report.descriptor.source, operation = report.operation;
      if (source.run_id !== previous.runId || source.report_sha256 !== previous.reportSha256 || source.checkpoint_sha256 !== previous.proof.digest ||
        report.proof.plan.digest !== previous.proof.plan.digest || report.captured.digest !== previous.captured.digest) {
        throw new Error('reviewer_lineage_source_mismatch');
      }
      const root = reports[0]!;
      if (operation.originalNativeClaim.attempt !== root.nativeClaim?.attempt ||
        operation.originalNativeClaim.round !== root.nativeClaim?.round ||
        !operation.successorNativeClaim ||
        operation.successorNativeClaim.attempt !== report.nativeClaim?.attempt ||
        operation.successorNativeClaim.round !== report.nativeClaim?.round) throw new Error('reviewer_lineage_native_claim_mismatch');
      if (operationIds.has(operation.operationId.toLowerCase())) throw new Error('reviewer_lineage_duplicate_operation');
      operationIds.add(operation.operationId.toLowerCase());
    }
    previous = report;
  }
  return Object.freeze([...reports]);
}

/** Runtime inline-inspection provenance only; never producer/server authority. */
export function isInspectedReviewerReport(value: unknown): value is InspectedReviewerReport {
  return typeof value === 'object' && value !== null && inspected.has(value);
}

/** Validate oldest-to-newest immutable report evidence. */
export function validateReviewerReportChain(reports: readonly InspectedReviewerReport[]): readonly InspectedReviewerReport[] {
  for (const report of reports) if (!inspected.has(report)) throw new Error('reviewer_report_not_inspected');
  return validateChain(reports);
}

/** Validate separately retained private artifact pairs without fabricating inline evidence. */
export function validateInspectedReviewerArtifactChain<T extends InspectedReviewerReport>(reports: readonly T[]): readonly T[] {
  return Object.freeze([...validateChain(reports)]);
}
