import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { isReviewerArtifact, type ReviewerArtifact } from '../report/reviewer-artifact.js';
import { MAX_RECOVERY_CHECKPOINT_BYTES, MAX_RECOVERY_DOCUMENT_BYTES, openJournal, withRecoveryLock,
  syncDirectory, writeExclusiveBytes, type JournalAppendCapacityEntry,
  type ReadableJournal } from '../evidence/original-run/journal.js';
import { prepareLockRoot, inspectRecoveryDirectory } from '../evidence/original-run/lock-path.js';
import { platformPath, readStable, sha256 } from './recovery/files.js';
import { normalizeUrl } from './credentials.js';
import type { ArtifactBytes, ArtifactKind, ReviewerRecoveryDeclaration, RunEnvelope } from './envelope.js';
import { MAX_ARTIFACT_BYTES, MAX_ENVELOPE_BYTES, validateRunEnvelope } from './envelope-validation.js';
import type { FlushOptions, FlushSummary } from './outbox.js';
import { HarnessSink, MAX_RESPONSE_BYTES, type RequestOptions, type ReviewerRecoveryPrincipal,
  type SinkOutcome } from './sink.js';

export const REVIEWER_OUTBOX_DIR = 'reviewer-outbox';
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i);
const digest = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
const reference = z.object({ sha256: digest, bytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES) }).strict();
const manifestSchema = z.object({ version: z.literal(1), runId: uuid, host: z.string(), credentialKind: z.enum(['login', 'env']),
  envelope: reference, report_json: reference, report_md: reference.optional(), reviewer: reference }).strict();
type Manifest = z.infer<typeof manifestSchema>;
export interface ReviewerDeliveryInput { sink: HarnessSink; envelope: RunEnvelope; artifacts: ArtifactBytes; artifact: ReviewerArtifact }
export interface ReviewerDeliveryOptions { deadlineMs?: number; signal?: AbortSignal }
interface Entry { manifest: Manifest; manifestBytes: string; envelope: RunEnvelope; envelopeBytes: string; artifacts: ArtifactBytes; privateBytes: string; directory: string }
export interface RetainedReviewerRecoverySelection {
  target: string;
  runId: string;
  headSha: string;
  reportSha256: string;
  reportByteLength: number;
  reportBytes: string;
  reviewerArtifactSha256: string;
  reviewerArtifactByteLength: number;
  reviewerArtifactBytes: string;
  reviewerRecovery: ReviewerRecoveryDeclaration;
}
export interface RetainedReviewerRecoveryPreview {
  version: 1;
  target: string;
  runId: string;
  headSha: string;
  host: string;
  credentialKind: 'login' | 'env';
  manifest: { sha256: string; bytes: number };
  envelope: { sha256: string; bytes: number };
  report_json: { sha256: string; bytes: number };
  report_md?: { sha256: string; bytes: number };
  reviewer: { sha256: string; bytes: number };
}
export interface RetainedReviewerRecoveryDestination {
  host: string;
  credentialKind: 'login' | 'env';
  activationProtocol: 1;
  principal: ReviewerRecoveryPrincipal;
}
interface RetainedReviewerRecoveryOperation {
  mode: 'apply' | 'resume';
  operationId: string;
  recoveryManifestSha256: string;
  destination: RetainedReviewerRecoveryDestination;
  journal: ReadableJournal;
}
export interface RetainedReviewerRecoveryOperationInput extends Omit<RetainedReviewerRecoveryOperation,
  'journal'> {
  manifestPath: string;
}
export interface RetainedReviewerRecoveryPreparation {
  preview: RetainedReviewerRecoveryPreview;
  envelopeBytes: string;
  reportMarkdownBytes?: string;
}
const putOutcomePhases = ['report_json_put_outcome', 'report_md_put_outcome', 'reviewer_put_outcome'] as const;
const MAX_PUT_RETRIES_PER_ARTIFACT = 100;
const MAX_PUT_OUTCOMES_PER_ARTIFACT = 1 + MAX_PUT_RETRIES_PER_ARTIFACT;
const PUT_COMPLETION_RESERVATION_CHECKPOINTS = 7;
const PUT_COMPLETION_RESERVATION_BYTES = PUT_COMPLETION_RESERVATION_CHECKPOINTS * MAX_RECOVERY_CHECKPOINT_BYTES;
const PUT_COMPLETION_AFTER_INTENT_CHECKPOINTS = PUT_COMPLETION_RESERVATION_CHECKPOINTS - 1;
const PUT_COMPLETION_AFTER_INTENT_BYTES = PUT_COMPLETION_AFTER_INTENT_CHECKPOINTS * MAX_RECOVERY_CHECKPOINT_BYTES;
// Sink response bodies are bounded before classification. The retained outcome
// keeps only kind/status/error. Invalid UTF-8 can expand to one three-byte
// replacement character per input byte, with room for its checkpoint wrapper.
const MAX_OUTCOME_CHECKPOINT_BYTES = 3 * MAX_RESPONSE_BYTES + 4096;
function putOutcomeAttempt(phase: string): { base: typeof putOutcomePhases[number]; attempt: number } | undefined {
  for (const base of putOutcomePhases) {
    if (phase === base) return { base, attempt: 1 };
    if (!phase.startsWith(`${base}_`)) continue;
    const suffix = phase.slice(base.length + 1);
    if (!/^(?:[2-9]|[1-9][0-9]+)$/.test(suffix)) return undefined;
    const attempt = Number(suffix);
    return Number.isSafeInteger(attempt) && attempt >= 2 ? { base, attempt } : undefined;
  }
  return undefined;
}
const isOutcomePhase = (phase: string) => phase === 'activation_post_outcome' || putOutcomeAttempt(phase) !== undefined;
const operationPhases = new Set(['prepared', 'activation_post_intent', 'activation_post_outcome', ...putOutcomePhases, 'activation_post_uncertain',
  'envelope_verified', 'report_json_put_intent', 'report_json_verified',
  'report_md_put_intent', 'report_md_verified', 'reviewer_put_intent',
  'reviewer_put_replay_intent', 'reviewer_verified', 'recovery_acknowledged', 'complete']);
