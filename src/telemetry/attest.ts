import { normalizeUrl, type HarnessCredential } from './credentials.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ReviewerRecoverySource } from './envelope.js';
import { parseAttestedExpiry } from './attested-retry.js';
import { scrubText } from './scrub.js';
import { readBounded } from './sink.js';

/**
 * `rcl review --attest` (epic IO-12475, sections 4.1 and 8.5; RCL-40): inside
 * the organization's gate workflow on GitHub Actions, the job's OIDC token —
 * requested from the runner with the Harness origin as audience — is
 * exchanged at `POST /api/v1/reviews/attest` for a run-bound credential:
 * good for one rcl run id, thirty minutes, while the Actions run is in
 * progress. Every request of that run — the envelope, its artifacts, the
 * model keys and the model stats — then travels under it, and the server
 * stamps the run `attested`, the tier the enforced gate reads.
 *
 * Rules this module must never break:
 * - It fails loudly. Outside Actions (the runner sets
 *   `ACTIONS_ID_TOKEN_REQUEST_URL` and `_TOKEN` only for a job that grants
 *   `id-token: write`), without `HARNESS_API_URL`, or when the exchange is
 *   refused, the review does not start. There is no fallback to
 *   `HARNESS_API_TOKEN` or the stored login: a review asked to be attested
 *   is attested or it does not run.
 * - The runner's request token goes to the runner's URL only, the OIDC
 *   token to the Harness origin only, both over TLS; neither is logged.
 * - The credential never outlives the workflow run, so nothing recorded
 *   under it is ever spooled for a later flush.
 * - A review may outlast the credential (thirty minutes): before delivery
 *   it is minted again for the same run id — allowed while the run is not
 *   yet recorded — when little of it remains (`renewAttestation`).
 */

/** One request's bound; the exchange reads GitHub twice (installation, run). */
export const ATTEST_TIMEOUT_MS = 10_000;
/** Retries of the exchange when Harness or GitHub behind it is unavailable. */
export const ATTEST_RETRIES = 2;
const RETRY_PAUSE_MS = 2_000;
/** A credential answer is a few hundred bytes; anything past this is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Renew the credential before delivery when less than this remains of it. */
export const RENEW_BEFORE_MS = 10 * 60_000;

export type AttestErrorCode =
  | 'not_in_actions'
  | 'missing_host'
  | 'oidc_request_failed'
  | 'invalid_attestation'
  | 'attestation_refused'
  | 'run_exists'
  | 'harness_unavailable'
  | 'malformed_response'
  | 'attest_failed';

export class AttestError extends Error {
  readonly code: AttestErrorCode;

  constructor(code: AttestErrorCode, message: string) {
    super(message);
    this.name = 'AttestError';
    this.code = code;
  }
}

export interface AttestOptions {
  /** The rcl run id this review will record — minted before the review, bound by the credential. */
  runId: string;
  rclVersion: string;
  /** Exact immediate parent requested from the server; never an ancestor list or client authority. */
  reviewerRecovery?: ReviewerAttestationRequest;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Injected by tests; the pause between exchange retries. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Attestation {
  /** The run-bound credential (`rbc_…`), its Harness base URL, `source: 'attest'`. */
  credential: HarnessCredential;
  runId: string;
  /** ISO 8601, as the server states it. */
  expiresAt: string;
  /** The OIDC audience requested: the Harness origin. */
  audience: string;
  /** The immutable request binding; the opaque credential carries the server's authorization. */
  reviewerRecovery?: ReviewerAttestationRequest;
}

export interface ReviewerAttestationRequest { readonly version: 1; readonly source: Readonly<ReviewerRecoverySource> }
const reviewerRequestSchema = z.object({ version: z.literal(1), source: z.object({
  run_id: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i),
  report_sha256: z.string().regex(/^[0-9a-f]{64}(?![\s\S])/),
  reviewer_artifact_sha256: z.string().regex(/^[0-9a-f]{64}(?![\s\S])/),
}).strict() }).strict();
const freshAttestations = new WeakMap<Attestation, Attestation>();

