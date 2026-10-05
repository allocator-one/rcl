import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ReviewResult } from '../consensus/types.js';
import { resolveGitCommonDir } from '../converge/attempt-budget.js';
import { loadReviewerLineage, type ReviewerLineage } from '../evidence/reviewer-lineage.js';
import { openJournal, serializeRecoveryDocument, writeExclusive, MAX_RECOVERY_DOCUMENT_BYTES } from '../evidence/original-run/journal.js';
import { renderReportArtifacts } from '../output/artifacts.js';
import { buildRunEnvelope, declareReviewerRecovery, type ReviewerRecoverySource } from './envelope.js';
import type { TelemetryRuntime } from './deliver.js';
import { platformPath, readStable, sha256 } from './recovery/files.js';
import { ReviewerDeliveryQueue, type RetainedReviewerRecoveryDestination,
  type RetainedReviewerRecoveryPreview, type RetainedReviewerRecoverySelection } from './reviewer-delivery.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const reference = z.object({ sha256: digest, bytes: z.number().int().nonnegative() }).strict();
const principal = z.object({ org_id: uuid, actor_user_id: uuid,
  credential_kind: z.enum(['cli', 'api_token']), api_token_id: uuid.nullable() }).strict();
const destination = z.object({ host: z.string(), credentialKind: z.enum(['login', 'env']),
  activationProtocol: z.literal(1), principal }).strict();
const previewSchema = z.object({ version: z.literal(1), target: z.string().min(1), runId: uuid,
  headSha: z.string().regex(/^[a-f0-9]{40}$/), host: z.string(), credentialKind: z.enum(['login', 'env']),
  manifest: reference, envelope: reference, report_json: reference, report_md: reference.optional(), reviewer: reference }).strict();
const manifestSchema = z.object({ kind: z.literal('rcl-retained-reviewer-activation'), version: z.literal(1),
  operation_id: uuid, created_at: z.iso.datetime(), rcl_version: z.string(), destination,
  prepared: z.object({ outbox: previewSchema, lineage: z.object({ plan_sha256: digest, checkpoint_sha256: digest,
    captured_inputs_sha256: digest, runs: z.array(z.object({ run_id: uuid, report_json: reference, reviewer: reference }).strict()).min(1) }).strict() }).strict(),
  observation: z.object({ reviewer: z.enum(['absent', 'pending', 'verified']),
    report_json: z.enum(['missing', 'verified', 'conflict']), report_md: z.enum(['missing', 'verified', 'conflict']) }).strict() }).strict();
type ActivationManifest = z.infer<typeof manifestSchema>;

export interface TerminalReviewerDeliveryOptions {
  preview?: boolean;
  apply?: boolean;
  resume?: boolean;
  manifest?: string;
  manifestSha256?: string;
  target?: string;
  runId?: string;
  commonDir?: string;
  cwd?: string;
}

export type TerminalReviewerDeliveryResult =
  | { status: 'prepared'; manifest: string; manifest_sha256: string; operation_id: string; run_id: string; observation: ActivationManifest['observation']; accounting: string }
  | { status: 'complete'; manifest: string; manifest_sha256: string; operation_id: string; run_id: string; journal: string; recovery_acknowledgement: string; accounting: string };

function reviewerSource(lineage: ReviewerLineage): ReviewerRecoverySource | undefined {
  const descriptor = lineage.latest.inspected.descriptor;
  if (descriptor.kind === 'original') return undefined;
  const source = lineage.runs.at(-2);
  if (!source || source.runId !== descriptor.source.run_id || source.terminal.reportSha256 !== descriptor.source.report_sha256) {
    throw new Error('reviewer_delivery_lineage_source_mismatch');
  }
  return { run_id: source.runId, report_sha256: source.terminal.reportSha256,
    reviewer_artifact_sha256: sha256(source.terminal.reviewerArtifactBytes) };
}

