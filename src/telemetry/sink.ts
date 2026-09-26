import { createHash } from 'node:crypto';
import { abortSignalWithTimeout } from './abort-signal.js';
import { claimDescriptorSchema } from '../consensus/claim-identity.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { normalizeUrl, type HarnessCredential } from './credentials.js';
import { scrubText } from './scrub.js';
import type { ArtifactDeclaration, ArtifactKind, RunEnvelope } from './envelope.js';
import type { WireEvent } from './events.js';
import type { RecoveryRequestBudget, RecoveryWritePermit, RecoveryRateLimit } from './recovery-request-budget.js';
import { parseAttestedExpiry, type ReceiptProbe } from './attested-retry.js';

/**
 * The HTTP side of evidence (epic IO-12475, sections 8.4 and 9): POST the
 * envelope, PUT each declared artifact, POST converge events, and GET what
 * Harness holds (a pull request's gate status, one run). Every request
 * normally runs under a 10 s timeout (artifacts have bounded headroom), carries the client handshake the server's
 * version floor reads, and sends the token only to the host that minted it
 * (the credential is a `{url, token}` pair resolved elsewhere).
 *
 * Outcomes are classified for the caller: what the server accepted, what
 * it refused for good (never retried), what is switched off for the org,
 * and what could not be reached (spooled and retried later).
 */

export const REQUEST_TIMEOUT_MS = 10_000;
/** Bounded transfer headroom for supported 25 MB artifacts, not a throughput guarantee. */
export const ARTIFACT_TRANSFER_TIMEOUT_MS = 120_000;
/** A receipt is a few hundred bytes; anything past this is not a Harness answer. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** A read carries a run's findings and calls (up to the bounded evidence envelope) or a gate status; anything past this is not one. */
export const MAX_READ_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface RequestOptions {
  /** Recovery reserves transport capacity before its final source proof. */
  recoveryWritePermit?: RecoveryWritePermit;
  /** A shorter delivery budget, including any capability preflight, e.g. a flush's remaining time. */
  timeoutMs?: number;
  /** The most the response body may hold (default: a receipt's worth). */
  maxResponseBytes?: number;
  /** Recovery reads require HTTP 200 and a complete data/meta envelope, never a partial/error answer. */
  requireCompleteRead?: boolean;
  /** Cancellation/deadline for an attested same-workflow retry operation. */
  signal?: AbortSignal;
}

export interface RunReceipt {
  id: string;
  url: string;
  received_at?: string;
  repo_verified?: boolean;
  head_verified?: string;
  artifacts_expected: string[];
  status: 'created' | 'existing';
}

export interface ArtifactReceipt {
  kind: string;
  sha256: string;
  url?: string;
  status: 'created' | 'existing';
}

export interface EventsReceipt {
  inserted: number;
  duplicates: number;
}

export type SinkOutcome<T> =
  | { kind: 'ok'; value: T; httpStatus: number }
  /** The organization has not enabled review evidence, or caps it at findings. */
  | { kind: 'disabled'; reason: 'reviews_disabled' | 'artifacts_disabled'; message: string }
  /** The run id is already recorded with a different report digest. */
  | { kind: 'conflict'; message: string }
  /** The server understood the request and refused it for good; retrying cannot help. */
  | { kind: 'rejected'; httpStatus: number; error: string; message: string }
  /** Network, timeout or server failure — the delivery is worth retrying. */
  | { kind: 'unavailable'; reason: string; httpStatus?: number; retryAfterMs?: number; rateLimitReason?: RecoveryRateLimit['reason'] };

export type PreparedPostRun =
  | Extract<SinkOutcome<RunReceipt>, { kind: 'rejected' }>
  | { kind: 'ready'; serializedEnvelope: string; post: (options?: RequestOptions) => Promise<SinkOutcome<RunReceipt>>; receipt: (options?: RequestOptions) => Promise<ReceiptProbe<RunReceipt>> };

interface PreparedRunBinding {
  runId: string;
  hasEvidenceProvenance: boolean;
  boundClassification: 'absent' | 'valid' | 'invalid';
  artifactsDeclared: ArtifactDeclaration[];
}

export interface SinkOptions {
  /** Only explicitly selected recovery operations opt into quota scheduling. */
  requestBudget?: RecoveryRequestBudget;
  credential: HarnessCredential;
  rclVersion: string;
  fetchImpl?: typeof fetch;
  /** Explicit caller ceiling, including artifact transfers. */
  timeoutMs?: number;
  /** Known lifetime of a run-bound credential; omitted legacy credentials keep the 10 s cap. */
  attestedExpiresAt?: string;
}

