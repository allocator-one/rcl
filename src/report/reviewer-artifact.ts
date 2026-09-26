import type { SealedAsyncProof } from '../dispatch/checkpoint-async-context.js';
import type { AsyncProof } from '../dispatch/checkpoint-async.js';
import { z } from 'zod';
import { evaluateCiGate } from '../ci.js';
import type { GatingInfo } from '../consensus/gating.js';
import type { ModelReview, ReviewResult } from '../consensus/types.js';
import { decodeCheckpointProof, type CheckpointProof, type FrozenCheckpointPlan } from '../dispatch/checkpoint.js';
import { decodeOriginalLaunch, type OriginalLaunch } from '../dispatch/original-launch.js';
import { decodeRecoveryOperation, type RecoveryOperation } from '../dispatch/recovery-operation.js';
import type { Diff } from '../resolver/types.js';
import { decodeCapturedInputs, type CapturedReviewerInputs } from '../dispatch/captured-inputs.js';
import { mergeChunkReviews } from '../dispatch/merge.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { sanitizeForDelivery } from '../telemetry/envelope.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';
import { originalRunReportSchema, UUID } from '../telemetry/recovery/source.js';
import { type CheckpointAssemblyInput, type CheckpointAssemblyContribution,
  type CheckpointAssemblyObservation } from './checkpoint-assembly.js';
import { deriveCheckpointGating, type SealedVerificationProof } from './checkpoint-gating.js';
import { projectCheckpointReport, type PhysicalCheckpointAttempt } from './checkpoint-projection.js';
import { decodeSupplementalAsync, type SupplementalAsync } from './supplemental-async.js';
import { describeReviewerEvidence, isInspectedReviewerReport, validateInspectedReviewerArtifactChain, MAX_REVIEWER_LINEAGE_DEPTH, type InspectedReviewerReport, type ReviewerEvidenceDescriptor } from './reviewer-evidence.js';
import type { ReviewerHealth } from './reviewer-health.js';
import { buildRunHeader, parseSpecSource, sha256Hex, stableStringify, type RunHeader } from './run-header.js';

export interface ReviewerArtifactContext {
  /** Reconstructed with the existing validated proof/async decoders; never a deserialized cast. */
  assembly: CheckpointAssemblyInput;
  representation: { version: 1; parseFailures: boolean };
  /** Optional complete inspected chain; external producer/server authority remains separate. */
  lineage?: readonly (InspectedReviewerReport | InspectedReviewerArtifact)[];
  /** Sealed verifier transcript, structurally replayed only; it confers no external authority. */
  verificationProof?: SealedVerificationProof;
}
export interface ReviewerArtifactGate {
  validation: 'deterministic' | 'requires_verifier_evidence';
  reportedCiExitCode: number;
  /** Fail-closed offline projection, NOT a replacement for the final convergence gate. */
  conservativeCiExitCode: number;
  unresolvedFindingIdentities: string[];
  annotations: Array<{ identity: string; disposition: 'kept' | 'below_threshold'; gating: GatingInfo }>;
}
type AttemptReference = Omit<PhysicalCheckpointAttempt, 'review' | 'reviewBytes'>;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
/** PRIVATE bytes contain exact prompts/results. Never attach this object to ordinary report output. */
export type ReviewerArtifact = DeepReadonly<{
  version: 1;
  bytes: string;
  digest: string;
  reportSha256: string;
  validation: { body: 'deterministic'; health: 'derived'; gate: ReviewerArtifactGate };
  health: ReviewerHealth;
  contributions: CheckpointAssemblyContribution[];
  observations: CheckpointAssemblyObservation[];
  newPhysicalAttempts: AttemptReference[];
  newAsyncPhysicalAttempts?: Array<Omit<AsyncProof['physicalAttempts'][number], 'reviewBytes'>>;
}>;
const validated = new WeakSet<object>();
const inspectedArtifacts = new WeakSet<object>();

/** Runtime structural-inspection provenance only; never producer/server authority. */
export function isInspectedReviewerArtifact(value: unknown): value is InspectedReviewerArtifact {
  return typeof value === 'object' && value !== null && inspectedArtifacts.has(value);
}