/** Validate and snapshot only the exact-parent request, without asserting a signed grant. */
export function snapshotReviewerAttestation(runId: string, value: ReviewerAttestationRequest): ReviewerAttestationRequest {
  const result = reviewerRequestSchema.safeParse(value);
  if (!result.success || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i.test(runId) ||
    result.data.source.run_id.toLowerCase() === runId.toLowerCase()) {
    throw new AttestError('invalid_attestation', 'Invalid reviewer recovery attestation request');
  }
  return Object.freeze({ version: 1, source: Object.freeze(result.data.source) });
}

/** One ephemeral first-delivery permission from an unchanged actual exchange, never restorable from disk. */
export function consumeFreshAttestation(value: Attestation): boolean {
  const original = freshAttestations.get(value);
  freshAttestations.delete(value);
  return original !== undefined && isDeepStrictEqual(value, original);
}

/** What Harness says when it refuses, worded for the workflow log. */
const REFUSAL_HINTS: Record<string, string> = {
  repository_not_installed: 'the Harness GitHub App is not installed on this repository',
  ambiguous_installation: 'more than one Harness organization claims this repository',
  reviews_disabled: 'Review Council evidence is not enabled for the organization',
  wrong_event: 'the gate workflow must run on workflow_dispatch',
  workflow_not_allowed: 'this workflow file is not on the organization allow-list of gate workflows at its default branch',
  run_not_in_progress: 'GitHub does not report this workflow run (attempt) as in progress',
  actions_permission_missing: 'the Harness GitHub App lacks the actions: read permission on this installation',
};

/** Server and runner text, bounded and scrubbed, with this run's own tokens blanked wherever they appear. */
function bounded(text: string, secrets: readonly string[], max = 200): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('[redacted]');
  }
  return scrubText(out, max);
}

interface OidcRequest {
  url: string;
  token: string;
}

/** The runner's token endpoint and request token, present only under `id-token: write`. */
function actionsOidcRequest(env: Record<string, string | undefined>): OidcRequest {
  const url = (env['ACTIONS_ID_TOKEN_REQUEST_URL'] ?? '').trim();
  const token = (env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] ?? '').trim();
  const secure = url !== '' && isHttps(url);
  if (!secure || token === '') {
    throw new AttestError(
      'not_in_actions',
      '--attest needs GitHub Actions with `id-token: write`: ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN are not set (or the URL is not https). Grant the permission in the gate workflow, or run without --attest.'
    );
  }
  return { url, token };
}

function isHttps(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The Harness base URL: `HARNESS_API_URL`, TLS-only. Never the stored login. */
function harnessBase(env: Record<string, string | undefined>): string {
  const raw = (env['HARNESS_API_URL'] ?? '').trim();
  if (raw === '') {
    throw new AttestError(
      'missing_host',
      '--attest needs HARNESS_API_URL (the Harness host the workflow attests to). The OIDC token is the credential — HARNESS_API_TOKEN and the stored login are not used.'
    );
  }
  const url = normalizeUrl(raw);
  if (url === null || !isHttps(url)) {
    throw new AttestError('missing_host', '--attest needs HARNESS_API_URL to be an absolute https URL without user-info, query or fragment.');
  }
  return url;
}

/** The JSON body, read up to the answer limit; an oversized or non-JSON body reads as a `malformed_response` error body. */
async function readJson(response: Response): Promise<unknown> {
  const text = await readBounded(response, MAX_RESPONSE_BYTES);
  if (text === null) return { error: 'malformed_response', message: 'response larger than the answer limit' };
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: 'malformed_response', message: 'response is not JSON' };
  }
}

