import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { isReviewerArtifact, type ReviewerArtifact } from '../report/reviewer-artifact.js';
import { withRecoveryLock, syncDirectory, writeExclusiveBytes } from '../evidence/original-run/journal.js';
import { prepareLockRoot, inspectRecoveryDirectory } from '../evidence/original-run/lock-path.js';
import { platformPath, readStable, sha256 } from './recovery/files.js';
import { normalizeUrl } from './credentials.js';
import type { ArtifactBytes, ArtifactKind, RunEnvelope } from './envelope.js';
import { MAX_ARTIFACT_BYTES, MAX_ENVELOPE_BYTES, validateRunEnvelope } from './envelope-validation.js';
import type { FlushOptions, FlushSummary } from './outbox.js';
import { HarnessSink, type RequestOptions, type SinkOutcome } from './sink.js';

export const REVIEWER_OUTBOX_DIR = 'reviewer-outbox';
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i);
const digest = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/);
const reference = z.object({ sha256: digest, bytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES) }).strict();
const manifestSchema = z.object({ version: z.literal(1), runId: uuid, host: z.string(), credentialKind: z.enum(['login', 'env']),
  envelope: reference, report_json: reference, report_md: reference.optional(), reviewer: reference }).strict();
type Manifest = z.infer<typeof manifestSchema>;
export interface ReviewerDeliveryInput { sink: HarnessSink; envelope: RunEnvelope; artifacts: ArtifactBytes; artifact: ReviewerArtifact }
export interface ReviewerDeliveryOptions { deadlineMs?: number; signal?: AbortSignal }
interface Entry { manifest: Manifest; envelope: RunEnvelope; envelopeBytes: string; artifacts: ArtifactBytes; privateBytes: string; directory: string }
const files = { report_json: 'report.json', report_md: 'report.md' } as const;
const ref = (text: string) => ({ sha256: sha256(text), bytes: Buffer.byteLength(text) });
function fail(reason: string): never { throw new Error(`reviewer_delivery_${reason}`); }
function safeFailure(error: unknown): string {
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
  async deliver(input: ReviewerDeliveryInput, options: ReviewerDeliveryOptions = {}): Promise<void> {
    const entry = this.snapshot(input), request = budget(options);
    await this.lock(entry.manifest.runId, async () => {
      request(); await this.save(entry);
      // An existing manifest might belong to an earlier process/principal.
      // Only this invocation's first publication can use the creation path.
      await this.transfer(await this.load(entry.manifest.runId), input.sink, request, entryWasNew.delete(entry));
    });
  }

  /** Explicit/current-credential retry; no provider calls or changed run identity. */
  async flush(sink: HarnessSink, options: FlushOptions = {}): Promise<FlushSummary> {
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
          if (await this.acknowledged(entry)) return;
          request(); await this.transfer(entry, sink, request, false); summary.delivered.push(entry.manifest.runId);
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

  private snapshot(input: ReviewerDeliveryInput): Entry {
    if (!isReviewerArtifact(input.artifact)) fail('unvalidated_artifact');
    if (input.sink.credentialSource === 'attest') fail('attested_replay_unsupported');
    const envelopeBytes = JSON.stringify(input.envelope), envelope = JSON.parse(envelopeBytes) as RunEnvelope;
    const artifacts = { ...input.artifacts }, privateBytes = input.artifact.bytes;
    const manifest = manifestSchema.parse({ version: 1, runId: envelope.run.id, host: input.sink.baseUrl, credentialKind: input.sink.credentialSource,
      envelope: ref(envelopeBytes), report_json: ref(artifacts.report_json), ...(artifacts.report_md === undefined ? {} : { report_md: ref(artifacts.report_md) }), reviewer: ref(privateBytes) });
    const entry = { manifest, envelope, envelopeBytes, artifacts, privateBytes, directory: join(this.root, manifest.runId.toLowerCase()) };
    validate(entry); return entry;
  }
  private async lock<T>(runId: string, work: () => Promise<T>): Promise<T> {
    return withRecoveryLock(join(this.root, 'locks'), runId.toLowerCase(), work);
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
    await publish(join(entry.directory, 'manifest.json'), JSON.stringify(entry.manifest));
  }
  private async load(id: string): Promise<Entry> {
    const directory = join(this.root, id.toLowerCase()); await inspectRecoveryDirectory(directory, true);
    const manifest = manifestSchema.parse(JSON.parse(await privateRead(join(directory, 'manifest.json'), 4096)));
    if (manifest.runId.toLowerCase() !== id.toLowerCase()) fail('invalid_run');
    const allowed = ['manifest.json', 'envelope.json', 'reviewer-artifact.json', 'report.json', 'acknowledged.json', ...(manifest.report_md ? ['report.md'] : [])];
    if ((await readdir(directory)).some(name => !allowed.includes(name))) fail('unknown_file');
    const envelopeBytes = await privateRead(join(directory, 'envelope.json'), MAX_ENVELOPE_BYTES);
    const entry: Entry = { manifest, directory, envelopeBytes, envelope: JSON.parse(envelopeBytes), privateBytes: await privateRead(join(directory, 'reviewer-artifact.json'), MAX_ARTIFACT_BYTES),
      artifacts: { report_json: await privateRead(join(directory, 'report.json'), MAX_ARTIFACT_BYTES), ...(manifest.report_md ? { report_md: await privateRead(join(directory, 'report.md'), MAX_ARTIFACT_BYTES) } : {}) } };
    validate(entry); return entry;
  }
  private ack(entry: Entry): string { return JSON.stringify({ version: 1, runId: entry.manifest.runId, manifestSha256: sha256(JSON.stringify(entry.manifest)) }); }
  private async acknowledged(entry: Entry): Promise<boolean> {
    try { if (await privateRead(join(entry.directory, 'acknowledged.json'), 4096) !== this.ack(entry)) fail('invalid_ack'); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private async transfer(entry: Entry, sink: HarnessSink, request: () => RequestOptions, initial: boolean): Promise<void> {
    const m = entry.manifest;
    if (sink.baseUrl !== m.host || sink.credentialSource !== m.credentialKind) fail('credential_mismatch');
    accepted(await sink.checkReviewerRecovery(request()));
    let read = initial ? undefined : await sink.getReviewerArtifact(m.runId, m.reviewer, request());
    if (read && read.kind !== 'ok' && read.kind !== 'pending') accepted(read);
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
}
// Ephemeral creation authority is never persisted or reconstructed from a manifest.
const entryWasNew = new WeakSet<Entry>();
