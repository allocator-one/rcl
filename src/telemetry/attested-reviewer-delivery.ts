import { isDeepStrictEqual } from 'node:util';
import { decodeOriginalLaunch, type OriginalLaunch } from '../dispatch/original-launch.js';
import { decodeRecoveryOperation, type RecoveryOperation } from '../dispatch/recovery-operation.js';
import { decodeCheckpointProof } from '../dispatch/checkpoint.js';
import { isReviewerArtifact, type ReviewerArtifact } from '../report/reviewer-artifact.js';
import { describeReviewerEvidence } from '../report/reviewer-evidence.js';
import { decodeSupplementalAsync } from '../report/supplemental-async.js';
import type { ReviewerRecoveryPreflight } from '../evidence/reviewer-recovery.js';
import { consumeFreshAttestation, snapshotReviewerAttestation, type Attestation } from './attest.js';
import { abortSignalWithTimeout } from './abort-signal.js';
import { ATTESTED_DELIVERY_DEADLINE_MS, ATTESTED_DELIVERY_MAX_ATTEMPTS, parseAttestedExpiry, recoverAttestedDelivery } from './attested-retry.js';
import { assertReviewerRecoveryReference, assertReviewerRecoverySource } from './reviewer-preflight.js';
import { validateRunEnvelope } from './envelope-validation.js';
import { sha256Hex, type ArtifactBytes, type RunEnvelope } from './envelope.js';
import { HarnessSink, type RequestOptions, type RunReceipt, type SinkOutcome } from './sink.js';
import type { HarnessCredential } from './credentials.js';

export interface AttestedReviewerOptions {
  rclVersion: string;
  kind: 'original' | 'successor';
  /** Exact persisted launch/operation binding; a restart never receives a fresh duration. */
  operationBytes: string;
  /** Optional stricter absolute deadline; never extends the persisted operation. */
  deadlineAtMs?: number;
  fetchImpl?: typeof fetch;
}
export interface AttestedReviewerInput { envelope: RunEnvelope; artifacts: ArtifactBytes; artifact: ReviewerArtifact }
export interface AttestedReviewerReceipt {
  runId: string;
  reportJsonVerified: true;
  /** RunBoundScope has no generic artifact GET. Markdown is verified by its PUT digest receipt only. */
  markdown: 'not_declared' | 'put_receipt';
}
function fail(reason: string): never { throw new Error(`attested_reviewer_${reason}`); }
function accepted<T>(outcome: SinkOutcome<T>): T {
  if (outcome.kind !== 'ok') fail(outcome.kind === 'unavailable' ? 'unavailable' : 'refused');
  return outcome.value;
}

/**
 * Transient same-workflow private delivery. The caller reopens exact terminal
 * bytes and the saved operation on restart; no token, outbox or fresh deadline
 * is persisted here. Server authorization remains opaque and independently
 * enforced on every request. This class never allocates native/provider work.
 */
export class AttestedReviewerDelivery {
  private readonly attestation: Attestation;
  private readonly sink: HarnessSink;
  private readonly operation: OriginalLaunch | RecoveryOperation;
  private readonly operationBytes: string;
  private readonly kind: 'original' | 'successor';
  private readonly deadlineAtMs: number;
  private readonly expiry: number;
  private readonly monotonicEnd: number;
  private fresh: boolean;
  private posts = 0;
  private busy = false;
  private envelopeBytes?: string;