function validateArtifactLineage(reports: readonly (InspectedReviewerReport | InspectedReviewerArtifact)[]) {
  for (const report of reports) {
    if (!isInspectedReviewerArtifact(report) && !isInspectedReviewerReport(report)) {
      throw new Error('reviewer_report_not_inspected');
    }
  }
  return validateInspectedReviewerArtifactChain(reports);
}
const representationSchema = z.object({ version: z.literal(1), parseFailures: z.boolean() }).strict();
const integer = z.number().int().nonnegative().safe();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uuidSchema = z.string().regex(UUID);
const metadataSchema = z.object({
  startTime: z.number().finite().nonnegative(),
  diff: z.object({ source: z.enum(['github', 'local']),
    files: z.array(z.object({ patchIndex: integer, language: z.string() }).strict()) }).strict(),
  run: z.object({
    id: uuidSchema, rclVersion: z.string(), command: z.enum(['review', 'review-plan']),
    target: z.object({ kind: z.enum(['pr', 'patch', 'staged', 'working_tree', 'plan']), repo: z.string().optional(),
      prNumber: integer.positive().optional(), url: z.string().optional(), headSha: z.string().optional(), baseSha: z.string().optional(),
      headRef: z.string().optional(), baseRef: z.string().optional() }).strict(),
    roster: z.array(z.object({ model: z.string(), role: z.string(), provider: z.string(),
      lane: z.enum(['blocking', 'secondary', 'async', 'verification']) }).strict()),
    spec: z.object({ source: z.string(), sha256: hashSchema }).strict().optional(),
    contextFiles: z.array(z.object({ path: z.string(), sha256: hashSchema }).strict()).optional(),
    plan: z.object({ focus: z.string() }).strict().optional(),
    runner: z.object({ kind: z.enum(['agent', 'ci', 'human']), agent: z.string().optional(), ci_run_id: z.string().optional(), host: z.string().optional() }).strict(),
    startedAt: z.iso.datetime(),
    converge: z.object({ target: z.string(), attempt: integer.positive().optional(), round: integer.positive().optional() }).strict().optional(),
  }).strict(),
}).strict();
const patchSchema = z.array(z.object({ filename: z.string(), status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  previousFilename: z.string().nullable(), patch: z.string(), additions: integer, deletions: integer, blobSha: z.string().nullable() }).strict());

/** Small rendering metadata only; exact patches/prompts remain in the one captured input store. */
function assemblyMetadata(input: CheckpointAssemblyInput) {
  const order = input.diff.files.map((file, index) => ({ filename: file.filename, index }))
    .sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  const indexes = new Map(order.map((file, index) => [file.index, index]));
  return metadataSchema.parse({ startTime: input.startTime,
    diff: { source: input.diff.source, files: input.diff.files.map((file, index) => ({ patchIndex: indexes.get(index), language: file.language })) },
    run: { ...input.run, startedAt: input.run.startedAt.toISOString() } });
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function bound(bytes: string): void {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > MAX_ARTIFACT_BYTES) throw new Error('reviewer_artifact_too_large');
  if (Buffer.from(bytes, 'utf8').toString('utf8') !== bytes) throw new Error('reviewer_artifact_invalid_bytes');
}
function decodeReport(bytes: string): unknown {
  bound(bytes);
  const decoded = decodeOriginalReport(bytes);
  if (decoded.transformations.length) throw new Error('reviewer_artifact_unsupported_representation');
  return decoded.value;
}
/** Private raw observations are opaque JSON values, not ordinary report prose. */
function decodePrivateArtifact(bytes: string): unknown {
  bound(bytes);
  let raw: unknown;
  try { raw = JSON.parse(bytes); } catch { throw new Error('reviewer_artifact_invalid_document'); }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > 64) throw new Error('reviewer_artifact_invalid_document');
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  // Canonical re-encoding rejects duplicate keys and ambiguous spellings while
  // preserving raw escaped code units exactly; no prose normalization occurs.
  if (stableStringify(raw) !== bytes) throw new Error('reviewer_artifact_noncanonical');
  return raw;
}
function equal(left: unknown, right: unknown): boolean { return stableStringify(left) === stableStringify(right); }

