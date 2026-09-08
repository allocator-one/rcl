import { normalizeUrl, type HarnessCredential } from './credentials.js';
import { scrubText } from './scrub.js';

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
 */

/** One request's bound; the exchange reads GitHub twice (installation, run). */
export const ATTEST_TIMEOUT_MS = 10_000;
/** Retries of the exchange when Harness or GitHub behind it is unavailable. */
export const ATTEST_RETRIES = 2;
const RETRY_PAUSE_MS = 2_000;
/** A credential answer is a few hundred bytes; anything past this is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;

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

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) return { error: 'malformed_response', message: 'response larger than the answer limit' };
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
    });
  } catch (err) {
    throw new AttestError('oidc_request_failed', `The runner did not answer the OIDC token request: ${bounded(describeError(err), secrets)}`);
  }
  if (!response.ok) {
    throw new AttestError('oidc_request_failed', `The runner refused the OIDC token request: HTTP ${response.status}.`);
  }
  const body = await readJson(response);
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
  secrets: readonly string[]
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
      body: JSON.stringify({ run_id: runId }),
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
  const body = await readJson(response);
  const status = response.status;
  const error = typeof (body as { error?: unknown } | null)?.error === 'string' ? ((body as { error: string }).error as string) : '';
  const reason = typeof (body as { reason?: unknown } | null)?.reason === 'string' ? ((body as { reason: string }).reason as string) : error;
  const message = typeof (body as { message?: unknown } | null)?.message === 'string' ? ((body as { message: string }).message as string) : '';

  if (status >= 200 && status < 300) {
    const data = (body as { data?: Record<string, unknown> } | null)?.data;
    const credential = data?.['credential'];
    const expiresAt = data?.['expires_at'];
    if (
      typeof credential !== 'string' ||
      !credential.startsWith('rbc_') ||
      data?.['run_id'] !== runId ||
      typeof expiresAt !== 'string'
    ) {
      throw new AttestError('malformed_response', 'Harness answered the attest request without a run-bound credential for this run.');
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
    const result = await exchangeOnce(base, oidcToken, options.runId, options.rclVersion, fetchImpl, secrets);
    if ('retry' in result) {
      lastRetry = result.retry;
      continue;
    }
    return {
      credential: { url: base, token: result.credential, source: 'attest' },
      runId: options.runId,
      expiresAt: result.expiresAt,
      audience,
    };
  }
  throw new AttestError(
    'harness_unavailable',
    `Harness could not attest this run after ${1 + ATTEST_RETRIES} attempts (${lastRetry}). The workflow may retry; nothing was recorded.`
  );
}