interface ErrorBody {
  error?: string;
  message?: string;
}

const SIGHTING_BINDING_FIELDS = ['version', 'finding_ref', 'report_json_sha256', 'claim_descriptor', 'match_rationale', 'pending_round'];

/** Inspect retained bindings without normalizing or replacing their original values. */
export function validSightingBinding(entry: Record<string, unknown>): boolean {
  const key = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 64;
  return entry.version === 1 && key(entry.identity_key) && key(entry.matched_identity) &&
    ['new', 'repeat', 'suppressed', 'regating'].includes(entry.status as string) &&
    typeof entry.finding_ref === 'string' && Buffer.byteLength(entry.finding_ref, 'utf8') > 0 &&
    Buffer.byteLength(entry.finding_ref, 'utf8') <= 32 &&
    typeof entry.report_json_sha256 === 'string' && /^[a-f0-9]{64}(?![\s\S])/.test(entry.report_json_sha256) &&
    claimDescriptorSchema.safeParse(entry.claim_descriptor).success &&
    ['new_claim', 'exact_descriptor', 'supported_paraphrase', 'ambiguous', 'explicit_split'].includes(entry.match_rationale as string) &&
    (!Object.hasOwn(entry, 'pending_round') || entry.pending_round === null ||
      (typeof entry.pending_round === 'number' && Number.isSafeInteger(entry.pending_round) && entry.pending_round >= 1));
}

function remainingRequestOptions(options: RequestOptions, deadline: number | undefined): RequestOptions | null {
  if (deadline === undefined) return options;
  const timeoutMs = Math.floor(deadline - performance.now());
  return timeoutMs < 1 ? null : { ...options, timeoutMs };
}

export class HarnessSink {
  private readonly credential: HarnessCredential;
  private readonly rclVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly artifactTimeoutMs: number;
  private readonly artifactExpiry?: { epoch: number; remainingMs: number; startedAt: number };
  private readonly requestBudget?: RecoveryRequestBudget;

  constructor(options: SinkOptions) {
    // The token travels to the host that minted it, over TLS (loopback
    // excepted) — re-checked here so no caller can pair it with another URL.
    // A trailing slash is the same origin and is normalized away.
    const url = normalizeUrl(options.credential.url);
    if (url === null) {
      throw new Error(`Harness credential URL is not a deliverable base URL: ${hostOnly(options.credential.url)}`);
    }
    this.credential = { ...options.credential, url };
    this.rclVersion = options.rclVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.artifactTimeoutMs = Math.min(ARTIFACT_TRANSFER_TIMEOUT_MS, options.timeoutMs ?? ARTIFACT_TRANSFER_TIMEOUT_MS);
    if (this.credentialSource === 'attest') {
      if (options.attestedExpiresAt === undefined) {
        this.artifactTimeoutMs = Math.min(this.artifactTimeoutMs, REQUEST_TIMEOUT_MS);
      } else {
        // Use the same accepted timestamp formats and monotonic lifetime rule
        // as envelope recovery. A backwards wall clock cannot extend validity.
        const epoch = parseAttestedExpiry(options.attestedExpiresAt) ?? 0;
        this.artifactExpiry = { epoch, remainingMs: epoch - Date.now(), startedAt: performance.now() };
      }
    }
    this.requestBudget = options.requestBudget;
  }

  get baseUrl(): string {
    return this.credential.url;
  }

  /** Recovery never substitutes an ordinary credential for an attested one. */
  get credentialSource(): HarnessCredential['source'] { return this.credential.token.startsWith('rbc_') ? 'attest' : this.credential.source; }

