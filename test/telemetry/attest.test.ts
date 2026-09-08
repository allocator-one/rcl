import { describe, expect, it } from 'vitest';
import { ATTEST_RETRIES, AttestError, attestRun } from '../../src/telemetry/attest.js';
import { fakeFetch, type RecordedRequest } from './fixtures.js';

const RUN_ID = '019921a0-0000-7000-8000-000000000042';
const OIDC_URL = 'https://pipelines.actions.githubusercontent.com/token?api-version=2.0';
const ACTIONS = {
  ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token-SECRET',
};
const HOST = { HARNESS_API_URL: 'https://harness.example.test/' };
const MINTED = {
  status: 201,
  body: { data: { credential: 'rbc_minted', token_type: 'bearer', expires_at: '2026-09-08T20:00:00Z', run_id: RUN_ID } },
};

type Answer = { status: number; body?: unknown } | Error | 'hang';

function server(overrides: { oidc?: (r: RecordedRequest) => Answer; attest?: (r: RecordedRequest) => Answer } = {}) {
  return (request: RecordedRequest): Answer => {
    if (request.url.startsWith('https://pipelines.actions.githubusercontent.com/token')) {
      return (overrides.oidc ?? (() => ({ status: 200, body: { value: 'oidc.jwt.SECRET' } })))(request);
    }
    if (request.url === 'https://harness.example.test/api/v1/reviews/attest') {
      return (overrides.attest ?? (() => MINTED))(request);
    }
    return { status: 404, body: { error: 'not_found' } };
  };
}

async function attest(env: Record<string, string | undefined>, handler: (r: RecordedRequest) => Answer) {
  const { fetch, requests } = fakeFetch(handler);
  const outcome = await attestRun({ runId: RUN_ID, rclVersion: '3.2.0', env, fetchImpl: fetch, sleep: async () => {} }).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error })
  );
  return { ...outcome, requests };
}

function attestRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((r) => r.url.endsWith('/api/v1/reviews/attest'));
}