/** Brand means deterministic body validation only, never producer truth or native/server admission. */
export function isReviewerArtifact(value: unknown): value is ReviewerArtifact {
  return value !== null && typeof value === 'object' && validated.has(value);
}

function canceledCalls(input: CheckpointAssemblyInput): ReviewResult['stats']['canceledCalls'] {
  const key = (r: Pick<ModelReview, 'model' | 'role'>) => `${r.model}::${r.role}`;
  const completeKeys = new Set(input.projection.seatReviews.filter(seat => seat.complete).map(seat => key(seat.review)));
  const seen = new Set<string>(), calls: NonNullable<ReviewResult['stats']['canceledCalls']> = [];
  for (const seat of input.projection.seatReviews) {
    const identity = key(seat.review);
    if (seat.complete || completeKeys.has(identity) || seen.has(identity)) continue;
    seen.add(identity);
    if (seat.review.status === 'canceled') calls.push({ model: seat.review.model, role: seat.review.role, elapsedMs: seat.review.durationMs });
  }
  return calls.length ? calls : undefined;
}

function derive(input: ReviewerArtifactContext & { reportBytes: string }) {
  const representation = representationSchema.parse(input.representation);
  const gated = deriveCheckpointGating(input.assembly, input.verificationProof);
  const { derived } = gated, { projection, supplementalAsync } = input.assembly;
  const successor = projection.proofs.at(-1)!;
  const captured = decodeCapturedInputs(successor.proof.bindings['captured-inputs']!, successor.proof.plan);
  const aggregation = captured.aggregation!;
  const raw = decodeReport(input.reportBytes);
  if (!originalRunReportSchema.safeParse(raw).success) throw new Error('reviewer_artifact_invalid_report');
  const report = raw as ReviewResult & { run: RunHeader & { reviewer_evidence?: unknown } };
  const reviews = derived.consensus.reviews, canceled = canceledCalls(input.assembly);
  const stats: ReviewResult['stats'] = {
    totalReviews: reviews.length, successfulReviews: reviews.filter(review => review.status === 'success').length,
    totalRawFindings: reviews.reduce((sum, review) => sum + review.findings.length, 0),
    totalDeduped: derived.consensus.consensusFindings.length, belowThreshold: derived.consensus.droppedFindings.length,
    durationMs: report.stats.durationMs,
    ...(supplementalAsync.asyncLaunched > 0 ? { asyncLaunched: supplementalAsync.asyncLaunched } : {}),
    ...(supplementalAsync.reviews.length > 0 ? { asyncMerged: mergeChunkReviews(supplementalAsync.reviews.map(review => structuredClone(review) as ModelReview)).length } : {}),
    ...(canceled ? { canceledCalls: canceled } : {}), ...(gated.verification ? { verification: gated.verification } : {}),
    ...(aggregation.modelWeights ? { modelWeights: Object.fromEntries([...new Set(reviews.map(review => review.model))].map(model => [model, aggregation.modelWeights!.find(row => row.model === model)?.weight ?? 1])) } : {}),
  };
  const body: ReviewResult = { reviews, findings: gated.findings,
    ...(aggregation.belowThresholdAppendix && gated.appendix.length > 0 ? { belowThresholdFindings: gated.appendix } : {}), stats };
  const reportedCiExitCode = evaluateCiGate(body, projection.health).exitCode;
  // Replay annotations may lower the delivered code. Preserve the ungated
  // consensus verdict for the artifact's conservative offline projection.
  const conservativeCiExitCode = Math.max(reportedCiExitCode, evaluateCiGate({ ...body,
    findings: derived.consensus.reportFindings }, projection.health).exitCode);
  const header = buildRunHeader({ ...input.assembly.run, config: structuredClone(captured.config), diff: input.assembly.diff,
    thresholds: { ...aggregation.thresholds }, gating: { ...aggregation.gating },
    finishedAt: new Date(report.run.finished_at), ciExitCode: reportedCiExitCode });
  const expected = sanitizeForDelivery({ ...body, run: { ...header,
    ...(Object.hasOwn(report.run, 'reviewer_evidence') ? { reviewer_evidence: describeReviewerEvidence(successor.proof, supplementalAsync) } : {}) } }, representation);
  if (!equal(raw, expected)) throw new Error('reviewer_artifact_body_mismatch');
  const lineage = input.lineage === undefined ? [] : validateArtifactLineage(input.lineage).map((item, index) => {
    const proof = projection.proofs[index];
    if (!proof || proof.runId !== item.runId || proof.proof.digest !== item.proof.digest) throw new Error('reviewer_artifact_lineage_mismatch');
    return { runId: item.runId, reportSha256: item.reportSha256, checkpointSha256: item.proof.digest };
  });
  if (input.lineage !== undefined && lineage.length !== projection.proofs.length) throw new Error('reviewer_artifact_lineage_mismatch');
  if (input.lineage !== undefined && lineage.at(-1)!.reportSha256 !== sha256Hex(input.reportBytes)) {
    throw new Error('reviewer_artifact_lineage_report_mismatch');
  }
  const annotations: ReviewerArtifactGate['annotations'] = [...gated.findings, ...gated.appendix].flatMap(finding =>
    finding.gating === undefined ? [] : [{ identity: finding.identity!, disposition: gated.appendix.includes(finding) ? 'below_threshold' as const : 'kept' as const, gating: finding.gating }]);
  const gate: ReviewerArtifactGate = { validation: 'deterministic', reportedCiExitCode, conservativeCiExitCode,
    unresolvedFindingIdentities: [], annotations };
  const newPhysicalAttempts = projection.newPhysicalAttempts.map(({ review: _review, reviewBytes: _bytes, ...attempt }) => attempt);
  const validation = { body: 'deterministic' as const, health: 'derived' as const, gate };
  const asyncExecution = gated.asyncExecution === undefined ? undefined : { bytes: gated.asyncExecution.bytes, sha256: gated.asyncExecution.digest };
  const newAsyncPhysicalAttempts = gated.asyncExecution === undefined ? undefined :
    (projection.proofs.length === 1 ? gated.asyncExecution.physicalAttempts : []).map(({ reviewBytes: _bytes, ...attempt }) => attempt);
  const verification = gated.phase === undefined ? undefined : { bytes: gated.phase.proof.bytes, sha256: gated.phase.proof.digest };
  const wire = { version: 1 as const, kind: 'private-reviewer-evidence' as const,
    report: { bytes: input.reportBytes, sha256: sha256Hex(input.reportBytes) }, representation, assembly: assemblyMetadata(input.assembly),
    checkpoints: projection.proofs.map(item => ({ runId: item.runId, sha256: item.proof.digest, bytes: item.proof.bytes })),
    supplementalAsync: { bytes: supplementalAsync.bytes, sha256: supplementalAsync.digest },
    ...(verification ? { verification } : {}),
    ...(asyncExecution === undefined ? {} : { asyncExecution, newAsyncPhysicalAttempts }), lineage,
    contributions: derived.contributions, observations: derived.observations, health: projection.health, newPhysicalAttempts, validation };
  return { wire, projection, derived, validation, newPhysicalAttempts, newAsyncPhysicalAttempts };
}
/**
 * Serialize PRIVATE evidence after ordinary sanitization/rendering. Pure and
 * provider-free; report-body conservation never establishes source authority,
 * verification truth, execution eligibility, or native/server approval.
 */