  /** Exact bounded raw artifact read; never decode/re-encode original evidence. */
  async getArtifact(runId: string, kind: ArtifactKind, limit: number, options: RequestOptions = {}): Promise<SinkOutcome<{ bytes: Buffer; sha256: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 25_000_000) throw new Error('invalid_artifact_read_limit');
    if (kind !== 'report_json' && kind !== 'report_md') return { kind: 'rejected', httpStatus: 0, error: 'unknown_artifact_kind', message: 'Unsupported artifact selection' };
    if (this.artifactBudget(options) <= 0) return { kind: 'unavailable', reason: 'artifact_transfer_expired' };
    let dispose: (() => void) | undefined;
    try {
      const fetched = await this.fetchRequest(`${this.baseUrl}/api/v1/reviews/runs/${encodeURIComponent(runId)}/artifacts/${kind}`, {
        method: 'GET', headers: this.headers('application/octet-stream'), redirect: 'manual',
      }, () => this.artifactBudget(options), undefined, options.signal, this.artifactLifetime(options));
      const { response, rateLimit } = fetched;
      dispose = fetched.dispose;
      if (response.status !== 200) {
        const text = await readBounded(response, MAX_RESPONSE_BYTES);
        let body: unknown = null;
        try { body = JSON.parse(text ?? 'null'); } catch { /* Untrusted failure text is not a receipt. */ }
        return this.classify<{ bytes: Buffer; sha256: string }>({ status: response.type === 'opaqueredirect' ? 302 : response.status, body, ...(rateLimit ? { rateLimit } : {}) }, () => null);
      }
      const bytes = await readBoundedBytes(response, limit);
      const digest = response.headers.get('x-artifact-sha256');
      if (bytes === null || digest === null || !/^[0-9a-f]{64}(?![\s\S])/.test(digest) || createHash('sha256').update(bytes).digest('hex') !== digest) {
        return { kind: 'rejected', httpStatus: 200, error: 'malformed_artifact_response', message: 'Raw artifact bytes do not match their receipt' };
      }
      return { kind: 'ok', httpStatus: 200, value: { bytes, sha256: digest } };
    } catch { return { kind: 'unavailable', reason: 'artifact_read_failed' }; }
    finally { dispose?.(); }
  }

  /** The reservation is scheduling only; callers must still prove source and packet freshness. */
  async reserveRecoveryWrite(): Promise<RecoveryWritePermit | undefined> {
    return this.requestBudget?.reserveWrite();
  }

  releaseRecoveryWrite(permit: RecoveryWritePermit | undefined): void {
    if (permit) this.requestBudget?.releaseWrite(permit);
  }

  private artifactLifetime(options: RequestOptions): number | undefined {
    const expiry = this.artifactExpiry;
    if (!expiry) return options.timeoutMs;
    return Math.min(options.timeoutMs ?? Infinity,
      expiry.epoch - Date.now(), expiry.remainingMs - (performance.now() - expiry.startedAt));
  }

  private artifactBudget(options: RequestOptions): number {
    return Math.min(this.artifactTimeoutMs, this.artifactLifetime(options) ?? this.artifactTimeoutMs);
  }

  private async fetchRequest(
    url: string,
    init: RequestInit,
    timeoutMs: number | (() => number),
    permit?: RecoveryWritePermit,
    parentSignal?: AbortSignal,
    operationTimeoutMs?: number
  ): Promise<{ response: Response; rateLimit?: RecoveryRateLimit; dispose: () => void }> {
    const deadline = operationTimeoutMs === undefined ? undefined : performance.now() + operationTimeoutMs;
    const operation = operationTimeoutMs === undefined ? undefined : abortSignalWithTimeout(parentSignal, operationTimeoutMs);
    const signal = operation?.signal ?? parentSignal;
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (!permit && this.requestBudget) await this.requestBudget.acquire(signal);
        signal?.throwIfAborted();
        // Admission and 429 pacing cannot renew an explicit caller deadline or
        // credential lifetime. The ordinary network timer starts after admission.
        const remaining = Math.min(typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs,
          deadline === undefined ? Infinity : deadline - performance.now());
        if (remaining <= 0) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        const lease = abortSignalWithTimeout(signal, remaining);
        try {
          lease.signal.throwIfAborted();
          if (permit) {
            if (init.method !== 'POST' || !this.requestBudget) throw new Error('recovery_write_permit_invalid');
            this.requestBudget.consumeWrite(permit);
          }
          const response = await this.fetchImpl(url, { ...init, signal: lease.signal });
          // Keep both leases until the caller has consumed the response body too.
          const dispose = (): void => { lease.dispose(); operation?.dispose(); };
          if (response.status !== 429 || !this.requestBudget) return { response, dispose };
          const rateLimit = this.requestBudget.rateLimited(response.headers.get('retry-after'), response.headers.get('date'));
          // Reads may restart after an explicit rejection. Writes remain receipt-driven;
          // neither a 429 nor a lost acknowledgment authorizes a blind POST retry.
          if (init.method !== 'GET' || !rateLimit.retryable) return { response, rateLimit, dispose };
          await response.body?.cancel().catch(() => undefined);
          lease.dispose();
        } catch (error) {
          lease.dispose();
          throw error;
        }
      }
    } catch (error) {
      operation?.dispose();
      throw error;
    }
  }

  private headers(contentType: string): Record<string, string> {
    return {
      authorization: `Bearer ${this.credential.token}`,
      'content-type': contentType,
      accept: 'application/json',
      'x-harness-client': 'rcl',
      'x-harness-client-version': this.rclVersion,
      'user-agent': `rcl/${this.rclVersion} node/${process.versions.node}`,
    };
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: string | undefined,
    contentType: string,
    options: RequestOptions = {},
    timeoutCeilingMs: number | (() => number) = this.timeoutMs
  ): Promise<{ status: number; body: unknown; rateLimit?: RecoveryRateLimit } | { failure: string }> {
    let dispose: (() => void) | undefined;
    try {
      const fetched = await this.fetchRequest(`${this.credential.url}${path}`, {
        method,
        headers: this.headers(contentType),
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
      }, timeoutCeilingMs, options.recoveryWritePermit, options.signal, options.timeoutMs);
      const { response, rateLimit } = fetched;
      dispose = fetched.dispose;
      // Node returns a manual redirect as the 3xx itself; a WHATWG client
      // returns an opaque redirect with status 0. Both read as "redirected".
      if (response.type === 'opaqueredirect') return { status: 302, body: null };
      const text = await readBounded(response, options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
      if (text === null) {
        return { status: response.status, body: { error: 'malformed_response', message: 'response larger than the receipt limit' }, ...(rateLimit ? { rateLimit } : {}) };
      }
      let parsed: unknown = null;
      if (text !== '') {
        try {
          if (options.requireCompleteRead) {
            const decoded = decodeOriginalReport(text, { exactNumbers: true });
            if (decoded.transformations.length) throw new Error('transformed_receipt');
            parsed = decoded.value;
          } else parsed = JSON.parse(text);
        } catch {
          parsed = options.requireCompleteRead
            ? { error: 'malformed_response', message: 'invalid or ambiguous complete read response' }
            : { message: text.slice(0, 200) };
        }
      }
      return { status: response.status, body: parsed, ...(rateLimit ? { rateLimit } : {}) };
    } catch (err) {
      return { failure: transportFailure(err) };
    } finally {
      dispose?.();
    }
  }

  private classify<T>(
    result: { status: number; body: unknown; rateLimit?: RecoveryRateLimit } | { failure: string },
    onOk: (body: unknown, status: number) => T | null
  ): SinkOutcome<T> {
    if ('failure' in result) return { kind: 'unavailable', reason: result.failure };
    const { status, body } = result;
    const error = (body as ErrorBody | null)?.error ?? '';
    const message = (body as ErrorBody | null)?.message ?? '';
    if (status >= 200 && status < 300) {
      if (error === 'malformed_response') return { kind: 'rejected', httpStatus: status, error, message };
      const value = onOk(body, status);
      if (value === null) return { kind: 'rejected', httpStatus: status, error: 'malformed_response', message: 'unexpected response body' };
      return { kind: 'ok', value, httpStatus: status };
    }
    if (status === 403 && (error === 'reviews_disabled' || error === 'artifacts_disabled')) {
      return { kind: 'disabled', reason: error, message };
    }
    if (status === 409) return { kind: 'conflict', message };
    if (status === 429 && result.rateLimit) return {
      kind: 'unavailable', reason: 'HTTP 429', httpStatus: 429, rateLimitReason: result.rateLimit.reason,
      ...(result.rateLimit.retryAfterMs !== undefined ? { retryAfterMs: result.rateLimit.retryAfterMs } : {}),
    };
    if (status >= 500 || status === 429 || status === 408) {
      return { kind: 'unavailable', reason: `HTTP ${status}${message ? ` ${message}` : ''}` };
    }
    // A rejected credential is not a rejected run: after `harness login` (or
    // a fresh CI token) the same entry can still land, so it stays spooled.
    if (status === 401) {
      return { kind: 'unavailable', reason: `HTTP 401 credential rejected${message ? ` (${message})` : ''} - log in again` };
    }
    if (status >= 300 && status < 400) {
      return { kind: 'rejected', httpStatus: status, error: 'redirected', message: 'the server redirected the request — check HARNESS_API_URL / the login host (redirects are not followed with a token)' };
    }
    return { kind: 'rejected', httpStatus: status, error: error || `http_${status}`, message };
  }

  /** Capability is read at the credential's own host; no speculative write. */
  private async requireEvidenceProtocol(options: RequestOptions, boundClassification = false): Promise<SinkOutcome<{ supported: boolean }>> {
    // Old servers silently discard unknown provenance. The attested credential
    // may read model-stats, but may not list runs or use an ordinary login.
    const attested = this.credential.source === 'attest';
    // Capability reads use normal read admission; the reserved slot belongs
    // exclusively to the subsequent POST and must survive a failed preflight.
    const { recoveryWritePermit: _permit, ...readOptions } = options;
    const capability = await this.getJson(
      attested ? '/api/v1/reviews/model-stats' : '/api/v1/reviews/runs?page_size=1',
      (data, meta) => {
        if (attested ? !data || typeof data !== 'object' || !Array.isArray((data as { models?: unknown }).models) : !Array.isArray(data)) return null;
        const version = (meta as { evidence_protocol_version?: unknown } | null)?.evidence_protocol_version;
        const boundVersion = (meta as { bound_classification_protocol?: unknown } | null)?.bound_classification_protocol;
        return { supported: typeof version === 'number' && Number.isInteger(version) && version >= 2 &&
          (!boundClassification || boundVersion === 1) };
      }, readOptions
    );
    if (capability.kind !== 'ok') return capability;
    if (!capability.value.supported) return {
      kind: 'rejected', httpStatus: 0,
      error: boundClassification ? 'unsupported_bound_classification_protocol' : 'unsupported_evidence_protocol',
      message: boundClassification
        ? 'The server has not confirmed evidence protocol 2 and bound classification protocol 1; events were not sent'
        : 'The server has not confirmed evidence protocol version 2; versioned evidence was not sent',
    };
    return capability;
  }

  /** Retain immutable delivery primitives and exact bytes for one POST and any replay. */
  preparePostRun(envelope: RunEnvelope, serializedEnvelope?: string): PreparedPostRun {
    const canonicalEnvelope = JSON.stringify(envelope);
    if (serializedEnvelope !== undefined && serializedEnvelope !== canonicalEnvelope) return {
      kind: 'rejected', httpStatus: 0, error: 'serialized_envelope_mismatch',
      message: 'The supplied serialized envelope does not match the validated envelope',
    };
    const gating = envelope.run.gating;
    const hasBoundClassification = gating !== null && typeof gating === 'object' && 'bound_classification_protocol' in gating;
    const binding: PreparedRunBinding = {
      runId: envelope.run.id,
      hasEvidenceProvenance: envelope.findings.some(finding => finding.location_provenance !== undefined || finding.claim_descriptor !== undefined),
      boundClassification: hasBoundClassification ? (gating.bound_classification_protocol === 1 ? 'valid' : 'invalid') : 'absent',
      artifactsDeclared: structuredClone(envelope.artifacts_declared),
    };
    return { kind: 'ready', serializedEnvelope: canonicalEnvelope,
      post: (options = {}) => this.postPreparedRun(binding, canonicalEnvelope, options),
      receipt: (options = {}) => this.getPreparedReceipt(binding, canonicalEnvelope, options) };
  }

  /** `POST /api/v1/reviews/runs` — idempotent on the run id. */
  async postRun(envelope: RunEnvelope, options: RequestOptions = {}, serializedEnvelope?: string): Promise<SinkOutcome<RunReceipt>> {
    const prepared = this.preparePostRun(envelope, serializedEnvelope);
    return prepared.kind === 'ready' ? prepared.post(options) : prepared;
  }

  private async postPreparedRun(binding: PreparedRunBinding, serializedEnvelope: string, options: RequestOptions): Promise<SinkOutcome<RunReceipt>> {
    const deadline = options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
    const boundClassification = binding.boundClassification === 'valid';
    if (binding.boundClassification === 'invalid') return {
      kind: 'rejected', httpStatus: 0, error: 'invalid_bound_classification',
      message: 'The run must declare bound classification protocol 1; the envelope was not sent',
    };
    if (boundClassification || binding.hasEvidenceProvenance) {
      const remaining = remainingRequestOptions(options, deadline);
      if (remaining === null) return { kind: 'unavailable', reason: 'delivery_deadline_exceeded' };
      const capability = await this.requireEvidenceProtocol(remaining, boundClassification);
      if (capability.kind !== 'ok') return capability;
    }
    const remaining = remainingRequestOptions(options, deadline);
    if (remaining === null) return { kind: 'unavailable', reason: 'delivery_deadline_exceeded' };
    const result = await this.request('POST', '/api/v1/reviews/runs', serializedEnvelope, 'application/json', remaining);
    return this.classify(result, (body, status) => {
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      // A receipt names the run that was posted and says which artifacts the
      // server expects; anything else is not a receipt.
      if (!data || data['id'] !== binding.runId || typeof data['url'] !== 'string') return null;
      if (!Array.isArray(data['artifacts_expected']) || !data['artifacts_expected'].every((k) => typeof k === 'string')) return null;
      const meta = (body as { meta?: { status?: string } }).meta;
      return {
        id: data['id'],
        url: data['url'],
        ...(typeof data['received_at'] === 'string' ? { received_at: data['received_at'] } : {}),
        ...(typeof data['repo_verified'] === 'boolean' ? { repo_verified: data['repo_verified'] } : {}),
        ...(typeof data['head_verified'] === 'string' ? { head_verified: data['head_verified'] } : {}),
        artifacts_expected: data['artifacts_expected'] as string[],
        status: meta?.status === 'existing' || status === 200 ? 'existing' : 'created',
      };
    });
  }

  /**
   * Read the restricted run-bound receipt after an uncertain attested POST.
   * Only a 404 authorizes a replay; unavailable, rejected or malformed answers
   * stop recovery. The server independently restricts this route to the
   * credential's own live run and signed workflow subject.
   */
  async getAttestedRunReceipt(envelope: RunEnvelope, serializedEnvelope: string, options: RequestOptions = {}): Promise<ReceiptProbe<RunReceipt>> {
    const prepared = this.preparePostRun(envelope, serializedEnvelope);
    return prepared.kind === 'ready' ? prepared.receipt(options) : { kind: 'rejected' };
  }

  private async getPreparedReceipt(binding: PreparedRunBinding, serializedEnvelope: string, options: RequestOptions = {}): Promise<ReceiptProbe<RunReceipt>> {
    if (this.credentialSource !== 'attest') return { kind: 'rejected' };
    if (!binding.artifactsDeclared.some(({ kind }) => kind === 'report_json')) return { kind: 'rejected' };
    const result = await this.request('GET', `/api/v1/reviews/runs/${encodeURIComponent(binding.runId)}`, undefined, 'application/json', { ...options, maxResponseBytes: MAX_READ_RESPONSE_BYTES, requireCompleteRead: true });
    if ('failure' in result) return { kind: 'unavailable' };
    if (result.status === 404) return { kind: 'absent' };
    if (result.status >= 500 || result.status === 429 || result.status === 408) return { kind: 'unavailable' };
    if (result.status !== 200 || !completeReadBody(result.body)) return { kind: 'rejected' };
    const response = result.body as { data?: Record<string, unknown>; meta?: Record<string, unknown> } | null;
    const data = response?.data;
    const envelopeSha256 = createHash('sha256').update(serializedEnvelope, 'utf8').digest('hex');
    const receiptUrl = typeof data?.['url'] === 'string' ? data['url'] : undefined;
    const credentialLocation = new URL(this.credential.url);
    const expectedOrigin = credentialLocation.origin;
    const basePath = credentialLocation.pathname.replace(/\/$/, '');
    const expectedPath = `${basePath}/api/v1/reviews/runs/${encodeURIComponent(binding.runId)}`;
    const receiptLocation = receiptUrl === undefined ? undefined : (() => { try { return new URL(receiptUrl); } catch { return undefined; } })();
    if (!data || data['id'] !== binding.runId || receiptLocation?.origin !== expectedOrigin || receiptLocation.pathname !== expectedPath || receiptLocation.search !== '' || receiptLocation.hash !== '' ||
      typeof data['envelope_sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(data['envelope_sha256']) || data['envelope_sha256'] !== envelopeSha256 ||
      response?.meta?.['status'] !== 'existing' || !sameDeclarations(data['artifacts_declared'], binding.artifactsDeclared)) return { kind: 'rejected' };
    return {
      kind: 'recorded',
      value: {
        id: binding.runId,
        url: receiptUrl!,
        ...(typeof data['received_at'] === 'string' ? { received_at: data['received_at'] } : {}),
        ...(typeof data['repo_verified'] === 'boolean' ? { repo_verified: data['repo_verified'] } : {}),
        ...(typeof data['head_verified'] === 'string' ? { head_verified: data['head_verified'] } : {}),
        artifacts_expected: binding.artifactsDeclared.map(({ kind }) => kind),
        status: 'existing',
      },
    };
  }

  /** `PUT /api/v1/reviews/runs/:id/artifacts/:kind` — the raw bytes, never JSON. */
  async putArtifact(
    runId: string,
    kind: ArtifactKind,
    bytes: string,
    options: RequestOptions = {}
  ): Promise<SinkOutcome<ArtifactReceipt>> {
    if (kind !== 'report_json' && kind !== 'report_md') {
      return { kind: 'rejected', httpStatus: 0, error: 'unknown_artifact_kind', message: String(kind) };
    }
    const timeoutMs = this.artifactBudget(options);
    if (timeoutMs <= 0) return { kind: 'unavailable', reason: 'artifact_transfer_expired' };
    const result = await this.request(
      'PUT',
      `/api/v1/reviews/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(kind)}`,
      bytes,
      'application/octet-stream',
      { ...options, timeoutMs: this.artifactLifetime(options) },
      () => this.artifactBudget(options)
    );
    // The receipt must name the artifact that was sent and carry the digest
    // of exactly those bytes; anything else is not a receipt for this upload.
    const digest = createHash('sha256').update(bytes, 'utf8').digest('hex');
    return this.classify(result, (body, status) => {
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      if (!data || data['kind'] !== kind || typeof data['sha256'] !== 'string' || data['sha256'].toLowerCase() !== digest) return null;
      const meta = (body as { meta?: { status?: string } }).meta;
      return {
        kind,
        sha256: data['sha256'],
        ...(typeof data['url'] === 'string' ? { url: data['url'] } : {}),
        status: meta?.status === 'existing' || status === 200 ? 'existing' : 'created',
      };
    });
  }

  /** `POST /api/v1/reviews/converge/events` — idempotent on each event id. */
  async postEvents(events: WireEvent[], options: RequestOptions = {}): Promise<SinkOutcome<EventsReceipt>> {
    const deadline = options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
    // Retained JSON can violate the producer's type. Refuse the batch before
    // inspecting provenance so the outbox preserves it and continues other entries.
    if (events.some(event => event.kind === 'round_processed' &&
      (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)))) {
      return { kind: 'rejected', httpStatus: 0, error: 'invalid_event_payload',
        message: 'round_processed payload must be an object; events were not sent' };
    }
    let boundClassification = false;
    let versionedClassification = false;
    for (const event of events) {
      if (event.kind !== 'round_processed') continue;
      const payload = event.payload;
      const markedClassification = 'classification_version' in payload || 'legacy_pending_identities' in payload;
      if (markedClassification) {
        const pending = payload.legacy_pending_identities;
        if (payload.classification_version !== 1 || typeof payload.report_json_sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(payload.report_json_sha256) ||
          !Number.isSafeInteger(event.round) || event.round! < 1 ||
          !Array.isArray(payload.identities) || !payload.identities.every((identity: unknown) => {
            if (identity === null || typeof identity !== 'object' || Array.isArray(identity) ||
              !Object.hasOwn(identity, 'pending_round')) return false;
            const value = (identity as { pending_round: unknown }).pending_round;
            return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= event.round!);
          }) ||
          ('legacy_pending_identities' in payload && (!Array.isArray(pending) || pending.length === 0 || pending.length > 2000 ||
            !pending.every((identity: unknown, index: number) => typeof identity === 'string' && /^[a-f0-9]{16}$/.test(identity) &&
              (index === 0 || pending[index - 1] < identity))))) {
          return { kind: 'rejected', httpStatus: 0, error: 'invalid_bound_classification',
            message: 'Bound classification requires version 1, a lowercase report digest, pending snapshots and valid optional legacy pending identities; events were not sent' };
        }
        boundClassification = true;
      }
      const markedSightingRefs = new Set<string>();
      if (Array.isArray(payload.identities)) {
        for (const entry of payload.identities) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
            !SIGHTING_BINDING_FIELDS.some(field => Object.hasOwn(entry, field))) continue;
          if (!validSightingBinding(entry)) return {
            kind: 'rejected', httpStatus: 0, error: 'invalid_sighting_binding',
            message: 'Per-sighting bindings require a complete supported version 1 identity; events were not sent',
          };
          if (markedClassification && entry.report_json_sha256 !== payload.report_json_sha256) return {
            kind: 'rejected', httpStatus: 0, error: 'invalid_sighting_binding',
            message: 'Marked per-sighting bindings must use the classification report digest; events were not sent',
          };
          if (markedClassification && markedSightingRefs.has(entry.finding_ref as string)) return {
            kind: 'rejected', httpStatus: 0, error: 'invalid_sighting_binding',
            message: 'Marked per-sighting bindings must use unique finding references; events were not sent',
          };
          if (markedClassification) markedSightingRefs.add(entry.finding_ref as string);
          versionedClassification = true;
        }
      }
    }
    if (boundClassification || versionedClassification) {
      const remaining = remainingRequestOptions(options, deadline);
      if (remaining === null) return { kind: 'unavailable', reason: 'delivery_deadline_exceeded' };
      const capability = await this.requireEvidenceProtocol(remaining, boundClassification);
      if (capability.kind !== 'ok') return capability;
    }
    const body = JSON.stringify({ events });
    const remaining = remainingRequestOptions(options, deadline);
    if (remaining === null) return { kind: 'unavailable', reason: 'delivery_deadline_exceeded' };
    const result = await this.request(
      'POST',
      '/api/v1/reviews/converge/events',
      body,
      'application/json',
      remaining
    );
    return this.classify(result, (body) => {
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      const inserted = data?.['inserted'];
      const duplicates = data?.['duplicates'];
      const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
      // Every event sent must be accounted for, inserted or already known.
      if (!count(inserted) || !count(duplicates) || inserted + duplicates !== events.length) return null;
      return { inserted, duplicates };
    });
  }

  /**
   * `GET <path>` — a read under the same timeout, handshake and host binding
   * as deliveries. `validate` says what the caller asked for: it returns the
   * typed value when `data` is about that thing and `null` otherwise, which
   * is reported as `malformed_response` rather than trusted. Reads allow a
   * larger body than a receipt (`MAX_READ_RESPONSE_BYTES`) unless told otherwise.
   */
  async getJson<T>(path: string, validate: (data: unknown, meta?: unknown) => T | null, options: RequestOptions = {}): Promise<SinkOutcome<T>> {
    const result = await this.request('GET', path, undefined, 'application/json', { maxResponseBytes: MAX_READ_RESPONSE_BYTES, ...options });
    return this.classify(result, (body, status) => {
      if (options.requireCompleteRead && (status !== 200 || !completeReadBody(body))) return null;
      const response = body as { data?: unknown; meta?: unknown } | null;
      return validate(response?.data, response?.meta);
    });
  }
}