const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), http_status: z.number().int() }).strict(),
  z.object({ kind: z.literal('disabled') }).strict(),
  z.object({ kind: z.literal('conflict') }).strict(),
  z.object({ kind: z.literal('rejected'), http_status: z.number().int(), error: z.string() }).strict(),
  z.object({ kind: z.literal('unavailable'), http_status: z.number().int().optional() }).strict(),
]);
const files = { report_json: 'report.json', report_md: 'report.md' } as const;
const ref = (text: string) => ({ sha256: sha256(text), bytes: Buffer.byteLength(text) });
function fail(reason: string): never { throw new Error(`reviewer_delivery_${reason}`); }
function safeFailure(error: unknown): string {
  if (error instanceof Error && error.message === 'recovery_run_locked') return 'reviewer_delivery_recovery_run_locked';
  return error instanceof Error && /^reviewer_delivery_[a-z_]+$/.test(error.message) ? error.message : 'reviewer_delivery_local_refusal';
}
function accepted<T>(outcome: SinkOutcome<T>): T {
  if (outcome.kind !== 'ok') fail(outcome.kind === 'unavailable' ? 'unavailable' : 'refused');
  return outcome.value;
}
async function privateRead(path: string, limit: number): Promise<string> {
  const check = async () => { const stat = await lstat(path); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600) fail('unsafe_file'); };
  await check(); const raw = await readStable(path, limit); await check();
  // readStable's UTF-8 decoder may normalize BOM; private payload bytes may not.
  if (!Buffer.from(raw.text).equals(raw.raw)) fail('nonexact_bytes');
  return raw.text;
}
async function publish(path: string, bytes: string): Promise<void> {
  try { await writeExclusiveBytes(path, Buffer.from(bytes)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await privateRead(path, MAX_ARTIFACT_BYTES) !== bytes) fail('immutable_conflict');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(join(path, '..'));
  }
}
function validate(entry: Entry): void {
  const { manifest: m, envelope, artifacts, privateBytes } = entry;
  if (normalizeUrl(m.host) !== m.host || m.envelope.bytes > MAX_ENVELOPE_BYTES || envelope.run.id !== m.runId ||
      entry.manifestBytes !== JSON.stringify(m) || entry.envelopeBytes !== JSON.stringify(envelope) ||
      validateRunEnvelope(envelope, artifacts).length || !isDeepStrictEqual(ref(entry.envelopeBytes), m.envelope) ||
      !isDeepStrictEqual(ref(artifacts.report_json), m.report_json) || !isDeepStrictEqual(ref(privateBytes), m.reviewer) ||
      (m.report_md === undefined ? artifacts.report_md !== undefined : !isDeepStrictEqual(ref(artifacts.report_md!), m.report_md))) fail('invalid_entry');
  const declaration = envelope.reviewer_recovery;
  if (!declaration || declaration.sha256 !== m.reviewer.sha256 || declaration.bytes !== m.reviewer.bytes) fail('declaration_mismatch');
  const wire = JSON.parse(privateBytes), report = JSON.parse(artifacts.report_json);
  if (wire.report?.bytes !== artifacts.report_json || wire.report?.sha256 !== m.report_json.sha256 ||
      wire.assembly?.run?.id !== m.runId || report.run?.id !== m.runId ||
      !isDeepStrictEqual(report.run?.reviewer_evidence, declaration.descriptor)) fail('report_binding');
}
function budget(options: ReviewerDeliveryOptions): () => RequestOptions {
  const duration = options.deadlineMs ?? 120_000;
  if (!Number.isFinite(duration) || duration < 0) fail('invalid_deadline');
  const bounded = Math.min(duration, 120_000), end = performance.now() + bounded;
  const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(bounded)));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  return () => { const left = end - performance.now(); if (left <= 0 || signal.aborted) fail('deadline'); return { timeoutMs: left, signal }; };
}

/**
 * Immutable private delivery copies. No token or token fingerprint is retained.
 * Current server authorization, not this local directory, determines ownership.
 * Unknown-run restart refuses: a replacement principal cannot recreate a run.
 */
export class ReviewerDeliveryQueue {
  readonly root: string;
  constructor(dataDir: string) { this.root = join(platformPath(dataDir), REVIEWER_OUTBOX_DIR); }

  /** Retain exact already-validated local bytes; never admit deserialized brands. */
  async retain(input: ReviewerDeliveryInput): Promise<void> {
    const entry = this.snapshot(input);
    await this.lock(entry.manifest.runId, async () => { await this.save(entry); });
  }

  /** Initial delivery is the only path allowed to create an as-yet unknown run. */
  async deliver(input: ReviewerDeliveryInput, options: ReviewerDeliveryOptions = {}, authorizeTransfer?: () => Promise<void>): Promise<void> {
    const entry = this.snapshot(input), request = budget(options);
    await this.lock(entry.manifest.runId, async () => {
      await this.assertGenericDeliveryAllowed(entry.manifest.runId);
      await authorizeTransfer?.();
      request(); await this.save(entry);
      // An existing manifest might belong to an earlier process/principal.
      // Only this invocation's first publication can use the creation path.
      await this.transfer(await this.load(entry.manifest.runId), input.sink, request,
        entryWasNew.delete(entry) ? 'initial' : 'retry');
    });
  }