export function serializeReviewerArtifact(input: ReviewerArtifactContext & { reportBytes: string }): ReviewerArtifact {
  const result = derive(input);
  const bytes = stableStringify(result.wire);
  bound(bytes); // Includes escaping and every embedded report/proof, not just raw component lengths.
  return finishArtifact(result, bytes);
}

function finishArtifact(result: ReturnType<typeof derive>, bytes: string): ReviewerArtifact {
  const { wire, projection, derived, validation, newPhysicalAttempts, newAsyncPhysicalAttempts } = result;
  const artifact: ReviewerArtifact = freeze({ version: 1 as const, bytes, digest: sha256Hex(bytes), reportSha256: wire.report.sha256,
    validation, health: projection.health, contributions: derived.contributions, observations: derived.observations, newPhysicalAttempts,
    ...(newAsyncPhysicalAttempts === undefined ? {} : { newAsyncPhysicalAttempts }) });
  validated.add(artifact);
  return artifact;
}

/**
 * Revalidate against the caller's independently decoded/branded proof lineage.
 * The context is required: serialized claims cannot supply their own authority.
 */
export function validateReviewerArtifact(bytes: string, context: ReviewerArtifactContext): ReviewerArtifact {
  const raw = decodePrivateArtifact(bytes);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('reviewer_artifact_invalid_document');
  const report = (raw as { report?: { bytes?: unknown } }).report;
  if (typeof report?.bytes !== 'string') throw new Error('reviewer_artifact_invalid_document');
  const verification = z.object({ bytes: z.string(), sha256: hashSchema }).strict().optional().parse((raw as Record<string, unknown>).verification);
  if (verification !== undefined && sha256Hex(verification.bytes) !== verification.sha256) throw new Error('reviewer_artifact_verification_mismatch');
  if (context.verificationProof !== undefined && (verification === undefined || !equal(context.verificationProof, { bytes: verification.bytes, digest: verification.sha256 }))) {
    throw new Error('reviewer_artifact_verification_mismatch');
  }
  const asyncExecution = z.object({ bytes: z.string(), sha256: hashSchema }).strict().optional().parse((raw as Record<string, unknown>).asyncExecution);
  if (asyncExecution !== undefined && sha256Hex(asyncExecution.bytes) !== asyncExecution.sha256 ||
    context.assembly.asyncExecution !== undefined && (asyncExecution === undefined ||
      !equal(context.assembly.asyncExecution, { bytes: asyncExecution.bytes, digest: asyncExecution.sha256 }))) throw new Error('reviewer_artifact_async_execution_mismatch');
  const expected = serializeReviewerArtifact({ ...context, assembly: { ...context.assembly,
    ...(asyncExecution === undefined ? {} : { asyncExecution: { bytes: asyncExecution.bytes, digest: asyncExecution.sha256 } }) }, reportBytes: report.bytes,
    ...(verification === undefined ? {} : { verificationProof: { bytes: verification.bytes, digest: verification.sha256 } }) });
  if (expected.bytes !== bytes) throw new Error('reviewer_artifact_mismatch');
  return expected;
}

