import { describe, expect, it } from 'vitest';
import { HarnessSink, MAX_READ_RESPONSE_BYTES, MAX_RESPONSE_BYTES } from '../../src/telemetry/sink.js';
import { fakeFetch } from '../telemetry/fixtures.js';

const CREDENTIAL = { url: 'https://harness.example.test', token: 'aone_TESTTOKEN0123456789', source: 'login' as const };
const RUN_ID = '01a08032-0838-76db-ade3-1990f6e54072';

function sink(handler: Parameters<typeof fakeFetch>[0]) {
  const { fetch, requests } = fakeFetch(handler);
  return { sink: new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.1.0', fetchImpl: fetch, timeoutMs: 500 }), requests };
}

function minimalRun(extra: Record<string, unknown> = {}) {
  return { id: RUN_ID, target: { kind: 'patch' }, findings: [], calls: [], ...extra };
}

describe('HarnessSink reads', () => {
  it('reads a run body far past the receipt bound but refuses one past the read bound', async () => {
    const padding = 'x'.repeat(MAX_RESPONSE_BYTES * 2);
    const big = await sink(() => ({ status: 200, body: { data: minimalRun({ padding }) } })).sink.getRun(RUN_ID);
    expect(big).toMatchObject({ kind: 'ok', value: { id: RUN_ID } });

    const huge = await sink(() => ({ status: 200, body: { data: minimalRun({ padding: 'x'.repeat(MAX_READ_RESPONSE_BYTES) }) } })).sink.getRun(RUN_ID);
    expect(huge).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it('sends GETs with the client handshake to the credential host and treats a redirect as refused', async () => {
    const { sink: s, requests } = sink(() => ({ status: 302, body: undefined }));
    const outcome = await s.getGateStatus('allocator-one', 'rcl', 42);
    expect(requests[0]!.url).toBe('https://harness.example.test/api/v1/reviews/prs/allocator-one/rcl/42');
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.headers).toMatchObject({ authorization: `Bearer ${CREDENTIAL.token}`, 'x-harness-client': 'rcl' });
    expect(requests[0]!.redirect).toBe('manual');
    expect(outcome).toMatchObject({ kind: 'rejected', error: 'redirected' });
  });

  it('refuses an answer about another pull request or another run', async () => {
    const projection = { status: 'converged', conclusive: true, run_id: null, run_url: null, head_sha: null, actionable: [], rounds: [] };
    const other = await sink(() => ({
      status: 200,
      body: { data: { repo: 'allocator-one/rcl', pr_number: 43, head: null, advisory: projection, enforced: projection, decision: null } },
    })).sink.getGateStatus('allocator-one', 'rcl', 42);
    expect(other).toMatchObject({ kind: 'rejected', error: 'malformed_response' });

    const otherRun = await sink(() => ({ status: 200, body: { data: minimalRun({ id: 'someone-else' }) } })).sink.getRun(RUN_ID);
    expect(otherRun).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it('classifies evidence off, not found and an unreachable host for the caller', async () => {
    expect(await sink(() => ({ status: 403, body: { error: 'reviews_disabled', message: 'off' } })).sink.getRun(RUN_ID)).toMatchObject({ kind: 'disabled' });
    expect(await sink(() => ({ status: 404, body: { error: 'not_found', message: 'no' } })).sink.getRun(RUN_ID)).toMatchObject({ kind: 'rejected', httpStatus: 404 });
    expect(await sink(() => new Error('ECONNREFUSED')).sink.getRun(RUN_ID)).toMatchObject({ kind: 'unavailable' });
  });
});
