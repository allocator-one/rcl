import { z } from 'zod';
import { evaluateCiGate } from '../ci.js';
import type { GatingInfo } from '../consensus/gating.js';
import type { ConsensusFinding, ModelReview, ReviewResult } from '../consensus/types.js';
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
import { deriveCheckpointConsensus, type CheckpointAssemblyInput, type CheckpointAssemblyContribution,
  type CheckpointAssemblyObservation } from './checkpoint-assembly.js';
import { projectCheckpointReport, type PhysicalCheckpointAttempt } from './checkpoint-projection.js';
import { decodeSupplementalAsync, type SupplementalAsync } from './supplemental-async.js';
import { describeReviewerEvidence, validateReviewerReportChain, MAX_REVIEWER_LINEAGE_DEPTH, type InspectedReviewerReport, type ReviewerEvidenceDescriptor } from './reviewer-evidence.js';
import type { ReviewerHealth } from './reviewer-health.js';
import { buildRunHeader, parseSpecSource, sha256Hex, stableStringify, type RunHeader } from './run-header.js';

export interface ReviewerArtifactContext {
  /** Reconstructed with the existing validated proof/async decoders; never a deserialized cast. */
  assembly: CheckpointAssemblyInput;
  representation: { version: 1; parseFailures: boolean };
  /** Optional complete inspected chain; external producer/server authority remains separate. */
  lineage?: readonly InspectedReviewerReport[];
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
}>;
const validated = new WeakSet<object>();
const representationSchema = z.object({ version: z.literal(1), parseFailures: z.boolean() }).strict();
const verificationSchema = z.object({ verdict: z.enum(['refuted', 'unrefuted', 'unavailable']),
  model: z.string().optional(), note: z.string().optional() }).strict();
const gatingSchema = z.object({ reason: z.enum(['critical', 'consensus', 'verified', 'none']),
  verification: verificationSchema.optional() }).strict();
const integer = z.number().int().nonnegative().safe();
const verificationStatsSchema = z.object({ model: z.string(), candidates: integer, refuted: integer,
  unrefuted: integer, unavailable: integer, durationMs: z.number().finite().nonnegative() }).strict();

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