export interface InspectReviewerArtifactOptions {
  expectedReportBytes: string;
  expectedRunId: string;
  expectedTarget: string;
  expectedPlan: FrozenCheckpointPlan;
  expectedPrTarget?: string;
  /** Required only when the artifact was serialized with a complete inspected report chain. */
  lineage?: readonly (InspectedReviewerReport | InspectedReviewerArtifact)[];
  /** Cold reopen: genuine prior separate pairs only; CURRENT is derived from exact terminal bytes. */
  ancestors?: readonly InspectedReviewerArtifact[];
}

/** Local structure/body validation only; callers still authenticate every source and launch. */
export interface InspectedReviewerArtifact {
  readonly artifact: ReviewerArtifact;
  readonly representation: { readonly version: 1; readonly parseFailures: boolean };
  readonly assembly: CheckpointAssemblyInput;
  readonly reportBytes: string;
  readonly reportSha256: string;
  readonly runId: string;
  readonly prTarget: string;
  readonly proof: CheckpointProof;
  readonly captured: CapturedReviewerInputs;
  readonly supplementalAsync: SupplementalAsync;
  readonly descriptor: ReviewerEvidenceDescriptor;
  readonly verificationProof?: SealedVerificationProof;
  readonly asyncExecution?: SealedAsyncProof;
  readonly launch?: OriginalLaunch;
  readonly operation?: RecoveryOperation;
  readonly nativeClaim?: NonNullable<RunHeader['converge']>;
}

/**
 * Decode a separately retained terminal pair without fabricating an inline-proof
 * report or a replacement report hash. Expectations come from the owned local
 * journal/terminal manifest; current source/provider/server authority is external.
 */