describe('rcl review --attest', () => {
  it('exchanges the job OIDC token, requested with the Harness origin as audience, for a run-bound credential', async () => {
    const { result, requests } = await attest({ ...ACTIONS, ...HOST }, server());

    expect(requests).toHaveLength(2);
    const [oidc, exchange] = requests as [RecordedRequest, RecordedRequest];
    expect(oidc.method).toBe('GET');
    expect(oidc.url).toBe(`${OIDC_URL}&audience=${encodeURIComponent('https://harness.example.test')}`);
    expect(oidc.headers['authorization']).toBe('bearer runner-request-token-SECRET');
    expect(exchange.method).toBe('POST');
    expect(exchange.headers['authorization']).toBe('Bearer oidc.jwt.SECRET');
    expect(exchange.headers['x-harness-client']).toBe('rcl');
    expect(exchange.headers['x-harness-client-version']).toBe('3.2.0');
    expect(exchange.redirect).toBe('manual');
    expect(JSON.parse(exchange.body!)).toEqual({ run_id: RUN_ID });

    expect(result).toEqual({
      credential: { url: 'https://harness.example.test', token: 'rbc_minted', source: 'attest' },
      runId: RUN_ID,
      expiresAt: '2026-09-08T20:00:00Z',
      audience: 'https://harness.example.test',
    });
  });

  it('refuses to run outside GitHub Actions — or without id-token: write — before any request', async () => {
    for (const env of [
      { ...HOST },
      { ...HOST, ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_URL },
      { ...HOST, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-request-token-SECRET' },
    ]) {
      const { error, requests } = await attest(env, server());
      expect(error).toBeInstanceOf(AttestError);
      expect((error as AttestError).code).toBe('not_in_actions');
      expect((error as Error).message).toMatch(/GitHub Actions/);
      expect((error as Error).message).toMatch(/id-token: write/);
      expect(requests).toHaveLength(0);
    }
  });

  it('needs HARNESS_API_URL over TLS and never uses HARNESS_API_TOKEN or the stored login in its place', async () => {
    const missing = await attest({ ...ACTIONS, HARNESS_API_TOKEN: 'aone_ci_token' }, server());
    expect((missing.error as AttestError).code).toBe('missing_host');
    expect((missing.error as Error).message).toMatch(/HARNESS_API_URL/);
    expect(missing.requests).toHaveLength(0);

    const plain = await attest({ ...ACTIONS, HARNESS_API_URL: 'http://harness.example.test' }, server());
    expect((plain.error as AttestError).code).toBe('missing_host');
    expect(plain.requests).toHaveLength(0);

    const runnerUrl = await attest({ ...ACTIONS, ...HOST, ACTIONS_ID_TOKEN_REQUEST_URL: 'http://runner.local/token' }, server());
    expect((runnerUrl.error as AttestError).code).toBe('not_in_actions');
    expect(runnerUrl.requests).toHaveLength(0);
  });

  it('a refused exchange fails loudly with the server reason and never falls back to another credential', async () => {
    const refusals: Array<[number, string, string, string]> = [
      [403, 'attestation_refused', 'workflow_not_allowed', 'attestation_refused'],
      [401, 'invalid_attestation', 'wrong_audience', 'invalid_attestation'],
      [409, 'run_exists', 'run_exists', 'run_exists'],
    ];
    for (const [status, error, reason, code] of refusals) {
      const { error: thrown, requests } = await attest(
        { ...ACTIONS, ...HOST, HARNESS_API_TOKEN: 'aone_ci_token' },
        server({ attest: () => ({ status, body: { error, reason, message: 'The workflow run may not record review evidence here' } }) })
      );
      expect(thrown).toBeInstanceOf(AttestError);
      expect((thrown as AttestError).code).toBe(code);
      expect((thrown as Error).message).toContain(reason);
      expect((thrown as Error).message).toContain('The workflow run may not record review evidence here');
      // One exchange, no retry, no other request with any other credential.
      expect(requests).toHaveLength(2);
    }
  });

  it('retries a Harness or GitHub outage at the exchange a bounded number of times, then gives up', async () => {
    const down = await attest(
      { ...ACTIONS, ...HOST },
      server({ attest: () => ({ status: 503, body: { error: 'github_unavailable', message: 'GitHub could not be read; retry' } }) })
    );
    expect((down.error as AttestError).code).toBe('harness_unavailable');
    expect((down.error as Error).message).toMatch(/503/);
    expect(attestRequests(down.requests)).toHaveLength(1 + ATTEST_RETRIES);

    let calls = 0;
    const recovered = await attest(
      { ...ACTIONS, ...HOST },
      server({
        attest: () => {
          calls += 1;
          return calls === 1 ? new Error('ECONNRESET') : MINTED;
        },
      })
    );
    expect(recovered.result?.credential.token).toBe('rbc_minted');
    expect(attestRequests(recovered.requests)).toHaveLength(2);
  });

  it('an OIDC endpoint that fails or answers without a token is an error before anything reaches Harness', async () => {
    const failing = await attest({ ...ACTIONS, ...HOST }, server({ oidc: () => ({ status: 500, body: { message: 'runner error' } }) }));
    expect((failing.error as AttestError).code).toBe('oidc_request_failed');
    expect(failing.requests).toHaveLength(1);

    const empty = await attest({ ...ACTIONS, ...HOST }, server({ oidc: () => ({ status: 200, body: { count: 1 } }) }));
    expect((empty.error as AttestError).code).toBe('oidc_request_failed');
    expect(empty.requests).toHaveLength(1);
  });

  it('refuses a credential answer that is not the run-bound credential for this run', async () => {
    for (const data of [
      { credential: 'aone_personal', token_type: 'bearer', expires_at: '2026-09-08T20:00:00Z', run_id: RUN_ID },
      { credential: 'rbc_minted', token_type: 'bearer', expires_at: '2026-09-08T20:00:00Z', run_id: '019921a0-0000-7000-8000-000000000099' },
      { credential: 'rbc_minted' },
    ]) {
      const { error } = await attest({ ...ACTIONS, ...HOST }, server({ attest: () => ({ status: 201, body: { data } }) }));
      expect((error as AttestError).code).toBe('malformed_response');
    }
    const redirected = await attest({ ...ACTIONS, ...HOST }, server({ attest: () => ({ status: 302 }) }));
    expect((redirected.error as AttestError).code).toBe('malformed_response');
    expect((redirected.error as Error).message).toMatch(/redirect/);
  });

  it('never puts the runner token or the OIDC token into a message', async () => {
    const oidcDown = await attest({ ...ACTIONS, ...HOST }, server({ oidc: () => ({ status: 500, body: { message: 'runner-request-token-SECRET' } }) }));
    expect((oidcDown.error as Error).message).not.toContain('SECRET');

    const refused = await attest(
      { ...ACTIONS, ...HOST },
      server({ attest: () => ({ status: 401, body: { error: 'invalid_attestation', reason: 'invalid_token', message: 'token oidc.jwt.SECRET refused' } }) })
    );
    expect((refused.error as Error).message).not.toContain('SECRET');
  });
});