async function prepare(runtime: TelemetryRuntime, commonDir: string, target: string, runId: string): Promise<{
  selection: RetainedReviewerRecoverySelection; outbox: RetainedReviewerRecoveryPreview; prepared: ActivationManifest['prepared'];
}> {
  const lineage = await loadReviewerLineage({ commonDir, target, runId });
  const { inspected, terminal } = lineage.latest;
  const result = JSON.parse(terminal.reportBytes) as ReviewResult;
  const rendered = renderReportArtifacts(result);
  const artifacts = { report_json: terminal.reportBytes, report_md: rendered.report_md };
  if (artifacts.report_md === undefined) throw new Error('reviewer_delivery_report_lineage_mismatch');
  const source = reviewerSource(lineage);
  const declaration = declareReviewerRecovery({ artifact: inspected.artifact, descriptor: inspected.descriptor,
    ...(source ? { source } : {}) });
  const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' },
    parseFailures: inspected.representation.parseFailures, reviewerRecovery: declaration });
  const envelopeBytes = JSON.stringify(envelope);
  const selection: RetainedReviewerRecoverySelection = {
    target, runId, headSha: lineage.plan.headSha,
    reportSha256: terminal.reportSha256, reportByteLength: Buffer.byteLength(terminal.reportBytes), reportBytes: terminal.reportBytes,
    reviewerArtifactSha256: sha256(terminal.reviewerArtifactBytes), reviewerArtifactByteLength: Buffer.byteLength(terminal.reviewerArtifactBytes), reviewerArtifactBytes: terminal.reviewerArtifactBytes,
    envelopeSha256: sha256(envelopeBytes), envelopeByteLength: Buffer.byteLength(envelopeBytes), envelopeBytes,
    reportMarkdownSha256: sha256(artifacts.report_md), reportMarkdownByteLength: Buffer.byteLength(artifacts.report_md), reportMarkdownBytes: artifacts.report_md,
  };
  const outbox = await new ReviewerDeliveryQueue(runtime.dataDir).previewRecovery(selection);
  const prepared = { outbox, lineage: { plan_sha256: lineage.plan.digest, checkpoint_sha256: lineage.latest.proof.digest,
    captured_inputs_sha256: lineage.latest.captured.digest, runs: lineage.runs.map(run => ({ run_id: run.runId,
      report_json: { sha256: run.terminal.reportSha256, bytes: Buffer.byteLength(run.terminal.reportBytes) },
      reviewer: { sha256: sha256(run.terminal.reviewerArtifactBytes), bytes: Buffer.byteLength(run.terminal.reviewerArtifactBytes) } })) } };
  return { selection, outbox, prepared };
}

function requireRuntime(runtime: TelemetryRuntime) {
  if (runtime.level !== 'full' || !runtime.repoManaged || !runtime.sink || !runtime.credential || runtime.attested) {
    throw new Error('reviewer_delivery_recovery_runtime_unsupported');
  }
  return runtime.sink;
}

async function currentDestination(runtime: TelemetryRuntime, expected?: RetainedReviewerRecoveryDestination): Promise<RetainedReviewerRecoveryDestination> {
  const sink = requireRuntime(runtime);
  const capability = await sink.checkReviewerRecoveryActivation();
  if (capability.kind !== 'ok') throw new Error('reviewer_delivery_activation_unsupported');
  const value: RetainedReviewerRecoveryDestination = { host: sink.baseUrl,
    credentialKind: sink.credentialSource as 'login' | 'env', activationProtocol: 1, principal: capability.value.principal };
  if (expected && !isDeepStrictEqual(value, expected)) throw new Error('reviewer_delivery_principal_mismatch');
  return value;
}

async function observation(runtime: TelemetryRuntime, preview: RetainedReviewerRecoveryPreview,
  selection: RetainedReviewerRecoverySelection): Promise<ActivationManifest['observation']> {
  const sink = requireRuntime(runtime);
  const read = await sink.getReviewerArtifact(preview.runId, preview.reviewer);
  let reviewer: ActivationManifest['observation']['reviewer'];
  if (read.kind === 'ok') reviewer = 'verified';
  else if (read.kind === 'pending') reviewer = 'pending';
  else if (read.kind === 'rejected' && read.httpStatus === 404 && read.error === 'reviewer_artifact_http_404') reviewer = 'absent';
  else throw new Error(read.kind === 'unavailable' ? 'reviewer_delivery_unavailable' : 'reviewer_delivery_refused');
  const ordinary = async (kind: 'report_json' | 'report_md', bytes: string): Promise<'missing' | 'verified' | 'conflict'> => {
    const value = await sink.getArtifact(preview.runId, kind, Buffer.byteLength(bytes));
    if (value.kind === 'ok') return value.value.bytes.equals(Buffer.from(bytes)) ? 'verified' : 'conflict';
    if (value.kind === 'rejected' && value.httpStatus === 404) return 'missing';
    throw new Error(value.kind === 'unavailable' ? 'reviewer_delivery_unavailable' : 'reviewer_delivery_refused');
  };
  return { reviewer, report_json: await ordinary('report_json', selection.reportBytes),
    report_md: await ordinary('report_md', selection.reportMarkdownBytes) };
}