export function inspectReviewerArtifact(bytes: string, options: InspectReviewerArtifactOptions): InspectedReviewerArtifact {
  if (!options || typeof options.expectedReportBytes !== 'string' || !UUID.test(options.expectedRunId ?? '') ||
    typeof options.expectedTarget !== 'string' || !options.expectedTarget ||
    !options.expectedPlan || typeof options.expectedPlan !== 'object') throw new Error('reviewer_artifact_invalid_expectations');
  const wire = decodePrivateArtifact(bytes) as Record<string, unknown>;
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) throw new Error('reviewer_artifact_invalid_document');
  const report = z.object({ bytes: z.string(), sha256: hashSchema }).strict().parse(wire.report);
  if (report.bytes !== options.expectedReportBytes || sha256Hex(report.bytes) !== report.sha256 ||
    options.expectedPlan.target !== options.expectedTarget) throw new Error('reviewer_artifact_terminal_mismatch');
  const rows = z.array(z.object({ runId: uuidSchema, sha256: hashSchema, bytes: z.string() }).strict())
    .min(1).max(MAX_REVIEWER_LINEAGE_DEPTH).parse(wire.checkpoints);
  const proofs = rows.map(row => {
    const proof = decodeCheckpointProof(row.bytes, options.expectedPlan);
    if (proof.digest !== row.sha256) throw new Error('reviewer_artifact_checkpoint_mismatch');
    return { runId: row.runId, proof };
  });
  const last = proofs.at(-1)!;
  if (last.runId.toLowerCase() !== options.expectedRunId.toLowerCase()) throw new Error('reviewer_artifact_run_mismatch');
  const captureBytes = last.proof.bindings['captured-inputs'];
  if (captureBytes === undefined) throw new Error('reviewer_artifact_missing_capture');
  const captured = decodeCapturedInputs(captureBytes, options.expectedPlan);
  const asyncWire = z.object({ bytes: z.string(), sha256: hashSchema }).strict().parse(wire.supplementalAsync);
  const supplementalAsync = decodeSupplementalAsync(asyncWire.bytes);
  if (supplementalAsync.digest !== asyncWire.sha256) throw new Error('reviewer_artifact_async_mismatch');
  const projection = projectCheckpointReport({ sources: proofs.slice(0, -1), successor: last, policy: captured.policy });
  // Verify each declared original/successor relationship. Prior report bytes
  // and prior native claims are additionally checked by the status/recovery
  // caller against each source's own retained terminal pair.
  for (const [index, item] of proofs.entries()) {
    const descriptor = describeReviewerEvidence(item.proof, supplementalAsync);
    if (index === 0) {
      if (descriptor.kind !== 'original') throw new Error('reviewer_artifact_missing_origin');
      const launch = item.proof.bindings.launch === undefined ? undefined : decodeOriginalLaunch(item.proof.bindings.launch);
      if (launch && launch.runId !== item.runId) throw new Error('reviewer_artifact_run_mismatch');
    } else {
      const prior = proofs[index - 1]!;
      if (descriptor.kind !== 'supplemented' || descriptor.source.run_id !== prior.runId ||
        descriptor.source.checkpoint_sha256 !== prior.proof.digest) throw new Error('reviewer_artifact_source_mismatch');
      const operation = decodeRecoveryOperation(item.proof.bindings.operation!);
      if (operation.successorRunId !== item.runId) throw new Error('reviewer_artifact_run_mismatch');
    }
  }
  const metadata = metadataSchema.parse(wire.assembly);
  const patch = patchSchema.parse(JSON.parse(captured.patchBytes));
  if (stableStringify(patch) !== captured.patchBytes || metadata.diff.files.length !== patch.length ||
    new Set(metadata.diff.files.map(file => file.patchIndex)).size !== patch.length) throw new Error('reviewer_artifact_diff_mismatch');
  const diff: Diff = { source: metadata.diff.source, files: metadata.diff.files.map(reference => {
    const file = patch[reference.patchIndex];
    if (!file) throw new Error('reviewer_artifact_diff_mismatch');
    const { previousFilename, blobSha, ...rest } = file;
    return { ...rest, language: reference.language,
      ...(previousFilename === null ? {} : { previousFilename }), ...(blobSha === null ? {} : { blobSha }) };
  }) };
  const { spec, startedAt, ...run } = metadata.run;
  const asyncPhysicalWire = z.object({ bytes: z.string(), sha256: hashSchema }).strict().optional().parse(wire.asyncExecution);
  if (asyncPhysicalWire !== undefined && sha256Hex(asyncPhysicalWire.bytes) !== asyncPhysicalWire.sha256) throw new Error('reviewer_artifact_async_execution_mismatch');
  const asyncExecution = asyncPhysicalWire === undefined ? undefined : { bytes: asyncPhysicalWire.bytes, digest: asyncPhysicalWire.sha256 };
  const assembly: CheckpointAssemblyInput = { projection, supplementalAsync, ...(asyncExecution === undefined ? {} : { asyncExecution }), diff, startTime: metadata.startTime,
    run: { ...run, startedAt: new Date(startedAt), ...(spec ? { spec: { ...spec, source: parseSpecSource(spec.source) } } : {}) } };
  const target = assembly.run.target;
  const prTarget = target.repo && target.prNumber ? `${target.repo.toLowerCase()}#${target.prNumber}` : undefined;
  if (!prTarget || options.expectedPrTarget !== undefined && prTarget !== options.expectedPrTarget.toLowerCase()) {
    throw new Error('reviewer_artifact_target_mismatch');
  }
  const representation = representationSchema.parse(wire.representation);
  const verification = z.object({ bytes: z.string(), sha256: hashSchema }).strict().optional().parse(wire.verification);
  if (verification !== undefined && sha256Hex(verification.bytes) !== verification.sha256) throw new Error('reviewer_artifact_verification_mismatch');
  const verificationProof = verification === undefined ? undefined : { bytes: verification.bytes, digest: verification.sha256 };
  const descriptor = describeReviewerEvidence(last.proof, supplementalAsync);
  const launch = last.proof.bindings.launch === undefined ? undefined : decodeOriginalLaunch(last.proof.bindings.launch);
  const operation = last.proof.bindings.operation === undefined ? undefined : decodeRecoveryOperation(last.proof.bindings.operation);
  const current = { representation, assembly, reportBytes: report.bytes, reportSha256: report.sha256, runId: last.runId, prTarget,
    proof: last.proof, captured, supplementalAsync, descriptor,
    ...(asyncExecution === undefined ? {} : { asyncExecution }),
    ...(verificationProof === undefined ? {} : { verificationProof }),
    ...(launch ? { launch } : {}), ...(operation ? { operation } : {}),
    ...(assembly.run.converge ? { nativeClaim: assembly.run.converge } : {}) };
  const context = { assembly, representation, ...(verificationProof === undefined ? {} : { verificationProof }) };
  if (options.ancestors !== undefined && options.lineage !== undefined) throw new Error('reviewer_artifact_conflicting_lineage');
  const artifact = options.ancestors === undefined
    ? validateReviewerArtifact(bytes, { ...context, ...(options.lineage === undefined ? {} : { lineage: options.lineage }) })
    : reopenArtifact(bytes, context, current, options.ancestors);
  const result = freeze({ ...current, artifact });
  inspectedArtifacts.add(result);
  return result;
}