async function requestOidcToken(request: OidcRequest, audience: string, fetchImpl: typeof fetch): Promise<string> {
  const secrets = [request.token];
  const separator = request.url.includes('?') ? '&' : '?';
  let response: Response;
  try {
    response = await fetchImpl(`${request.url}${separator}audience=${encodeURIComponent(audience)}`, {
      method: 'GET',
      headers: { authorization: `bearer ${request.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS),
      // The request token travels to the runner's URL and nowhere else.
      redirect: 'manual',
    });
  } catch (err) {
    throw new AttestError('oidc_request_failed', `The runner did not answer the OIDC token request: ${bounded(describeError(err), secrets)}`);
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new AttestError('oidc_request_failed', 'The runner redirected the OIDC token request; redirects are not followed with the request token.');
  }
  if (!response.ok) {
    throw new AttestError('oidc_request_failed', `The runner refused the OIDC token request: HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = await readJson(response);
  } catch (err) {
    throw new AttestError('oidc_request_failed', `The runner's OIDC token answer could not be read: ${bounded(describeError(err), secrets)}`);
  }
  const value = (body as { value?: unknown } | null)?.value;
  if (typeof value !== 'string' || value === '') {
    throw new AttestError('oidc_request_failed', 'The runner answered the OIDC token request without a token.');
  }
  return value;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? `no answer within ${ATTEST_TIMEOUT_MS} ms` : err.message;
  return String(err);
}

type ExchangeResult = { credential: string; expiresAt: string } | { retry: string };

async function exchangeOnce(
  base: string,
  oidcToken: string,
  runId: string,
  rclVersion: string,
  fetchImpl: typeof fetch,
  secrets: readonly string[],
  reviewerRecovery?: ReviewerAttestationRequest
): Promise<ExchangeResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/v1/reviews/attest`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${oidcToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-harness-client': 'rcl',
        'x-harness-client-version': rclVersion,
        'user-agent': `rcl/${rclVersion} node/${process.versions.node}`,
      },
      body: JSON.stringify({ run_id: runId, ...(reviewerRecovery === undefined ? {} : { reviewer_recovery: reviewerRecovery }) }),
      signal: AbortSignal.timeout(ATTEST_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (err) {
    return { retry: bounded(describeError(err), secrets) };
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new AttestError(
      'malformed_response',
      'Harness redirected the attest request — check HARNESS_API_URL (redirects are not followed with a token).'
    );
  }
  let body: unknown;
  try {
    body = await readJson(response);
  } catch (err) {
    // The connection went away under the body: as retryable as a failed request.
    return { retry: bounded(describeError(err), secrets) };
  }
  const status = response.status;
  const error = typeof (body as { error?: unknown } | null)?.error === 'string' ? ((body as { error: string }).error as string) : '';
  const reason = typeof (body as { reason?: unknown } | null)?.reason === 'string' ? ((body as { reason: string }).reason as string) : error;
  const message = typeof (body as { message?: unknown } | null)?.message === 'string' ? ((body as { message: string }).message as string) : '';

  if (status >= 200 && status < 300) {
    if (error === 'malformed_response') {
      throw new AttestError('malformed_response', `Harness answered the attest request with ${bounded(message, secrets) || 'an unreadable body'}.`);
    }
    const data = (body as { data?: Record<string, unknown> } | null)?.data;
    const credential = data?.['credential'];
    const expiresAt = data?.['expires_at'];
    if (
      typeof credential !== 'string' ||
      !credential.startsWith('rbc_') ||
      data?.['run_id'] !== runId ||
      typeof expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(expiresAt))
    ) {
      throw new AttestError(
        'malformed_response',
        'Harness answered the attest request without a run-bound credential for this run (or without a readable expiry).'
      );
    }
    return { credential, expiresAt };
  }
  if (status >= 500 || status === 429 || status === 408) {
    return { retry: `HTTP ${status}${message ? ` ${bounded(message, secrets)}` : ''}` };
  }
  const detail = `${bounded(reason, secrets, 60) || `http_${status}`}${message ? `: ${bounded(message, secrets)}` : ''}`;
  const hint = REFUSAL_HINTS[reason];
  const explained = hint ? `${detail} — ${hint}` : detail;
  if (status === 401) throw new AttestError('invalid_attestation', `Harness did not accept the Actions OIDC token (${explained}).`);
  if (status === 403) throw new AttestError('attestation_refused', `Harness refused to attest this workflow run (${explained}).`);
  if (status === 409) {
    throw new AttestError('run_exists', `Harness already holds a run with this id (${explained}); a credential binds a run not yet delivered.`);
  }
  throw new AttestError('attest_failed', `Harness refused the attest request: HTTP ${status} (${explained}).`);
}

/**
 * Request the job's OIDC token for the Harness origin and exchange it for
 * the run-bound credential of `runId`. Throws an `AttestError` — the review
 * must not start — on every failure; an unavailable Harness (or GitHub
 * behind it) is retried a bounded number of times first.
 */
export async function attestRun(options: AttestOptions): Promise<Attestation> {
  const runId = options.runId;
  const reviewerRecovery = options.reviewerRecovery === undefined ? undefined : snapshotReviewerAttestation(runId, options.reviewerRecovery);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const oidc = actionsOidcRequest(env);
  const base = harnessBase(env);
  const audience = new URL(base).origin;

  const oidcToken = await requestOidcToken(oidc, audience, fetchImpl);
  const secrets = [oidc.token, oidcToken];

  let lastRetry = '';
  for (let attempt = 0; attempt <= ATTEST_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_PAUSE_MS);
    const result = await exchangeOnce(base, oidcToken, runId, options.rclVersion, fetchImpl, secrets, reviewerRecovery);
    if ('retry' in result) {
      lastRetry = result.retry;
      continue;
    }
    const attestation: Attestation = {
      credential: { url: base, token: result.credential, source: 'attest' },
      runId,
      expiresAt: result.expiresAt,
      audience,
      ...(reviewerRecovery === undefined ? {} : { reviewerRecovery }),
    };
    freshAttestations.set(attestation, structuredClone(attestation));
    return attestation;
  }
  throw new AttestError(
    'harness_unavailable',
    `Harness could not attest this run after ${1 + ATTEST_RETRIES} attempts (${lastRetry}). The workflow may retry; nothing was recorded.`
  );
}

export interface RenewOptions extends Omit<AttestOptions, 'runId'> {
  /** Injected by tests: the clock the remaining lifetime is measured against. */
  now?: () => number;
}

export interface Renewal {
  attestation: Attestation;
  renewed: boolean;
  /** Why a renewal that was due did not happen; the credential in hand is kept. */
  failure?: string;
}

/**
 * The credential to deliver with: the one in hand while more than
 * `RENEW_BEFORE_MS` of it remains, else a fresh one for the same run id (the
 * server mints again for a run not yet recorded). A failed renewal keeps the
 * credential in hand — the delivery then reports what the server says.
 */
export async function renewAttestation(current: Attestation, options: RenewOptions): Promise<Renewal> {
  const now = (options.now ?? Date.now)();
  // `expiresAt` was checked to parse at mint; a value that does not is treated as spent.
  const expires = Date.parse(current.expiresAt);
  if (Number.isFinite(expires) && expires - now > RENEW_BEFORE_MS) return { attestation: current, renewed: false };
  try {
    const fresh = await attestRun({ ...options, runId: current.runId, reviewerRecovery: current.reviewerRecovery });
    return { attestation: fresh, renewed: true };
  } catch (err) {
    return { attestation: current, renewed: false, failure: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Decode a bounded internal transfer, never new mint authority. The resulting
 * unbranded session requires scoped server preflight/own-run readback; it cannot
 * create an unknown run on restart or authorize a new deadline.
 */
export function parseTransferredAttestation(bytes: string, runId: string, expectedSource?: ReviewerAttestationRequest): Attestation {
  const fail = (): never => { throw new AttestError('invalid_attestation',
    'A valid still-live session for this exact retained run is required; preserve the artifacts and do not relaunch reviewers.'); };
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 65_536) return fail();
  let parsed: unknown; try { parsed = JSON.parse(bytes); } catch { return fail(); }
  const result = z.object({
    credential: z.object({ url: z.string(), token: z.string().min(5).max(8192).regex(/^rbc_[^\s\x00-\x1f\x7f]+$/), source: z.literal('attest') }).strict(),
    runId: z.string(), expiresAt: z.string(), audience: z.string(), reviewerRecovery: reviewerRequestSchema.optional(),
  }).strict().safeParse(parsed);
  if (!result.success) return fail();
  const session = result.data, url = normalizeUrl(session.credential.url), expiry = parseAttestedExpiry(session.expiresAt);
  if (!url || url !== session.credential.url || new URL(url).origin !== session.audience ||
    session.runId !== runId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/i.test(runId) ||
    expiry === undefined || expiry <= Date.now() || !isDeepStrictEqual(session.reviewerRecovery, expectedSource)) return fail();
  if (session.reviewerRecovery) snapshotReviewerAttestation(runId, session.reviewerRecovery);
  return session;
}