  /** Explicit/current-credential retry; no provider calls or changed run identity. */
  async flush(
    sink: HarnessSink,
    options: FlushOptions = {},
    authorizeTransfer?: () => Promise<void>,
  ): Promise<FlushSummary> {
    const summary: FlushSummary = { delivered: [], remaining: [], failed: [], dropped: [] };
    const request = budget({ deadlineMs: options.deadlineMs });
    let names: string[];
    try { names = await readdir(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summary; throw error; }
    if (options.runId !== undefined && !uuid.safeParse(options.runId).success) fail('invalid_run');
    const selected = names.filter(name => uuid.safeParse(name).success && (!options.runId || name === options.runId.toLowerCase())).sort();
    for (const [index, id] of selected.entries()) {
      try {
        request();
        await this.lock(id, async () => {
          const entry = await this.load(id);
          await this.assertGenericDeliveryAllowed(id);
          if (await this.acknowledged(entry)) return;
          await authorizeTransfer?.();
          request(); await this.transfer(entry, sink, request, 'retry'); summary.delivered.push(entry.manifest.runId);
        });
      } catch (error) {
        const reason = safeFailure(error); summary.remaining.push(id); summary.failed.push({ id, reason });
        if (reason === 'reviewer_delivery_deadline') summary.stopped = 'deadline';
        else if (reason === 'reviewer_delivery_unavailable') summary.stopped = 'unavailable';
        if (summary.stopped) { summary.remaining.push(...selected.slice(index + 1)); break; }
      }
    }
    return summary;
  }

  /** Local retention only; never a server acknowledgment. */
  async isRetained(runId: string): Promise<boolean> {
    if (!uuid.safeParse(runId).success) return false;
    try { await this.lock(runId, async () => { await this.load(runId); }); return true; }
    catch { return false; }
  }

  /** Presence alone blocks legacy delivery; malformed retained state must fail closed too. */
  async hasEntry(runId: string): Promise<boolean> {
    if (!uuid.safeParse(runId).success) return false;
    try { await lstat(join(this.root, runId.toLowerCase())); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  /** Generic retry paths must never bypass an explicit retained activation operation. */
  async assertGenericDeliveryAllowed(runId: string): Promise<void> {
    if (!uuid.safeParse(runId).success) fail('invalid_run');
    try { await lstat(join(this.root, runId.toLowerCase(), 'activation-intent.json')); fail('explicit_activation_required'); }
    catch (error) {
      if (error instanceof Error && error.message === 'reviewer_delivery_explicit_activation_required') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Hold the run lock across a selected generic transmission so activation cannot race it. */
  async withGenericDeliveryAllowed<T>(runId: string, work: () => Promise<T>): Promise<T> {
    return this.lock(runId, async () => {
      await this.assertGenericDeliveryAllowed(runId);
      return work();
    });
  }

  /** Read-only exact activation proposal derived from authenticated local lineage. */
  async previewRecovery(selection: RetainedReviewerRecoverySelection): Promise<RetainedReviewerRecoveryPreview> {
    return (await this.prepareRecovery(selection)).preview;
  }

  recoveryJournalPath(runId: string, operationId: string): string {
    if (!uuid.safeParse(runId).success || !uuid.safeParse(operationId).success) fail('recovery_operation_mismatch');
    return join(this.root, runId.toLowerCase(), 'recovery.journal');
  }

  /** Read-only retained bytes after checkpoint lineage and private outbox authentication. */
  async prepareRecovery(selection: RetainedReviewerRecoverySelection): Promise<RetainedReviewerRecoveryPreparation> {
    if (!selection || typeof selection !== 'object' || !uuid.safeParse(selection.runId).success) fail('invalid_recovery_selection');
    return this.lock(selection.runId, async () => {
      const entry = await this.load(selection.runId);
      return { preview: this.recoveryPreview(entry, selection), envelopeBytes: entry.envelopeBytes,
        ...(entry.artifacts.report_md === undefined ? {} : { reportMarkdownBytes: entry.artifacts.report_md }) };
    });
  }

  /** Reject conflicting local acknowledgements before notice, journal creation, or transport. */
  async preflightRecoveryAcknowledgements(
    selection: RetainedReviewerRecoverySelection,
    preview: RetainedReviewerRecoveryPreview,
    operationInput?: RetainedReviewerRecoveryOperationInput,
  ): Promise<void> {
    if (!selection || typeof selection !== 'object' || !uuid.safeParse(selection.runId).success) fail('invalid_recovery_selection');
    await this.lock(selection.runId, async () => {
      const entry = await this.load(selection.runId);
      if (!isDeepStrictEqual(this.recoveryPreview(entry, selection), preview)) fail('recovery_selection_mismatch');
      if (operationInput === undefined) {
        await this.assertOrdinaryAcknowledgement(entry);
        if (await this.optionalPrivateRead(join(entry.directory, 'recovery-acknowledged.json'), 4096) !== undefined) {
          fail('immutable_conflict');
        }
        return;
      }
      const operation = await this.resolveRecoveryOperation(operationInput, selection.runId);
      this.validateRecoveryOperation(entry, operation);
      const activationIntent = this.activationIntent(entry, operation);
      const recoveryAck = this.recoveryAcknowledgement(entry, operation, activationIntent);
      this.assertRecoveryJournalAcknowledgements(operation, recoveryAck);
      await this.assertRecoveryAcknowledgements(entry, recoveryAck);
    });
  }

  /** Activate an exact retained entry. Generic flush never receives this creation authority. */
  async applyRecovery(
    sink: HarnessSink,
    selection: RetainedReviewerRecoverySelection,
    preview: RetainedReviewerRecoveryPreview,
    operationInput: RetainedReviewerRecoveryOperationInput,
    options: ReviewerDeliveryOptions = {},
  ): Promise<void> {
    await this.applyRecoveryOperation(sink, selection, preview,
      () => this.resolveRecoveryOperation(operationInput, selection.runId), options);
  }

  private async applyRecoveryOperation(
    sink: HarnessSink,
    selection: RetainedReviewerRecoverySelection,
    preview: RetainedReviewerRecoveryPreview,
    resolveOperation: () => Promise<RetainedReviewerRecoveryOperation>,
    options: ReviewerDeliveryOptions = {},
  ): Promise<void> {
    if (!selection || typeof selection !== 'object' || !uuid.safeParse(selection.runId).success) fail('invalid_recovery_selection');
    const request = budget(options);
    await this.lock(selection.runId, async () => {
      const entry = await this.load(selection.runId);
      const current = this.recoveryPreview(entry, selection);
      if (!isDeepStrictEqual(current, preview)) fail('recovery_selection_mismatch');
      const operation = await resolveOperation();
      request(); await this.recover(entry, sink, request, operation);
    });
  }

  /** Resume is the same exact operation; server readback decides which writes remain. */
  async resumeRecovery(
    sink: HarnessSink,
    selection: RetainedReviewerRecoverySelection,
    preview: RetainedReviewerRecoveryPreview,
    operation: RetainedReviewerRecoveryOperationInput,
    options: ReviewerDeliveryOptions = {},
  ): Promise<void> {
    await this.applyRecovery(sink, selection, preview, operation, options);
  }

  private snapshot(input: ReviewerDeliveryInput): Entry {
    if (!isReviewerArtifact(input.artifact)) fail('unvalidated_artifact');
    if (input.sink.credentialSource === 'attest') fail('attested_replay_unsupported');
    const envelopeBytes = JSON.stringify(input.envelope), envelope = JSON.parse(envelopeBytes) as RunEnvelope;
    const artifacts = { ...input.artifacts }, privateBytes = input.artifact.bytes;
    const manifest = manifestSchema.parse({ version: 1, runId: envelope.run.id, host: input.sink.baseUrl, credentialKind: input.sink.credentialSource,
      envelope: ref(envelopeBytes), report_json: ref(artifacts.report_json), ...(artifacts.report_md === undefined ? {} : { report_md: ref(artifacts.report_md) }), reviewer: ref(privateBytes) });
    const entry = { manifest, manifestBytes: JSON.stringify(manifest), envelope, envelopeBytes, artifacts, privateBytes,
      directory: join(this.root, manifest.runId.toLowerCase()) };
    validate(entry); return entry;
  }
  private async lock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    return withRecoveryLock(join(this.root, 'locks'), runId.toLowerCase(), work);
  }

  private async resolveRecoveryOperation(
    operation: RetainedReviewerRecoveryOperationInput,
    runId: string,
  ): Promise<RetainedReviewerRecoveryOperation> {
    const manifestPath = platformPath(operation.manifestPath);
    const retained = await readStable(manifestPath, MAX_RECOVERY_DOCUMENT_BYTES, { sync: true });
    if (retained.sha256 !== operation.recoveryManifestSha256) fail('manifest_digest_mismatch');
    return { mode: operation.mode, operationId: operation.operationId,
      recoveryManifestSha256: operation.recoveryManifestSha256, destination: operation.destination,
      journal: await openJournal(this.recoveryJournalPath(runId, operation.operationId), operation.recoveryManifestSha256,
        operation.operationId, operation.mode) };
  }
  private async save(entry: Entry): Promise<void> {
    await prepareLockRoot(this.root);
    try { await mkdir(entry.directory, { mode: 0o700 }); await syncDirectory(this.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await inspectRecoveryDirectory(entry.directory, true);
    const existing = await readdir(entry.directory);
    if (existing.length === 0) entryWasNew.add(entry);
    await publish(join(entry.directory, 'envelope.json'), entry.envelopeBytes);
    await publish(join(entry.directory, 'reviewer-artifact.json'), entry.privateBytes);
    for (const kind of ['report_json', 'report_md'] as const) if (entry.artifacts[kind] !== undefined) await publish(join(entry.directory, files[kind]), entry.artifacts[kind]!);
    // Publish manifest last; a crash before it leaves evidence, never an uploadable partial entry.
    await publish(join(entry.directory, 'manifest.json'), entry.manifestBytes);
  }
  private async load(id: string): Promise<Entry> {
    const directory = join(this.root, id.toLowerCase()); await inspectRecoveryDirectory(directory, true);
    const manifestBytes = await privateRead(join(directory, 'manifest.json'), 4096);
    const manifest = manifestSchema.parse(JSON.parse(manifestBytes));
    if (manifest.runId.toLowerCase() !== id.toLowerCase()) fail('invalid_run');
    const allowed = ['manifest.json', 'envelope.json', 'reviewer-artifact.json', 'report.json', 'acknowledged.json',
      'activation-intent.json', 'recovery-acknowledged.json', 'recovery.journal',
      ...(manifest.report_md ? ['report.md'] : [])];
    if ((await readdir(directory)).some(name => !allowed.includes(name))) fail('unknown_file');
    const envelopeBytes = await privateRead(join(directory, 'envelope.json'), MAX_ENVELOPE_BYTES);
    const entry: Entry = { manifest, manifestBytes, directory, envelopeBytes, envelope: JSON.parse(envelopeBytes), privateBytes: await privateRead(join(directory, 'reviewer-artifact.json'), MAX_ARTIFACT_BYTES),
      artifacts: { report_json: await privateRead(join(directory, 'report.json'), MAX_ARTIFACT_BYTES), ...(manifest.report_md ? { report_md: await privateRead(join(directory, 'report.md'), MAX_ARTIFACT_BYTES) } : {}) } };
    validate(entry); return entry;
  }
  private recoveryPreview(entry: Entry, selection: RetainedReviewerRecoverySelection): RetainedReviewerRecoveryPreview {
    const report = ref(selection.reportBytes), reviewer = ref(selection.reviewerArtifactBytes);
    const run = entry.envelope.run;
    if (typeof selection.target !== 'string' || !selection.target || !/^[a-f0-9]{40}$/.test(selection.headSha) ||
      selection.runId.toLowerCase() !== entry.manifest.runId.toLowerCase() || run.id !== entry.manifest.runId ||
      run.converge?.target !== selection.target || run.target.head_sha !== selection.headSha ||
      selection.reportSha256 !== report.sha256 || selection.reportByteLength !== report.bytes ||
      selection.reviewerArtifactSha256 !== reviewer.sha256 || selection.reviewerArtifactByteLength !== reviewer.bytes ||
      entry.artifacts.report_json !== selection.reportBytes || entry.privateBytes !== selection.reviewerArtifactBytes ||
      !isDeepStrictEqual(entry.envelope.reviewer_recovery, selection.reviewerRecovery) ||
      !isDeepStrictEqual(entry.manifest.report_json, report) || !isDeepStrictEqual(entry.manifest.reviewer, reviewer)) {
      fail('recovery_selection_mismatch');
    }
    return { version: 1, target: selection.target, runId: entry.manifest.runId, headSha: selection.headSha,
      host: entry.manifest.host, credentialKind: entry.manifest.credentialKind,
      manifest: ref(entry.manifestBytes), envelope: { ...entry.manifest.envelope },
      report_json: { ...entry.manifest.report_json },
      ...(entry.manifest.report_md ? { report_md: { ...entry.manifest.report_md } } : {}),
      reviewer: { ...entry.manifest.reviewer } };
  }
  private ack(entry: Entry): string { return JSON.stringify({ version: 1, runId: entry.manifest.runId, manifestSha256: sha256(entry.manifestBytes) }); }
  private async optionalPrivateRead(path: string, limit: number): Promise<string | undefined> {
    try { return await privateRead(path, limit); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async assertOrdinaryAcknowledgement(entry: Entry): Promise<void> {
    const bytes = await this.optionalPrivateRead(join(entry.directory, 'acknowledged.json'), 4096);
    if (bytes !== undefined && bytes !== this.ack(entry)) fail('immutable_conflict');
  }
  private activationIntent(entry: Entry, operation: RetainedReviewerRecoveryOperation): string {
    return JSON.stringify({ version: 1, runId: entry.manifest.runId, operationId: operation.operationId,
      recoveryManifestSha256: operation.recoveryManifestSha256, envelopeSha256: entry.manifest.envelope.sha256 });
  }
  private validateRecoveryOperation(entry: Entry, operation: RetainedReviewerRecoveryOperation): void {
    const m = entry.manifest;
    if (!operation || !uuid.safeParse(operation.operationId).success || !digest.safeParse(operation.recoveryManifestSha256).success ||
      !operation.journal || (operation.mode !== 'apply' && operation.mode !== 'resume') ||
      operation.destination.host !== m.host || operation.destination.credentialKind !== m.credentialKind ||
      operation.destination.activationProtocol !== 1) fail('recovery_operation_mismatch');
  }
  private recoveryOutcomeDigest(operation: RetainedReviewerRecoveryOperation): string {
    const outcomes = operation.journal.checkpoints()
      .filter(checkpoint => isOutcomePhase(checkpoint.phase))
      .map(checkpoint => {
        const parsed = outcomeSchema.safeParse(checkpoint.data);
        if (!parsed.success || !isDeepStrictEqual(parsed.data, checkpoint.data)) fail('journal_checkpoint_conflict');
        return { phase: checkpoint.phase, data: parsed.data };
      });
    return sha256(JSON.stringify(outcomes));
  }
  private recoveryAcknowledgement(entry: Entry, operation: RetainedReviewerRecoveryOperation, activationIntent: string): string {
    const m = entry.manifest;
    return JSON.stringify({ version: 1, operationId: operation.operationId,
      recoveryManifestSha256: operation.recoveryManifestSha256, outboxManifestSha256: sha256(entry.manifestBytes),
      activationIntentSha256: sha256(activationIntent), journalOutcomesSha256: this.recoveryOutcomeDigest(operation),
      destination: operation.destination, envelope: m.envelope, report_json: m.report_json,
      ...(m.report_md ? { report_md: m.report_md } : {}), reviewer: m.reviewer });
  }
  private assertRecoveryJournalAcknowledgements(operation: RetainedReviewerRecoveryOperation, recoveryAck: string): void {
    const acknowledgement = operation.journal.checkpoints().find(checkpoint => checkpoint.phase === 'recovery_acknowledged');
    if (acknowledgement && !isDeepStrictEqual(acknowledgement.data, JSON.parse(recoveryAck))) fail('journal_checkpoint_conflict');
    const complete = operation.journal.checkpoints().find(checkpoint => checkpoint.phase === 'complete');
    if (complete && !isDeepStrictEqual(complete.data, { recovery_ack_sha256: sha256(recoveryAck) })) fail('journal_checkpoint_conflict');
  }
  private async assertRecoveryAcknowledgements(entry: Entry, recoveryAck: string): Promise<void> {
    await this.assertOrdinaryAcknowledgement(entry);
    const bytes = await this.optionalPrivateRead(join(entry.directory, 'recovery-acknowledged.json'), 4096);
    if (bytes !== undefined && bytes !== recoveryAck) fail('immutable_conflict');
  }
  private async acknowledged(entry: Entry): Promise<boolean> {
    try { if (await privateRead(join(entry.directory, 'acknowledged.json'), 4096) !== this.ack(entry)) fail('invalid_ack'); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async transfer(entry: Entry, sink: HarnessSink, request: () => RequestOptions, mode: 'initial' | 'retry'): Promise<void> {
    const m = entry.manifest;
    if (sink.baseUrl !== m.host || sink.credentialSource !== m.credentialKind) fail('credential_mismatch');
    accepted(await sink.checkReviewerRecovery(request()));
    let read = mode === 'initial' ? undefined : await sink.getReviewerArtifact(m.runId, m.reviewer, request());
    if (read && read.kind !== 'ok' && read.kind !== 'pending') accepted(read);
    // A matching private read is the server's completed admission proof: it
    // validates the retained ordinary/private pair, so replaying the ordinary
    // uploads would only repeat already acknowledged work after a lost local ACK.
    if (read?.kind === 'ok') {
      if (!read.value.bytes.equals(Buffer.from(entry.privateBytes))) fail('private_mismatch');
      await publish(join(entry.directory, 'acknowledged.json'), this.ack(entry));
      return;
    }
    accepted(await sink.postRun(entry.envelope, request(), entry.envelopeBytes));
    read ??= await sink.getReviewerArtifact(m.runId, m.reviewer, request());
    if (read.kind !== 'ok' && read.kind !== 'pending') accepted(read);
    if (read.kind === 'ok' && !read.value.bytes.equals(Buffer.from(entry.privateBytes))) fail('private_mismatch');
    // Private admission validates the stored ordinary/private pair. Ordinary
    // reports must be present and read back before the private PUT.
    for (const kind of ['report_json', 'report_md'] as const) {
      const bytes = entry.artifacts[kind]; if (bytes === undefined) continue;
      accepted(await sink.putArtifact(m.runId, kind as ArtifactKind, bytes, request()));
      const raw = accepted(await sink.getArtifact(m.runId, kind, Buffer.byteLength(bytes), request()));
      if (!raw.bytes.equals(Buffer.from(bytes))) fail('ordinary_mismatch');
    }
    if (read.kind === 'pending') {
      accepted(await sink.putReviewerArtifact(m.runId, entry.privateBytes, m.reviewer, request()));
      read = await sink.getReviewerArtifact(m.runId, m.reviewer, request());
    }
    if (read.kind === 'pending') fail('unavailable');
    if (!accepted(read).bytes.equals(Buffer.from(entry.privateBytes))) fail('private_mismatch');
    await publish(join(entry.directory, 'acknowledged.json'), this.ack(entry));
  }

  private async recover(
    entry: Entry,
    sink: HarnessSink,
    request: () => RequestOptions,
    operation: RetainedReviewerRecoveryOperation,
  ): Promise<void> {
    const m = entry.manifest;
    this.validateRecoveryOperation(entry, operation);
    if (sink.baseUrl !== m.host || sink.credentialSource !== m.credentialKind) fail('recovery_operation_mismatch');
    const checkpoints = operation.journal.checkpoints();
    const phases = new Set<string>();
    const putAttempts = new Map<typeof putOutcomePhases[number], number>();
    const putHistories = new Map<typeof putOutcomePhases[number], Array<{ index: number; data: z.infer<typeof outcomeSchema> }>>();
    const phasePositions = new Map<string, number>();
    for (const [index, checkpoint] of checkpoints.entries()) {
      if (checkpoint.phase === 'interrupted_checkpoints_retained') continue;
      const putAttempt = putOutcomeAttempt(checkpoint.phase);
      if (!operationPhases.has(checkpoint.phase) && putAttempt === undefined) fail('journal_checkpoint_conflict');
      if (phases.has(checkpoint.phase)) fail('journal_checkpoint_conflict');
      phases.add(checkpoint.phase);
      phasePositions.set(checkpoint.phase, index);
      if (isOutcomePhase(checkpoint.phase)) {
        const parsed = outcomeSchema.safeParse(checkpoint.data);
        if (!parsed.success || !isDeepStrictEqual(parsed.data, checkpoint.data)) fail('journal_checkpoint_conflict');
      }
      if (putAttempt !== undefined) {
        const expected = (putAttempts.get(putAttempt.base) ?? 0) + 1;
        if (putAttempt.attempt !== expected) fail('journal_checkpoint_conflict');
        putAttempts.set(putAttempt.base, expected);
        const parsed = outcomeSchema.safeParse(checkpoint.data);
        if (!parsed.success) fail('journal_checkpoint_conflict');
        const history = putHistories.get(putAttempt.base) ?? [];
        history.push({ index, data: parsed.data });
        putHistories.set(putAttempt.base, history);
      }
    }
    for (const base of putOutcomePhases) {
      const prefix = base.slice(0, -'_put_outcome'.length);
      const intentPosition = phasePositions.get(`${prefix}_put_intent`);
      const verifiedPosition = phasePositions.get(`${prefix}_verified`);
      const history = putHistories.get(base) ?? [];
      if (history.length > 0 && intentPosition === undefined) fail('journal_checkpoint_conflict');
      if (intentPosition !== undefined && verifiedPosition !== undefined && intentPosition > verifiedPosition) {
        fail('journal_checkpoint_conflict');
      }
      for (const item of history) {
        if (item.index < intentPosition! || (verifiedPosition !== undefined && item.index > verifiedPosition)) {
          fail('journal_checkpoint_conflict');
        }
      }
      const terminalIndex = history.findIndex(item => item.data.kind !== 'unavailable');
      if (terminalIndex >= 0 && terminalIndex < history.length - 1) {
        const replayIntentPosition = phasePositions.get('reviewer_put_replay_intent');
        const first = history[0];
        const allowedReplayOutcome = base === 'reviewer_put_outcome' && operation.mode === 'resume' &&
          terminalIndex === 0 && history.length === 2 && replayIntentPosition !== undefined && first !== undefined &&
          first.data.kind === 'rejected' && first.data.http_status === 422 &&
          first.data.error === 'reviewer_artifact_http_422' &&
          first.index < replayIntentPosition && replayIntentPosition < history[1]!.index;
        if (!allowedReplayOutcome) fail('journal_checkpoint_conflict');
      }
      if (history.length > MAX_PUT_OUTCOMES_PER_ARTIFACT) fail('put_retry_limit');
    }
    const terminal422Prefix: Array<{ phase: string; data: unknown }> = m.report_md === undefined ? [] : [
      { phase: 'prepared', data: { outbox_manifest_sha256: sha256(entry.manifestBytes), destination: operation.destination } },
      { phase: 'activation_post_intent', data: { envelope: m.envelope } },
      { phase: 'activation_post_outcome', data: { kind: 'ok', http_status: 201 } },
      { phase: 'envelope_verified', data: { sha256: m.envelope.sha256,
        artifacts_declared: entry.envelope.artifacts_declared } },
      { phase: 'report_json_put_intent', data: m.report_json },
      { phase: 'report_json_put_outcome', data: { kind: 'ok', http_status: 201 } },
      { phase: 'report_json_verified', data: m.report_json },
      { phase: 'report_md_put_intent', data: m.report_md },
      { phase: 'report_md_put_outcome', data: { kind: 'ok', http_status: 201 } },
      { phase: 'report_md_verified', data: m.report_md },
      { phase: 'reviewer_put_intent', data: m.reviewer },
      { phase: 'reviewer_put_outcome', data: { kind: 'rejected', http_status: 422,
        error: 'reviewer_artifact_http_422' } },
    ];
    const exactPrefix = (length: number) => checkpoints.slice(0, length).every((checkpoint, index) => {
      const expected = terminal422Prefix[index];
      return expected !== undefined && checkpoint.phase === expected.phase &&
        isDeepStrictEqual(checkpoint.data, JSON.parse(JSON.stringify(expected.data)));
    });
    if (operation.mode === 'resume' && terminal422Prefix.length > 0 && checkpoints.length > 0 &&
      checkpoints.length < terminal422Prefix.length &&
      exactPrefix(checkpoints.length)) fail('journal_checkpoint_conflict');
    const terminal422Base = terminal422Prefix.length > 0 && checkpoints.length >= terminal422Prefix.length &&
      exactPrefix(terminal422Prefix.length);
    if (terminal422Base && operation.mode !== 'resume') fail('refused');
    const terminal422Replay = operation.mode === 'resume' && terminal422Base;
    if (terminal422Replay) {
      const suffix = checkpoints.slice(terminal422Prefix.length);
      const phases = suffix.map(checkpoint => checkpoint.phase);
      const allowedSuffixes = [
        [],
        ['reviewer_verified'],
        ['reviewer_verified', 'recovery_acknowledged'],
        ['reviewer_verified', 'recovery_acknowledged', 'complete'],
        ['reviewer_put_replay_intent'],
        ['reviewer_put_replay_intent', 'reviewer_put_outcome_2'],
        ['reviewer_put_replay_intent', 'reviewer_put_outcome_2', 'reviewer_verified'],
        ['reviewer_put_replay_intent', 'reviewer_put_outcome_2', 'reviewer_verified', 'recovery_acknowledged'],
        ['reviewer_put_replay_intent', 'reviewer_put_outcome_2', 'reviewer_verified', 'recovery_acknowledged', 'complete'],
      ];
      if (!allowedSuffixes.some(expected => isDeepStrictEqual(phases, expected))) fail('journal_checkpoint_conflict');
      for (const checkpoint of suffix) {
        if ((checkpoint.phase === 'reviewer_put_replay_intent' || checkpoint.phase === 'reviewer_verified') &&
          !isDeepStrictEqual(checkpoint.data, m.reviewer)) fail('journal_checkpoint_conflict');
        if (checkpoint.phase === 'reviewer_put_outcome_2') {
          const parsed = outcomeSchema.safeParse(checkpoint.data);
          if (!parsed.success || !isDeepStrictEqual(parsed.data, checkpoint.data)) fail('journal_checkpoint_conflict');
        }
      }
    }
    const reviewerHistory = putHistories.get('reviewer_put_outcome') ?? [];
    const firstReviewerOutcome = reviewerHistory[0];
    const replayOutcome = reviewerHistory[1]?.data;
    const replayIntentPosition = phasePositions.get('reviewer_put_replay_intent');
    if (replayIntentPosition !== undefined) {
      if (!terminal422Replay || operation.mode !== 'resume' || firstReviewerOutcome === undefined ||
        replayIntentPosition <= firstReviewerOutcome.index || reviewerHistory.length === 2 &&
        replayIntentPosition >= reviewerHistory[1]!.index) fail('journal_checkpoint_conflict');
    }
    if (reviewerHistory.length === 2 && replayIntentPosition === undefined) fail('journal_checkpoint_conflict');
    if (terminal422Replay && replayOutcome !== undefined &&
      (replayOutcome.kind === 'conflict' || replayOutcome.kind === 'disabled' || replayOutcome.kind === 'rejected')) {
      fail('refused');
    }
    const appendOnce = async (phase: string, data: unknown) => {
      const normalized = JSON.parse(JSON.stringify(data)) as unknown;
      const matches = operation.journal.checkpoints().filter(checkpoint => checkpoint.phase === phase);
      if (matches.length === 0) await operation.journal.append(phase, normalized);
      else if (matches.length !== 1 || !isDeepStrictEqual(matches[0]!.data, normalized)) fail('journal_checkpoint_conflict');
    };
    const appendPutOutcome = async (phase: string, data: unknown) => {
      if (!putOutcomePhases.includes(phase as typeof putOutcomePhases[number])) fail('journal_checkpoint_conflict');
      const attempts = operation.journal.checkpoints().filter(checkpoint => putOutcomeAttempt(checkpoint.phase)?.base === phase).length;
      if (attempts >= MAX_PUT_OUTCOMES_PER_ARTIFACT) fail('put_retry_limit');
      const attemptPhase = attempts === 0 ? phase : `${phase}_${attempts + 1}`;
      await operation.journal.append(attemptPhase, JSON.parse(JSON.stringify(data)) as unknown);
    };
    const assertPutMayProceed = (phase: typeof putOutcomePhases[number]) => {
      const verifiedPhase = `${phase.slice(0, -'_put_outcome'.length)}_verified`;
      if (operation.journal.checkpoints().some(checkpoint => checkpoint.phase === verifiedPhase)) fail('unavailable');
      const attempts = operation.journal.checkpoints()
        .filter(checkpoint => putOutcomeAttempt(checkpoint.phase)?.base === phase);
      const previous = attempts.at(-1);
      if (!previous) return;
      if (phase === 'reviewer_put_outcome' && terminal422Replay) {
        if (replayIntentPosition !== undefined) {
          if (attempts.length === 1) fail('unavailable');
          const parsed = outcomeSchema.safeParse(previous.data);
          if (!parsed.success || !isDeepStrictEqual(parsed.data, previous.data)) fail('journal_checkpoint_conflict');
          fail(parsed.data.kind === 'unavailable' || parsed.data.kind === 'ok' ? 'unavailable' : 'refused');
        }
        return;
      }
      const parsed = outcomeSchema.safeParse(previous.data);
      if (!parsed.success || !isDeepStrictEqual(parsed.data, previous.data)) fail('journal_checkpoint_conflict');
      if (parsed.data.kind === 'unavailable') {
        if (attempts.length >= MAX_PUT_OUTCOMES_PER_ARTIFACT) fail('put_retry_limit');
        return;
      }
      fail(parsed.data.kind === 'ok' ? 'unavailable' : 'refused');
    };
    const assertPutCapacityBeforeIntent = (prefix: 'report_json' | 'report_md' | 'reviewer') => {
      const intentExists = operation.journal.checkpoints().some(checkpoint => checkpoint.phase === `${prefix}_put_intent`);
      operation.journal.assertAppendCapacity(
        intentExists ? PUT_COMPLETION_AFTER_INTENT_CHECKPOINTS : PUT_COMPLETION_RESERVATION_CHECKPOINTS,
        intentExists ? PUT_COMPLETION_AFTER_INTENT_BYTES : PUT_COMPLETION_RESERVATION_BYTES,
      );
    };
    const assertExisting = (phase: string, data: unknown) => {
      const checkpoint = operation.journal.checkpoints().find(candidate => candidate.phase === phase);
      if (checkpoint && !isDeepStrictEqual(checkpoint.data, JSON.parse(JSON.stringify(data)))) fail('journal_checkpoint_conflict');
    };
    const outcome = (value: SinkOutcome<unknown>) => {
      const rawError = (value as { error?: unknown }).error;
      return { kind: value.kind,
        ...('httpStatus' in value ? { http_status: value.httpStatus } : {}),
        ...(rawError !== undefined ? { error: typeof rawError === 'string' ? rawError : 'malformed_response' } : {}) };
    };
    const assertDestination = async (requireArtifactReplay = false) => {
      const capability = accepted(await sink.checkReviewerRecoveryActivation(request(),
        requireArtifactReplay ? 1 : undefined));
      if (capability.protocol !== operation.destination.activationProtocol ||
        requireArtifactReplay && capability.artifactReplayProtocol !== 1 ||
        !isDeepStrictEqual(capability.principal, operation.destination.principal)) fail('principal_mismatch');
    };
    const privateReadback = async () => sink.getReviewerArtifact(m.runId, m.reviewer, request());
    const activationIntent = this.activationIntent(entry, operation);
    const initialRecoveryAck = this.recoveryAcknowledgement(entry, operation, activationIntent);
    const activationIntentPath = join(entry.directory, 'activation-intent.json');
    let activationIntentPresent = false;
    try {
      if (await privateRead(activationIntentPath, 4096) !== activationIntent) fail('activation_operation_conflict');
      activationIntentPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const ensureActivationIntent = async () => {
      if (activationIntentPresent) return;
      await publish(activationIntentPath, activationIntent);
      activationIntentPresent = true;
    };
    const absent = (value: Awaited<ReturnType<typeof privateReadback>>) => value.kind === 'rejected' &&
      value.httpStatus === 404 && value.error === 'reviewer_artifact_http_404';
    const inspectOrdinary = async (kind: 'report_json' | 'report_md', bytes: string): Promise<'exact' | 'missing' | 'mismatch'> => {
      const read = await sink.getArtifact(m.runId, kind, Buffer.byteLength(bytes), request());
      if (read.kind === 'ok') return read.value.bytes.equals(Buffer.from(bytes)) ? 'exact' : 'mismatch';
      if (read.kind === 'rejected' && read.httpStatus === 404) return 'missing';
      accepted(read);
      return 'mismatch';
    };
    const assertEnvelopeReceipt = (receipt: Awaited<ReturnType<typeof sink.getRunReceipt>>) => {
      if (receipt.kind === 'recorded') return;
      if (receipt.kind === 'unavailable') fail('unavailable');
      fail(receipt.kind === 'absent' ? 'envelope_receipt_absent' : 'envelope_receipt_mismatch');
    };

    assertExisting('prepared', { outbox_manifest_sha256: sha256(entry.manifestBytes), destination: operation.destination });
    assertExisting('activation_post_intent', { envelope: m.envelope });
    assertExisting('activation_post_uncertain', { reason: 'intent_without_remote_readback' });
    assertExisting('report_json_put_intent', m.report_json);
    if (m.report_md) assertExisting('report_md_put_intent', m.report_md);
    assertExisting('reviewer_put_intent', m.reviewer);
    assertExisting('envelope_verified', { sha256: m.envelope.sha256, artifacts_declared: entry.envelope.artifacts_declared });
    assertExisting('report_json_verified', m.report_json);
    if (m.report_md) assertExisting('report_md_verified', m.report_md);
    assertExisting('reviewer_verified', m.reviewer);
    assertExisting('reviewer_put_replay_intent', m.reviewer);
    this.assertRecoveryJournalAcknowledgements(operation, initialRecoveryAck);
    await this.assertRecoveryAcknowledgements(entry, initialRecoveryAck);

    if (terminal422Replay && !operation.journal.checkpoints().some(checkpoint =>
      checkpoint.phase === 'recovery_acknowledged')) {
      const recoveryAck = await this.optionalPrivateRead(join(entry.directory, 'recovery-acknowledged.json'), 4096);
      const ordinaryAck = await this.optionalPrivateRead(join(entry.directory, 'acknowledged.json'), 4096);
      // Publishing the immutable recovery acknowledgement precedes its journal
      // checkpoint. An exact file may therefore survive that crash frontier;
      // assertRecoveryAcknowledgements above has already bound its bytes to the
      // current journal outcomes. The ordinary acknowledgement is published
      // only after the recovery checkpoint and cannot legitimately exist here.
      if ((recoveryAck !== undefined && recoveryAck !== initialRecoveryAck) || ordinaryAck !== undefined) {
        fail('immutable_conflict');
      }
    }

    await assertDestination(terminal422Replay);
    let read = await privateReadback();
    if (read.kind !== 'ok' && read.kind !== 'pending' && !absent(read)) accepted(read);
    if (read.kind === 'ok' && !read.value.bytes.equals(Buffer.from(entry.privateBytes))) fail('private_mismatch');
    const plannedEnvelopeReceipt = await sink.getRunReceipt(entry.envelope, entry.envelopeBytes, request());
    if (!absent(read)) assertEnvelopeReceipt(plannedEnvelopeReceipt);
    const hasCheckpoint = (phase: string) => operation.journal.checkpoints()
      .some(checkpoint => checkpoint.phase === phase);
    const appendPlan: JournalAppendCapacityEntry[] = [];
    const putBoundaries: Array<{ index: number; reservation: number }> = [];
    const planExact = (phase: string, data: unknown) => {
      if (!hasCheckpoint(phase)) appendPlan.push({ phase, data });
    };
    const planOutcome = () => appendPlan.push({ maximumBytes: MAX_OUTCOME_CHECKPOINT_BYTES });
    const planVerified = (prefix: 'report_json' | 'report_md' | 'reviewer', data: unknown) => {
      planExact(`${prefix}_verified`, data);
    };
    const planPut = (prefix: 'report_json' | 'report_md' | 'reviewer', data: unknown) => {
      const intentExists = hasCheckpoint(`${prefix}_put_intent`);
      const index = appendPlan.length;
      planExact(`${prefix}_put_intent`, data);
      planOutcome();
      planVerified(prefix, data);
      putBoundaries.push({ index, reservation: intentExists ? PUT_COMPLETION_AFTER_INTENT_CHECKPOINTS :
        PUT_COMPLETION_RESERVATION_CHECKPOINTS });
    };
    planExact('prepared', { outbox_manifest_sha256: sha256(entry.manifestBytes), destination: operation.destination });
    const activationUncertain = absent(read) && hasCheckpoint('activation_post_intent');
    if (absent(read)) {
      if (activationUncertain) planExact('activation_post_uncertain', { reason: 'intent_without_remote_readback' });
      else {
        planExact('activation_post_intent', { envelope: m.envelope });
        planOutcome();
      }
    }
    if (!activationUncertain) planExact('envelope_verified', {
      sha256: m.envelope.sha256, artifacts_declared: entry.envelope.artifacts_declared,
    });
    for (const kind of ['report_json', 'report_md'] as const) {
      const bytes = entry.artifacts[kind]; if (bytes === undefined) continue;
      const state = await inspectOrdinary(kind, bytes);
      if (state === 'mismatch') fail('ordinary_mismatch');
      if (state === 'missing') {
        if (terminal422Replay) fail('ordinary_mismatch');
        assertPutMayProceed(`${kind}_put_outcome`);
        if (!activationUncertain) planPut(kind, m[kind]);
      } else if (!activationUncertain) planVerified(kind, m[kind]);
    }
    if (read.kind === 'pending' || absent(read)) {
      assertPutMayProceed('reviewer_put_outcome');
      if (!activationUncertain) {
        if (terminal422Replay) planExact('reviewer_put_replay_intent', m.reviewer);
        planPut('reviewer', m.reviewer);
      }
    } else if (!activationUncertain) planVerified('reviewer', m.reviewer);
    if (!activationUncertain) {
      planExact('recovery_acknowledged', JSON.parse(initialRecoveryAck));
      planExact('complete', { recovery_ack_sha256: '0'.repeat(64) });
    }
    for (const boundary of putBoundaries) {
      operation.journal.assertAppendPlanCapacity([
        ...appendPlan.slice(0, boundary.index),
        ...Array.from({ length: boundary.reservation }, () => ({ maximumBytes: MAX_RECOVERY_CHECKPOINT_BYTES })),
      ]);
    }
    operation.journal.assertAppendPlanCapacity(appendPlan);
    await appendOnce('prepared', { outbox_manifest_sha256: sha256(entry.manifestBytes), destination: operation.destination });
    if (absent(read)) {
      const postIntent = operation.journal.checkpoints().filter(checkpoint => checkpoint.phase === 'activation_post_intent');
      if (postIntent.length > 0) {
        await appendOnce('activation_post_intent', { envelope: m.envelope });
        await appendOnce('activation_post_uncertain', { reason: 'intent_without_remote_readback' });
        fail('activation_post_uncertain');
      }
      // This entry-level immutable intent prevents a second manifest or journal
      // from granting another POST after any process loss around transport.
      await ensureActivationIntent();
      await appendOnce('activation_post_intent', { envelope: m.envelope });
      await assertDestination();
      const posted = await sink.postRun(entry.envelope, request(), entry.envelopeBytes);
      await appendOnce('activation_post_outcome', outcome(posted));
      read = await privateReadback();
      if (absent(read)) {
        await appendOnce('activation_post_uncertain', { reason: 'intent_without_remote_readback' });
        fail('activation_post_uncertain');
      }
    }
    if (read.kind !== 'ok' && read.kind !== 'pending') accepted(read);
    if (read.kind === 'ok' && !read.value.bytes.equals(Buffer.from(entry.privateBytes))) fail('private_mismatch');

    const envelopeReceipt = await sink.getRunReceipt(entry.envelope, entry.envelopeBytes, request());
    assertEnvelopeReceipt(envelopeReceipt);
    await appendOnce('envelope_verified', { sha256: m.envelope.sha256, artifacts_declared: entry.envelope.artifacts_declared });

    for (const kind of ['report_json', 'report_md'] as const) {
      const bytes = entry.artifacts[kind]; if (bytes === undefined) continue;
      const state = await inspectOrdinary(kind, bytes);
      if (state === 'exact') {
        await appendOnce(`${kind}_verified`, m[kind]);
        continue;
      }
      if (state === 'mismatch') fail('ordinary_mismatch');
      assertPutMayProceed(`${kind}_put_outcome`);
      assertPutCapacityBeforeIntent(kind);
      await assertDestination();
      await ensureActivationIntent();
      await appendOnce(`${kind}_put_intent`, m[kind]);
      operation.journal.assertAppendCapacity(PUT_COMPLETION_AFTER_INTENT_CHECKPOINTS, PUT_COMPLETION_AFTER_INTENT_BYTES);
      const uploaded = await sink.putArtifact(m.runId, kind as ArtifactKind, bytes, request());
      await appendPutOutcome(`${kind}_put_outcome`, outcome(uploaded));
      if (await inspectOrdinary(kind, bytes) !== 'exact') {
        if (uploaded.kind !== 'ok') accepted(uploaded);
        fail('ordinary_mismatch');
      }
      await appendOnce(`${kind}_verified`, m[kind]);
    }
    read = await privateReadback();
    if (read.kind !== 'ok' && read.kind !== 'pending') accepted(read);
    if (read.kind === 'ok' && !read.value.bytes.equals(Buffer.from(entry.privateBytes))) fail('private_mismatch');
    if (read.kind === 'pending') {
      assertPutMayProceed('reviewer_put_outcome');
      assertPutCapacityBeforeIntent('reviewer');
      await assertDestination(terminal422Replay);
      await ensureActivationIntent();
      await appendOnce(terminal422Replay ? 'reviewer_put_replay_intent' : 'reviewer_put_intent', m.reviewer);
      operation.journal.assertAppendCapacity(PUT_COMPLETION_AFTER_INTENT_CHECKPOINTS, PUT_COMPLETION_AFTER_INTENT_BYTES);
      const uploaded = await sink.putReviewerArtifact(m.runId, entry.privateBytes, m.reviewer, request());
      await appendPutOutcome('reviewer_put_outcome', outcome(uploaded));
      read = await privateReadback();
      if (read.kind === 'pending') {
        if (uploaded.kind !== 'ok') accepted(uploaded);
        fail('unavailable');
      }
    }
    if (read.kind !== 'ok' || !read.value.bytes.equals(Buffer.from(entry.privateBytes))) {
      if (read.kind !== 'ok') accepted(read);
      fail('private_mismatch');
    }
    await appendOnce('reviewer_verified', m.reviewer);

    // Completion depends on fresh exact readback of every retained server byte,
    // even when the private artifact was already present after a lost local ACK.
    for (const kind of ['report_json', 'report_md'] as const) {
      const bytes = entry.artifacts[kind];
      if (bytes !== undefined && await inspectOrdinary(kind, bytes) !== 'exact') fail('ordinary_mismatch');
    }
    const finalPrivate = await privateReadback();
    if (finalPrivate.kind !== 'ok' || !finalPrivate.value.bytes.equals(Buffer.from(entry.privateBytes))) {
      if (finalPrivate.kind === 'pending') fail('unavailable');
      if (finalPrivate.kind !== 'ok') accepted(finalPrivate);
      fail('private_mismatch');
    }
    await assertDestination();
    await ensureActivationIntent();
    const recoveryAck = this.recoveryAcknowledgement(entry, operation, activationIntent);
    this.assertRecoveryJournalAcknowledgements(operation, recoveryAck);
    await this.assertRecoveryAcknowledgements(entry, recoveryAck);
    await publish(join(entry.directory, 'recovery-acknowledged.json'), recoveryAck);
    await appendOnce('recovery_acknowledged', JSON.parse(recoveryAck));
    await publish(join(entry.directory, 'acknowledged.json'), this.ack(entry));
    await appendOnce('complete', { recovery_ack_sha256: sha256(recoveryAck) });
  }
}
// Ephemeral creation authority is never persisted or reconstructed from a manifest.
const entryWasNew = new WeakSet<Entry>();
