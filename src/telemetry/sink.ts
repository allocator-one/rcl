import { createHash } from 'node:crypto';
import { abortSignalWithTimeout } from './abort-signal.js';
import { normalizeUrl, type HarnessCredential } from './credentials.js';
import { scrubText } from './scrub.js';
import type { ArtifactDeclaration, ArtifactKind, RunEnvelope } from './envelope.js';
import type { ReceiptProbe } from './attested-retry.js';
import type { WireEvent } from './events.js';

/**
 * The HTTP side of evidence (epic IO-12475, sections 8.4 and 9): POST the
 * envelope, PUT each declared artifact, POST converge events, and GET what
 * Harness holds (a pull request's gate status, one run). Every request
 * runs under a 10 s timeout, carries the client handshake the server's
 * version floor reads, and sends the token only to the host that minted it
 * (the credential is a `{url, token}` pair resolved elsewhere).
 *
 * Outcomes are classified for the caller: what the server accepted, what
 * it refused for good (never retried), what is switched off for the org,
 * and what could not be reached (spooled and retried later).
 */

export const REQUEST_TIMEOUT_MS = 10_000;
/** A receipt is a few hundred bytes; anything past this is not a Harness answer. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** A read carries a run's findings and calls (a 2 MB envelope's worth at most) or a gate status; anything past this is not one. */
export const MAX_READ_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface RequestOptions {
  /** A shorter timeout for this one request, e.g. what remains of a flush deadline. */
  timeoutMs?: number;
  /** The most the response body may hold (default: a receipt's worth). */
  maxResponseBytes?: number;
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
  | { kind: 'unavailable'; reason: string };

export interface SinkOptions {
  credential: HarnessCredential;
  rclVersion: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ErrorBody {
  error?: string;
  message?: string;
}

export class HarnessSink {
  private readonly credential: HarnessCredential;
  private readonly rclVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

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
  }

  get baseUrl(): string {
    return this.credential.url;
  }

  /** Recovery never substitutes an ordinary credential for an attested one. */
  get credentialSource(): HarnessCredential['source'] { return this.credential.token.startsWith('rbc_') ? 'attest' : this.credential.source; }

  /** Exact bounded raw artifact read; never decode/re-encode original evidence. */
  async getArtifact(runId: string, kind: ArtifactKind, limit: number): Promise<SinkOutcome<{ bytes: Buffer; sha256: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 25_000_000) throw new Error('invalid_artifact_read_limit');
    if (kind !== 'report_json' && kind !== 'report_md') return { kind: 'rejected', httpStatus: 0, error: 'unknown_artifact_kind', message: 'Unsupported artifact selection' };
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/v1/reviews/runs/${encodeURIComponent(runId)}/artifacts/${kind}`, {
        method: 'GET', headers: this.headers('application/octet-stream'), redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) {
        const text = await readBounded(response, MAX_RESPONSE_BYTES);
        let body: unknown = null;
        try { body = JSON.parse(text ?? 'null'); } catch { /* Untrusted failure text is not a receipt. */ }
        return this.classify<{ bytes: Buffer; sha256: string }>({ status: response.type === 'opaqueredirect' ? 302 : response.status, body }, () => null);
      }
      const bytes = await readBoundedBytes(response, limit);
      const digest = response.headers.get('x-artifact-sha256');
      if (bytes === null || digest === null || !/^[0-9a-f]{64}(?![\s\S])/.test(digest) || createHash('sha256').update(bytes).digest('hex') !== digest) {
        return { kind: 'rejected', httpStatus: 200, error: 'malformed_artifact_response', message: 'Raw artifact bytes do not match their receipt' };
      }
      return { kind: 'ok', httpStatus: 200, value: { bytes, sha256: digest } };
    } catch { return { kind: 'unavailable', reason: 'artifact_read_failed' }; }
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
    options: RequestOptions = {}
  ): Promise<{ status: number; body: unknown } | { failure: string }> {
    const timeoutMs = Math.max(1, Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs));
    const signal = abortSignalWithTimeout(options.signal, timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.credential.url}${path}`, {
        method,
        headers: this.headers(contentType),
        ...(body !== undefined ? { body } : {}),
        signal: signal.signal,
        redirect: 'manual',
      });
      // Node returns a manual redirect as the 3xx itself; a WHATWG client
      // returns an opaque redirect with status 0. Both read as "redirected".
      if (response.type === 'opaqueredirect') return { status: 302, body: null };
      const text = await readBounded(response, options.maxResponseBytes ?? MAX_RESPONSE_BYTES);
      if (text === null) {
        return { status: response.status, body: { error: 'malformed_response', message: 'response larger than the receipt limit' } };
      }
      let parsed: unknown = null;
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { message: text.slice(0, 200) };
        }
      }
      return { status: response.status, body: parsed };
    } catch (err) {
      return { failure: transportFailure(err) };
    } finally {
      signal.dispose();
    }
  }

  private classify<T>(
    result: { status: number; body: unknown } | { failure: string },
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

  /** `POST /api/v1/reviews/runs` — idempotent on the run id. */
  async postRun(envelope: RunEnvelope, options: RequestOptions = {}, serializedEnvelope = JSON.stringify(envelope)): Promise<SinkOutcome<RunReceipt>> {
    if (envelope.findings.some((finding) => finding.location_provenance !== undefined)) {
      // Old servers silently discard unknown provenance. The attested credential
      // may read model-stats, but may not list runs or use an ordinary login.
      const attested = this.credential.source === 'attest';
      const capability = await this.getJson(
        attested ? '/api/v1/reviews/model-stats' : '/api/v1/reviews/runs?page_size=1',
        (data, meta) => {
          if (attested ? !data || typeof data !== 'object' || !Array.isArray((data as { models?: unknown }).models) : !Array.isArray(data)) return null;
          const version = (meta as { evidence_protocol_version?: unknown } | null)?.evidence_protocol_version;
          return { supported: typeof version === 'number' && Number.isInteger(version) && version >= 2 };
        }, options
      );
      if (capability.kind !== 'ok') return capability;
      if (!capability.value.supported) return {
        kind: 'rejected', httpStatus: 0, error: 'unsupported_evidence_protocol',
        message: 'The server has not confirmed evidence protocol version 2; normalization provenance was not sent',
      };
    }
    const result = await this.request('POST', '/api/v1/reviews/runs', serializedEnvelope, 'application/json', options);
    return this.classify(result, (body, status) => {
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      // A receipt names the run that was posted and says which artifacts the
      // server expects; anything else is not a receipt.
      if (!data || data['id'] !== envelope.run.id || typeof data['url'] !== 'string') return null;
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
  async getAttestedRunReceipt(envelope: RunEnvelope, options: RequestOptions = {}): Promise<ReceiptProbe<RunReceipt>> {
    if (this.credentialSource !== 'attest') return { kind: 'rejected' };
    if (!envelope.artifacts_declared.some(({ kind }) => kind === 'report_json')) return { kind: 'rejected' };
    const result = await this.request('GET', `/api/v1/reviews/runs/${encodeURIComponent(envelope.run.id)}`, undefined, 'application/json', options);
    if ('failure' in result) return { kind: 'unavailable' };
    if (result.status === 404) return { kind: 'absent' };
    if (result.status >= 500 || result.status === 429 || result.status === 408) return { kind: 'unavailable' };
    if (result.status !== 200) return { kind: 'rejected' };
    const response = result.body as { data?: Record<string, unknown>; meta?: Record<string, unknown> } | null;
    const data = response?.data;
    if (!data || data['id'] !== envelope.run.id || typeof data['url'] !== 'string' ||
      response?.meta?.['status'] !== 'existing' || !sameDeclarations(data['artifacts_declared'], envelope.artifacts_declared)) return { kind: 'rejected' };
    return {
      kind: 'recorded',
      value: {
        id: envelope.run.id,
        url: data['url'],
        ...(typeof data['received_at'] === 'string' ? { received_at: data['received_at'] } : {}),
        ...(typeof data['repo_verified'] === 'boolean' ? { repo_verified: data['repo_verified'] } : {}),
        ...(typeof data['head_verified'] === 'string' ? { head_verified: data['head_verified'] } : {}),
        artifacts_expected: envelope.artifacts_declared.map(({ kind }) => kind),
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
    const result = await this.request(
      'PUT',
      `/api/v1/reviews/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(kind)}`,
      bytes,
      'application/octet-stream',
      options
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
    const result = await this.request(
      'POST',
      '/api/v1/reviews/converge/events',
      JSON.stringify({ events }),
      'application/json',
      options
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
    return this.classify(result, (body) => {
      const response = body as { data?: unknown; meta?: unknown } | null;
      return validate(response?.data, response?.meta);
    });
  }
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
  const describe = (value: unknown): string => value instanceof Error ? `${value.name}: ${value.message}` : String(value);
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