/** Receipt-first activation; no reviewer dispatch or native accounting mutation. */
export async function deliverTerminalReviewerRun(
  runtime: TelemetryRuntime,
  options: TerminalReviewerDeliveryOptions,
): Promise<TerminalReviewerDeliveryResult> {
  const preview = options.preview === true;
  if ([preview, options.apply, options.resume].filter(Boolean).length !== 1) {
    throw new Error('choose_exactly_one_recovery_mode: use exactly one of --preview, --apply, or --resume');
  }
  const manifestOption = options.manifest;
  if (!manifestOption) throw new Error('reviewer_delivery_manifest_required');
  const manifestPath = platformPath(manifestOption);
  const commonDir = options.commonDir ?? await resolveGitCommonDir(options.cwd);
  if (preview) {
    if (!options.target || !options.runId || options.manifestSha256 !== undefined) throw new Error('reviewer_delivery_invalid_preview');
    const { prepared, selection } = await prepare(runtime, commonDir, options.target, options.runId);
    const target = await currentDestination(runtime);
    if (target.host !== prepared.outbox.host || target.credentialKind !== prepared.outbox.credentialKind) {
      throw new Error('reviewer_delivery_destination_mismatch');
    }
    const observed = await observation(runtime, prepared.outbox, selection);
    const manifest: ActivationManifest = { kind: 'rcl-retained-reviewer-activation', version: 1,
      operation_id: randomUUID(), created_at: new Date().toISOString(), rcl_version: runtime.rclVersion,
      destination: target, prepared, observation: observed };
    manifestSchema.parse(manifest);
    const bytes = serializeRecoveryDocument(manifest, MAX_RECOVERY_DOCUMENT_BYTES);
    await writeExclusive(manifestPath, manifest, MAX_RECOVERY_DOCUMENT_BYTES);
    return { status: 'prepared', manifest: manifestPath, manifest_sha256: sha256(bytes), operation_id: manifest.operation_id,
      run_id: prepared.outbox.runId, observation: observed, accounting: 'unchanged; delivery is not native admission or reviewer execution' };
  }
  if (options.target !== undefined || options.runId !== undefined || !digest.safeParse(options.manifestSha256).success) {
    throw new Error('reviewer_delivery_apply_uses_only_pinned_manifest');
  }
  const retained = await readStable(manifestPath, MAX_RECOVERY_DOCUMENT_BYTES);
  if (retained.sha256 !== options.manifestSha256) throw new Error('reviewer_delivery_manifest_digest_mismatch');
  const manifest = manifestSchema.parse(JSON.parse(retained.text));
  const { selection, outbox, prepared } = await prepare(runtime, commonDir, manifest.prepared.outbox.target, manifest.prepared.outbox.runId);
  if (!isDeepStrictEqual(prepared, manifest.prepared) || !isDeepStrictEqual(outbox, manifest.prepared.outbox)) {
    throw new Error('reviewer_delivery_lineage_or_outbox_changed');
  }
  await currentDestination(runtime, manifest.destination);
  const journalPath = `${manifestPath}.journal`;
  const journal = await openJournal(journalPath, retained.sha256, manifest.operation_id, options.apply ? 'apply' : 'resume');
  const operation = { mode: options.apply ? 'apply' as const : 'resume' as const, operationId: manifest.operation_id,
    recoveryManifestSha256: retained.sha256, destination: manifest.destination, journal };
  const queue = new ReviewerDeliveryQueue(runtime.dataDir);
  if (options.apply) await queue.applyRecovery(requireRuntime(runtime), selection, outbox, operation);
  else await queue.resumeRecovery(requireRuntime(runtime), selection, outbox, operation);
  const ack = platformPath(`${runtime.dataDir}/reviewer-outbox/${outbox.runId.toLowerCase()}/recovery-acknowledged.json`);
  await readFile(ack, 'utf8');
  return { status: 'complete', manifest: manifestPath, manifest_sha256: retained.sha256, operation_id: manifest.operation_id,
    run_id: outbox.runId, journal: journalPath, recovery_acknowledgement: ack,
    accounting: 'unchanged; delivery is not native admission or reviewer execution' };
}