/** Reconstruct the current body before checking complete independently established lineage refs. */
function reopenArtifact(
  bytes: string, context: ReviewerArtifactContext,
  current: Omit<InspectedReviewerArtifact, 'artifact'>, ancestors: readonly InspectedReviewerArtifact[],
): ReviewerArtifact {
  if (!Array.isArray(ancestors) || ancestors.some(item => !isInspectedReviewerArtifact(item))) {
    throw new Error('reviewer_report_not_inspected');
  }
  const derived = derive({ ...context, reportBytes: current.reportBytes });
  const chain = validateInspectedReviewerArtifactChain<InspectedReviewerReport>([...ancestors, current]);
  const proofs = derived.projection.proofs;
  if (chain.length !== proofs.length || chain.some((item, index) => {
    const expected = proofs[index];
    return !expected || expected.runId !== item.runId || expected.proof.bytes !== item.proof.bytes;
  })) throw new Error('reviewer_artifact_lineage_mismatch');
  const lineage = chain.map(item => ({ runId: item.runId, reportSha256: item.reportSha256, checkpointSha256: item.proof.digest }));
  // These are reconstructed comparison bytes. Never mutate or substitute the retained document.
  const expected = stableStringify({ ...derived.wire, lineage });
  bound(expected);
  if (expected !== bytes) throw new Error('reviewer_artifact_mismatch');
  return finishArtifact(derived, bytes);
}