function annotate(
  raw: ConsensusFinding[], expected: ConsensusFinding[], disposition: 'kept' | 'below_threshold',
  verifiedMode: boolean, minModels: number, weights: Map<string, number> | undefined,
  annotations: ReviewerArtifactGate['annotations'], unresolved: string[],
): ConsensusFinding[] {
  if (raw.length !== expected.length) throw new Error('reviewer_artifact_body_mismatch');
  return expected.map((finding, index) => {
    const claimed = raw[index]!.gating;
    if (claimed === undefined) return finding;
    const parsed = gatingSchema.safeParse(claimed);
    if (!verifiedMode || !parsed.success) throw new Error('reviewer_artifact_unverifiable_gating');
    const gating = parsed.data;
    const support = finding.consensus.models.reduce((sum, model) => sum + (weights?.get(model) ?? 1), 0);
    const deterministic = disposition === 'below_threshold' || !['critical', 'important'].includes(finding.severity) ? 'none'
      : finding.consensus.models.length >= minModels && support >= minModels ? 'consensus'
      : finding.severity === 'critical' ? 'critical' : undefined;
    if (deterministic !== undefined) {
      if (gating.reason !== deterministic || gating.verification !== undefined) throw new Error('reviewer_artifact_unverifiable_gating');
    } else {
      const verification = gating.verification;
      if (!verification || gating.reason !== (verification.verdict === 'unrefuted' ? 'verified' : 'none')) {
        throw new Error('reviewer_artifact_unverifiable_gating');
      }
      unresolved.push(finding.identity!);
    }
    annotations.push({ identity: finding.identity!, disposition, gating });
    return { ...finding, gating };
  });
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
  const derived = deriveCheckpointConsensus(input.assembly);
  const { projection, supplementalAsync } = input.assembly;
  const successor = projection.proofs.at(-1)!;
  const captured = decodeCapturedInputs(successor.proof.bindings['captured-inputs']!, successor.proof.plan);
  const aggregation = captured.aggregation!;
  const raw = decodeReport(input.reportBytes);
  if (!originalRunReportSchema.safeParse(raw).success) throw new Error('reviewer_artifact_invalid_report');
  // Keep the original object: the permissive compatibility schema is not a
  // canonicalizer and must not erase altered or unexpected delivered fields.
  const report = raw as ReviewResult & { run: RunHeader & { reviewer_evidence?: unknown } };
  const verifiedMode = aggregation.gating.mode === 'verified-consensus' && projection.health.conclusive;
  const weights = aggregation.modelWeights === undefined ? undefined : new Map(aggregation.modelWeights.map(row => [row.model, row.weight]));
  const annotations: ReviewerArtifactGate['annotations'] = [], unresolved: string[] = [];
  const findings = annotate(report.findings, derived.consensus.reportFindings, 'kept', verifiedMode,
    aggregation.gating.minModels, weights, annotations, unresolved);
  const appendix = aggregation.belowThresholdAppendix && derived.consensus.droppedFindings.length > 0
    ? annotate(report.belowThresholdFindings ?? [], derived.consensus.droppedFindings, 'below_threshold', verifiedMode,
      aggregation.gating.minModels, weights, annotations, unresolved) : undefined;
  // A successful legacy gating pass annotates all findings; fallback annotates
  // none. Reject a partial mix that cannot come from that assembly boundary.
  if (annotations.length > 0 && annotations.length !== findings.length + (appendix?.length ?? 0)) {
    throw new Error('reviewer_artifact_unverifiable_gating');
  }
  let verification: ReviewResult['stats']['verification'];
  if (report.stats.verification !== undefined) {
    const parsed = verificationStatsSchema.safeParse(report.stats.verification);
    if (!verifiedMode || !parsed.success || !unresolved.length) throw new Error('reviewer_artifact_unverifiable_gating');
    verification = parsed.data;
    const verdicts = annotations.flatMap(item => item.gating.verification ? [item.gating.verification.verdict] : []);
    if (verification.candidates !== verdicts.length || ['refuted', 'unrefuted', 'unavailable'].some(verdict =>
      verification![verdict as 'refuted' | 'unrefuted' | 'unavailable'] !== verdicts.filter(value => value === verdict).length)) {
      throw new Error('reviewer_artifact_stats_mismatch');
    }
  }
  const reviews = derived.consensus.reviews, canceled = canceledCalls(input.assembly);
  const stats: ReviewResult['stats'] = {
    totalReviews: reviews.length, successfulReviews: reviews.filter(review => review.status === 'success').length,
    totalRawFindings: reviews.reduce((sum, review) => sum + review.findings.length, 0),
    totalDeduped: derived.consensus.consensusFindings.length, belowThreshold: derived.consensus.droppedFindings.length,
    durationMs: report.stats.durationMs,
    ...(supplementalAsync.asyncLaunched > 0 ? { asyncLaunched: supplementalAsync.asyncLaunched } : {}),
    ...(supplementalAsync.reviews.length > 0 ? { asyncMerged: mergeChunkReviews(supplementalAsync.reviews.map(review => structuredClone(review) as ModelReview)).length } : {}),
    ...(canceled ? { canceledCalls: canceled } : {}), ...(verification ? { verification } : {}),
    ...(weights ? { modelWeights: Object.fromEntries([...new Set(reviews.map(review => review.model))].map(model => [model, weights.get(model) ?? 1])) } : {}),
  };
  const body: ReviewResult = { reviews, findings, ...(appendix ? { belowThresholdFindings: appendix } : {}), stats };
  const reportedCiExitCode = evaluateCiGate(body, projection.health).exitCode;
  const conservativeCiExitCode = Math.max(reportedCiExitCode, evaluateCiGate({ ...body,
    findings: derived.consensus.reportFindings }, projection.health).exitCode);
  const header = buildRunHeader({ ...input.assembly.run, config: structuredClone(captured.config), diff: input.assembly.diff,
    thresholds: { ...aggregation.thresholds }, gating: { ...aggregation.gating },
    finishedAt: new Date(report.run.finished_at), ciExitCode: reportedCiExitCode });
  const expected = sanitizeForDelivery({ ...body, run: { ...header,
    ...(Object.hasOwn(report.run, 'reviewer_evidence') ? { reviewer_evidence: describeReviewerEvidence(successor.proof, supplementalAsync) } : {}) } }, representation);
  if (!equal(raw, expected)) throw new Error('reviewer_artifact_body_mismatch');
  const lineage = input.lineage === undefined ? [] : validateReviewerReportChain(input.lineage).map((item, index) => {
    const proof = projection.proofs[index];
    if (!proof || proof.runId !== item.runId || proof.proof.digest !== item.proof.digest) throw new Error('reviewer_artifact_lineage_mismatch');
    return { runId: item.runId, reportSha256: item.reportSha256, checkpointSha256: item.proof.digest };
  });
  if (input.lineage !== undefined && lineage.length !== projection.proofs.length) throw new Error('reviewer_artifact_lineage_mismatch');
  const gate: ReviewerArtifactGate = { validation: unresolved.length ? 'requires_verifier_evidence' : 'deterministic',
    reportedCiExitCode, conservativeCiExitCode, unresolvedFindingIdentities: unresolved, annotations };
  const newPhysicalAttempts = projection.newPhysicalAttempts.map(({ review: _review, reviewBytes: _bytes, ...attempt }) => attempt);
  const validation = { body: 'deterministic' as const, health: 'derived' as const, gate };
  const wire = { version: 1 as const, kind: 'private-reviewer-evidence' as const,
    report: { bytes: input.reportBytes, sha256: sha256Hex(input.reportBytes) }, representation, assembly: assemblyMetadata(input.assembly),
    checkpoints: projection.proofs.map(item => ({ runId: item.runId, sha256: item.proof.digest, bytes: item.proof.bytes })),
    supplementalAsync: { bytes: supplementalAsync.bytes, sha256: supplementalAsync.digest }, lineage,
    contributions: derived.contributions, observations: derived.observations, health: projection.health, newPhysicalAttempts, validation };
  return { wire, projection, derived, validation, newPhysicalAttempts };
}

