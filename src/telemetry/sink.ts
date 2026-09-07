import type { HarnessCredential } from './credentials.js';
import type { ArtifactKind, RunEnvelope } from './envelope.js';
import type { WireEvent } from './events.js';

/**
 * The HTTP side of evidence delivery (epic IO-12475, section 8.4): POST the
 * envelope, PUT each declared artifact, POST converge events. Every request
 * runs under a 10 s timeout, carries the client handshake the server's
 * version floor reads, and sends the token only to the host that minted it
 * (the credential is a `{url, token}` pair resolved elsewhere).
 *
 * Outcomes are classified for the caller: what the server accepted, what
 * it refused for good (never retried), what is switched off for the org,
 * and what could not be reached (spooled and retried later).
 */

export const REQUEST_TIMEOUT_MS = 10_000;

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
    this.credential = options.credential;
    this.rclVersion = options.rclVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  get baseUrl(): string {
    return this.credential.url;
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
    contentType: string
  ): Promise<{ status: number; body: unknown } | { failure: string }> {
    try {
      const response = await this.fetchImpl(`${this.credential.url}${path}`, {
        method,
        headers: this.headers(contentType),
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'manual',
      });
      let parsed: unknown = null;
      const text = await response.text();
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { message: text.slice(0, 200) };
        }
      }
      return { status: response.status, body: parsed };
    } catch (err) {
      return { failure: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
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
      return { kind: 'unavailable', reason: `HTTP 401 credential rejected${message ? ` (${message})` : ''} — log in again and run rcl telemetry flush` };
    }
    if (status >= 300 && status < 400) {
      return { kind: 'rejected', httpStatus: status, error: 'redirected', message: 'the server redirected the request — check HARNESS_API_URL / the login host (redirects are not followed with a token)' };
    }
    return { kind: 'rejected', httpStatus: status, error: error || `http_${status}`, message };
  }

  /** `POST /api/v1/reviews/runs` — idempotent on the run id. */
  async postRun(envelope: RunEnvelope): Promise<SinkOutcome<RunReceipt>> {
    const result = await this.request('POST', '/api/v1/reviews/runs', JSON.stringify(envelope), 'application/json');
    return this.classify(result, (body, status) => {
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      if (!data || typeof data['id'] !== 'string' || typeof data['url'] !== 'string') return null;
      const meta = (body as { meta?: { status?: string } }).meta;
      return {
        id: data['id'],
        url: data['url'],
        ...(typeof data['received_at'] === 'string' ? { received_at: data['received_at'] } : {}),
        ...(typeof data['repo_verified'] === 'boolean' ? { repo_verified: data['repo_verified'] } : {}),
        ...(typeof data['head_verified'] === 'string' ? { head_verified: data['head_verified'] } : {}),
        artifacts_expected: Array.isArray(data['artifacts_expected'])
          ? (data['artifacts_expected'] as unknown[]).filter((k): k is string => typeof k === 'string')
          : [],
        status: meta?.status === 'existing' || status === 200 ? 'existing' : 'created',
      };
    });
  }

  /** `PUT /api/v1/reviews/runs/:id/artifacts/:kind` — the raw bytes, never JSON. */
  async putArtifact(runId: string, kind: ArtifactKind, bytes: string): Promise<SinkOutcome<ArtifactReceipt>> {
    if (kind !== 'report_json' && kind !== 'report_md') {
      return { kind: 'rejected', httpStatus: 0, error: 'unknown_artifact_kind', message: String(kind) };
    }
    const result = await this.request(
      'PUT',
      `/api/v1/reviews/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(kind)}`,
      bytes,
      'application/octet-stream'
    );
    return this.classify(result, (body, status) => {
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      if (!data || typeof data['sha256'] !== 'string') return null;
      const meta = (body as { meta?: { status?: string } }).meta;
      return {
        kind: typeof data['kind'] === 'string' ? data['kind'] : kind,
        sha256: data['sha256'],
        ...(typeof data['url'] === 'string' ? { url: data['url'] } : {}),
        status: meta?.status === 'existing' || status === 200 ? 'existing' : 'created',
      };
    });
  }

  /** `POST /api/v1/reviews/converge/events` — idempotent on each event id. */
  async postEvents(events: WireEvent[]): Promise<SinkOutcome<EventsReceipt>> {
    const result = await this.request(
      'POST',
      '/api/v1/reviews/converge/events',
      JSON.stringify({ events }),
      'application/json'
    );
    return this.classify(result, (body) => {
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      if (!data || typeof data['inserted'] !== 'number') return null;
      return { inserted: data['inserted'], duplicates: typeof data['duplicates'] === 'number' ? data['duplicates'] : 0 };
    });
  }
}

/** One phrase for a non-ok outcome, safe to print (no token, no body dump). */
export function describeOutcome(outcome: SinkOutcome<unknown>): string {
  switch (outcome.kind) {
    case 'ok':
      return `HTTP ${outcome.httpStatus}`;
    case 'disabled':
      return outcome.reason === 'reviews_disabled'
        ? 'the organization has not enabled review evidence'
        : 'the organization caps review evidence at findings';
    case 'conflict':
      return `conflict: ${outcome.message || 'run id already recorded with a different report'}`;
    case 'rejected':
      return `refused (HTTP ${outcome.httpStatus} ${outcome.error}${outcome.message ? `: ${outcome.message}` : ''})`;
    case 'unavailable':
      return `unreachable (${outcome.reason})`;
  }
}