  constructor(attestation: Attestation, options: AttestedReviewerOptions) {
    if (attestation.credential.source !== 'attest' || !attestation.credential.token.startsWith('rbc_')) fail('credential');
    this.attestation = structuredClone(attestation);
    this.kind = options.kind;
    this.operationBytes = options.operationBytes;
    if (options.kind !== 'original' && options.kind !== 'successor') fail('operation');
    this.operation = options.kind === 'original' ? decodeOriginalLaunch(options.operationBytes) : decodeRecoveryOperation(options.operationBytes);
    const runId = 'runId' in this.operation ? this.operation.runId : this.operation.successorRunId;
    if (runId !== attestation.runId) fail('run_mismatch');
    if (options.kind === 'original') {
      if (attestation.reviewerRecovery !== undefined) fail('grant_mismatch');
    } else {
      if (!attestation.reviewerRecovery) fail('grant_required');
      this.attestation.reviewerRecovery = snapshotReviewerAttestation(runId, attestation.reviewerRecovery);
      const operation = this.operation as RecoveryOperation, source = this.attestation.reviewerRecovery.source;
      if (source.run_id !== operation.sourceRunId || source.report_sha256 !== operation.sourceReportSha256) fail('grant_mismatch');
    }
    const expiry = parseAttestedExpiry(attestation.expiresAt);
    if (expiry === undefined) fail('invalid_expiry');
    this.expiry = expiry;
    this.deadlineAtMs = options.deadlineAtMs ?? this.operation.expiresAtMs;
    if (!Number.isSafeInteger(this.deadlineAtMs) || this.deadlineAtMs < this.operation.startedAtMs || this.deadlineAtMs > this.operation.expiresAtMs) fail('deadline');
    this.monotonicEnd = performance.now() + Math.min(this.deadlineAtMs, expiry) - Date.now();
    this.sink = new HarnessSink({ credential: this.attestation.credential, rclVersion: options.rclVersion,
      attestedExpiresAt: this.attestation.expiresAt, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    this.fresh = consumeFreshAttestation(attestation);
  }

  /** Match an explicitly injected runtime without disclosing or substituting its credential. */
  matchesRuntime(credential: HarnessCredential, expiresAt: string | undefined): boolean {
    return isDeepStrictEqual(credential, this.attestation.credential) && expiresAt === this.attestation.expiresAt;
  }

  /** Original execution capability check; the caller must invoke it before paid work. */
  async checkOriginal(options: RequestOptions = {}): Promise<void> {
    if (this.kind !== 'original') fail('grant_mismatch');
    await this.within(options, async request => { accepted(await this.sink.checkReviewerRecovery(request())); });
  }

  /** Signed immediate-parent access only; full retained ancestry is validated independently by the server/caller. */
  async preflight(original: ReviewerRecoveryPreflight, options: RequestOptions = {}): Promise<void> {
    const input = structuredClone(original), operation = this.operation;
    if (!('sourceRunId' in operation) || !this.attestation.reviewerRecovery) fail('grant_required');
    const source = this.attestation.reviewerRecovery.source;
    assertReviewerRecoveryReference(input);
    if (input.successorRunId !== this.attestation.runId || input.target !== operation.target ||
      input.source.runId !== source.run_id || input.source.reportSha256 !== source.report_sha256 ||
      input.source.reviewerArtifactSha256 !== source.reviewer_artifact_sha256) fail('grant_mismatch');
    await this.within(options, async request => {
      accepted(await this.sink.checkReviewerRecovery(request()));
      const read = await this.sink.getReviewerArtifact(source.run_id, { sha256: source.reviewer_artifact_sha256 }, request());
      if (read.kind !== 'ok') fail('source_unavailable');
      assertReviewerRecoverySource(input, read.value.bytes);
      const wire = JSON.parse(read.value.bytes.toString('utf8'));
      const parent = wire.checkpoints.at(-1);
      const proof = decodeCheckpointProof(parent.bytes);
      if (parent.runId !== source.run_id || proof.digest !== operation.sourceCheckpointSha256 ||
        proof.plan.digest !== operation.planDigest || sha256Hex(proof.bindings['captured-inputs']!) !== operation.capturedInputsSha256) fail('source_mismatch');
    });
  }

  /** Own-run receipt before every retry; ordinary PUTs precede private admission, with no generic GET. */
  async deliver(input: AttestedReviewerInput, options: RequestOptions = {}): Promise<AttestedReviewerReceipt> {
    const entry = this.snapshot(input);
    if (this.envelopeBytes !== undefined && this.envelopeBytes !== entry.envelopeBytes) fail('immutable_conflict');
    this.envelopeBytes = entry.envelopeBytes;
    if (this.busy) fail('busy');
    this.busy = true;
    try {
      return await this.within(options, async request => {
        accepted(await this.sink.checkReviewerRecovery(request()));
        const prepared = this.sink.preparePostRun(entry.envelope, entry.envelopeBytes);
        if (prepared.kind !== 'ready') fail('envelope');
        const first = this.fresh; this.fresh = false;
        let unknownRun = false;
        const recovered = await recoverAttestedDelivery<RunReceipt>({ runId: this.attestation.runId,
          payload: entry.envelopeBytes, expiresAt: this.attestation.expiresAt, receiptFirst: true,
          initialAttempts: this.posts, maxAttempts: ATTESTED_DELIVERY_MAX_ATTEMPTS,
          deadlineMs: Math.max(1, Math.floor(Math.min(request().timeoutMs!, ATTESTED_DELIVERY_DEADLINE_MS))), signal: request().signal,
          receipt: async (_id, signal) => {
            const outcome = await prepared.receipt({ ...request(), signal });
            if (outcome.kind === 'absent' && !first && this.posts === 0) { unknownRun = true; return { kind: 'rejected' }; }
            return outcome;
          },
          post: async (payload, signal) => {
            if (payload !== entry.envelopeBytes) return { kind: 'rejected' };
            this.posts++;
            const outcome = await prepared.post({ ...request(), signal });
            if (outcome.kind === 'ok') return { kind: 'recorded', value: outcome.value };
            return { kind: outcome.kind === 'conflict' ? 'conflict' : outcome.kind === 'unavailable' ? 'unavailable' : 'rejected' };
          },
        });
        if (recovered.kind !== 'recorded' || !recovered.value) {
          if (unknownRun) fail('unknown_run');
          fail(`envelope_${recovered.kind}`);
        }
        let read = await this.sink.getReviewerArtifact(this.attestation.runId, entry.reference, request());
        if (read.kind !== 'pending' && read.kind !== 'ok') accepted(read);
        if (read.kind === 'ok' && !read.value.bytes.equals(Buffer.from(entry.privateBytes))) fail('private_mismatch');
        for (const kind of ['report_json', 'report_md'] as const) {
          const bytes = entry.artifacts[kind];
          if (bytes !== undefined) accepted(await this.sink.putArtifact(this.attestation.runId, kind, bytes, request()));
        }
        if (read.kind === 'pending') {
          const put = await this.sink.putReviewerArtifact(this.attestation.runId, entry.privateBytes, entry.reference, request());
          if (put.kind !== 'ok' && put.kind !== 'unavailable') accepted(put);
          // An uncertain PUT is never blindly repeated. Read the exact own-run
          // private bytes before any later invocation can consider another write.
          read = await this.sink.getReviewerArtifact(this.attestation.runId, entry.reference, request());
        }
        if (read.kind === 'pending') fail('unavailable');
        if (!accepted(read).bytes.equals(Buffer.from(entry.privateBytes))) fail('private_mismatch');
        return { runId: this.attestation.runId, reportJsonVerified: true,
          markdown: entry.artifacts.report_md === undefined ? 'not_declared' : 'put_receipt' };
      });
    } finally { this.busy = false; }
  }

  private snapshot(input: AttestedReviewerInput) {
    if (!isReviewerArtifact(input.artifact)) fail('artifact');
    const envelopeBytes = JSON.stringify(input.envelope), envelope = JSON.parse(envelopeBytes) as RunEnvelope;
    const artifacts = { ...input.artifacts }, privateBytes = input.artifact.bytes;
    if (validateRunEnvelope(envelope, artifacts).length || envelope.run.id !== this.attestation.runId) fail('envelope');
    const declaration = envelope.reviewer_recovery;
    if (!declaration || declaration.sha256 !== input.artifact.digest || declaration.bytes !== Buffer.byteLength(privateBytes) ||
      !isDeepStrictEqual(declaration.source, this.attestation.reviewerRecovery?.source)) fail('declaration');
    const wire = JSON.parse(privateBytes), last = wire.checkpoints.at(-1), proof = decodeCheckpointProof(last.bytes);
    const descriptor = describeReviewerEvidence(proof, decodeSupplementalAsync(wire.supplementalAsync.bytes));
    if (last.runId !== this.attestation.runId || proof.bindings[this.kind === 'original' ? 'launch' : 'operation'] !== this.operationBytes ||
      !isDeepStrictEqual(descriptor, declaration.descriptor) || wire.report.bytes !== artifacts.report_json ||
      wire.report.sha256 !== sha256Hex(artifacts.report_json)) fail('report_binding');
    return { envelope, envelopeBytes, artifacts, privateBytes, reference: { sha256: declaration.sha256, bytes: declaration.bytes } };
  }

  private remaining(): number {
    const now = Date.now();
    if (now < this.operation.startedAtMs) fail('clock');
    const remaining = Math.min(this.deadlineAtMs - now, this.expiry - now, this.monotonicEnd - performance.now());
    if (remaining <= 0) fail('deadline');
    return remaining;
  }
  private async within<T>(options: RequestOptions, work: (request: () => RequestOptions) => Promise<T>): Promise<T> {
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeout) || timeout <= 0) fail('deadline');
    const duration = Math.min(this.remaining(), timeout, 120_000), end = performance.now() + duration;
    const lease = abortSignalWithTimeout(options.signal, duration);
    const request = () => {
      if (lease.signal.aborted) fail('deadline');
      const remaining = Math.min(this.remaining(), end - performance.now());
      if (remaining <= 0) fail('deadline');
      return { signal: lease.signal, timeoutMs: remaining };
    };
    try { request(); const value = await work(request); request(); return value; }
    finally { lease.dispose(); }
  }
}