/**
 * Serialize PRIVATE evidence after ordinary sanitization/rendering. Pure and
 * provider-free; report-body conservation never establishes source authority,
 * verification truth, execution eligibility, or native/server approval.
 */
export function serializeReviewerArtifact(input: ReviewerArtifactContext & { reportBytes: string }): ReviewerArtifact {
  const { wire, projection, derived, validation, newPhysicalAttempts } = derive(input);
  const bytes = stableStringify(wire);
  bound(bytes); // Includes escaping and every embedded report/proof, not just raw component lengths.
  const result: ReviewerArtifact = freeze({ version: 1 as const, bytes, digest: sha256Hex(bytes), reportSha256: wire.report.sha256,
    validation, health: projection.health, contributions: derived.contributions, observations: derived.observations, newPhysicalAttempts });
  validated.add(result);
  return result;
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
  const expected = serializeReviewerArtifact({ ...context, reportBytes: report.bytes });
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
  lineage?: readonly InspectedReviewerReport[];
}

/** Local structure/body validation only; callers still authenticate every source and launch. */
export interface InspectedReviewerArtifact {
  readonly artifact: ReviewerArtifact;
  readonly assembly: CheckpointAssemblyInput;
  readonly reportBytes: string;
  readonly reportSha256: string;
  readonly runId: string;
  readonly prTarget: string;
  readonly proof: CheckpointProof;
  readonly captured: CapturedReviewerInputs;
  readonly supplementalAsync: SupplementalAsync;
  readonly descriptor: ReviewerEvidenceDescriptor;
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
  const assembly: CheckpointAssemblyInput = { projection, supplementalAsync, diff, startTime: metadata.startTime,
    run: { ...run, startedAt: new Date(startedAt), ...(spec ? { spec: { ...spec, source: parseSpecSource(spec.source) } } : {}) } };
  const target = assembly.run.target;
  const prTarget = target.repo && target.prNumber ? `${target.repo.toLowerCase()}#${target.prNumber}` : undefined;
  if (!prTarget || options.expectedPrTarget !== undefined && prTarget !== options.expectedPrTarget.toLowerCase()) {
    throw new Error('reviewer_artifact_target_mismatch');
  }
  const artifact = validateReviewerArtifact(bytes, { assembly, representation: representationSchema.parse(wire.representation),
    ...(options.lineage === undefined ? {} : { lineage: options.lineage }) });
  const descriptor = describeReviewerEvidence(last.proof, supplementalAsync);
  const launch = last.proof.bindings.launch === undefined ? undefined : decodeOriginalLaunch(last.proof.bindings.launch);
  const operation = last.proof.bindings.operation === undefined ? undefined : decodeRecoveryOperation(last.proof.bindings.operation);
  return freeze({ artifact, assembly, reportBytes: report.bytes, reportSha256: report.sha256, runId: last.runId, prTarget,
    proof: last.proof, captured, supplementalAsync, descriptor,
    ...(launch ? { launch } : {}), ...(operation ? { operation } : {}),
    ...(assembly.run.converge ? { nativeClaim: assembly.run.converge } : {}) });
}