function completeReadBody(body: unknown): boolean {
  return body !== null && typeof body === 'object' && !Array.isArray(body) &&
    Object.hasOwn(body, 'data') && Object.hasOwn(body, 'meta') &&
    Object.keys(body).every(key => key === 'data' || key === 'meta');
}

/**
 * The body as text, or `null` once it exceeds `limit` bytes — the stream is
 * cancelled there, so a runaway response never fills memory.
 */
/** The body up to `limit` bytes, or null once it exceeds them — the stream is cancelled, never buffered whole. */
export async function readBounded(response: Response, limit: number): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > limit ? null : text;
  }
  const bytes = await readBoundedBytes(response, limit);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

async function readBoundedBytes(response: Response, limit: number): Promise<Buffer | null> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > limit ? null : bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function hostOnly(raw: string): string {
  try {
    return new URL(raw).host || '(no host)';
  } catch {
    return '(unparseable URL)';
  }
}

/** A transport failure can carry Node's nested `Error.cause`; retain only safe, bounded diagnostics. */
function transportFailure(err: unknown): string {
  const describe = (value: unknown): string => {
    try { return value instanceof Error ? `${value.name}: ${value.message}` : String(value); }
    catch { return '[unstringifiable diagnostic]'; }
  };
  const primary = describe(err);
  const cause = err instanceof Error ? err.cause : undefined;
  return scrubText(cause === undefined ? primary : `${primary}; cause: ${describe(cause)}`, 300);
}

function sameDeclarations(raw: unknown, expected: ArtifactDeclaration[]): boolean {
  if (!Array.isArray(raw) || raw.length !== expected.length) return false;
  const byKind = new Map<string, ArtifactDeclaration>();
  for (const declaration of raw) {
    if (!declaration || typeof declaration !== 'object') return false;
    const value = declaration as Record<string, unknown>;
    if (typeof value['kind'] !== 'string' || typeof value['sha256'] !== 'string' ||
      typeof value['bytes'] !== 'number' || !Number.isSafeInteger(value['bytes']) || value['bytes'] < 0 || byKind.has(value['kind'])) return false;
    byKind.set(value['kind'], { kind: value['kind'] as ArtifactKind, sha256: value['sha256'], bytes: value['bytes'] });
  }
  return expected.every(declaration => {
    const actual = byKind.get(declaration.kind);
    return actual?.sha256 === declaration.sha256 && actual.bytes === declaration.bytes;
  });
}

/** Server or network text made safe for a terminal: scrubbed, control characters removed, bounded. */
function printable(text: string): string {
  return scrubText(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '), 300);
}

/** One phrase for a non-ok outcome, safe to print (no token, no body dump, no control characters). */
export function describeOutcome(outcome: SinkOutcome<unknown>): string {
  switch (outcome.kind) {
    case 'ok':
      return `HTTP ${outcome.httpStatus}`;
    case 'disabled':
      return outcome.reason === 'reviews_disabled'
        ? 'the organization has not enabled review evidence'
        : 'the organization caps review evidence at findings';
    case 'conflict':
      return `conflict: ${outcome.message ? printable(outcome.message) : 'run id already recorded with a different report'}`;
    case 'rejected':
      return `refused (HTTP ${outcome.httpStatus} ${printable(outcome.error)}${outcome.message ? `: ${printable(outcome.message)}` : ''})`;
    case 'unavailable':
      return `unreachable (${printable(outcome.reason)})`;
  }
}
