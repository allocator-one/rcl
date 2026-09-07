import { describe, expect, it } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { describeOutcome, HarnessSink } from '../../src/telemetry/sink.js';
import { fakeFetch, sampleResult } from './fixtures.js';

const CREDENTIAL = { url: 'https://harness.example.test', token: 'aone_TESTTOKEN0123456789', source: 'login' as const };
const ARTIFACTS = { report_json: '{"r":1}', report_md: '# r' };

function sink(handler: Parameters<typeof fakeFetch>[0]) {
  const { fetch, requests } = fakeFetch(handler);
  return { sink: new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.0.0', fetchImpl: fetch, timeoutMs: 500 }), requests };
}

describe('HarnessSink.postRun', () => {
  it('posts the envelope with the client handshake to the credential host and reads the receipt', async () => {
    const { sink: s, requests } = sink(() => ({
      status: 201,
      body: {
        data: { id: 'run-1', url: 'https://harness.example.test/api/v1/reviews/runs/run-1', artifacts_expected: ['report_json', 'report_md'], head_verified: 'current' },
        meta: { status: 'created' },
      },
    }));
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    const outcome = await s.postRun(envelope);

    expect(outcome).toMatchObject({ kind: 'ok', httpStatus: 201, value: { id: 'run-1', status: 'created', artifacts_expected: ['report_json', 'report_md'], head_verified: 'current' } });
    const [request] = requests;
    expect(request!.url).toBe('https://harness.example.test/api/v1/reviews/runs');
    expect(request!.method).toBe('POST');
    expect(request!.headers).toMatchObject({
      authorization: `Bearer ${CREDENTIAL.token}`,
      'content-type': 'application/json',
      'x-harness-client': 'rcl',
      'x-harness-client-version': '3.0.0',
    });
    expect(request!.headers['user-agent']).toMatch(/^rcl\/3\.0\.0 /);
    expect(JSON.parse(request!.body!)).toMatchObject({ run: { id: envelope.run.id }, delivery: { mode: 'direct' } });
  });

  it('reads an idempotent 200 as existing', async () => {
    const { sink: s } = sink(() => ({ status: 200, body: { data: { id: 'run-1', url: 'u', artifacts_expected: [] }, meta: { status: 'existing' } } }));
    const outcome = await s.postRun(buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } }));
    expect(outcome).toMatchObject({ kind: 'ok', value: { status: 'existing' } });
  });

  it('classifies 409 as conflict, 403 reviews_disabled as disabled, 422 as rejected', async () => {
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    const conflict = await sink(() => ({ status: 409, body: { error: 'conflict', message: 'different digest' } })).sink.postRun(envelope);
    expect(conflict).toEqual({ kind: 'conflict', message: 'different digest' });

    const disabled = await sink(() => ({ status: 403, body: { error: 'reviews_disabled', message: 'off' } })).sink.postRun(envelope);
    expect(disabled).toEqual({ kind: 'disabled', reason: 'reviews_disabled', message: 'off' });

    const rejected = await sink(() => ({ status: 422, body: { error: 'validation_error', message: 'run.id must be a UUID' } })).sink.postRun(envelope);
    expect(rejected).toMatchObject({ kind: 'rejected', httpStatus: 422, error: 'validation_error' });
    expect(describeOutcome(rejected)).toContain('run.id must be a UUID');

    const forbidden = await sink(() => ({ status: 403, body: { error: 'forbidden', message: 'reviews:write' } })).sink.postRun(envelope);
    expect(forbidden).toMatchObject({ kind: 'rejected', httpStatus: 403 });
  });

  it('classifies 5xx, 429 and network failures as unavailable', async () => {
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    expect(await sink(() => ({ status: 503 })).sink.postRun(envelope)).toMatchObject({ kind: 'unavailable' });
    expect(await sink(() => ({ status: 429 })).sink.postRun(envelope)).toMatchObject({ kind: 'unavailable' });
    const down = await sink(() => new TypeError('fetch failed')).sink.postRun(envelope);
    expect(down).toEqual({ kind: 'unavailable', reason: 'TypeError: fetch failed' });
  });

  it('never sends the token anywhere but the credential host', async () => {
    const { sink: s, requests } = sink(() => ({ status: 201, body: { data: { id: 'x', url: 'u', artifacts_expected: [] } } }));
    await s.postRun(buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } }));
    await s.putArtifact('x', 'report_json', '{}');
    await s.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1 })]);
    for (const request of requests) expect(request.url.startsWith(`${CREDENTIAL.url}/api/v1/reviews/`)).toBe(true);
  });
});

describe('HarnessSink.putArtifact', () => {
  it('sends the raw bytes as octet-stream and reads the digest back', async () => {
    const { sink: s, requests } = sink(() => ({ status: 201, body: { data: { kind: 'report_json', sha256: 'abc', url: 'u' }, meta: { status: 'created' } } }));
    const outcome = await s.putArtifact('run-1', 'report_json', '{"r":1}');
    expect(outcome).toMatchObject({ kind: 'ok', value: { kind: 'report_json', sha256: 'abc', status: 'created' } });
    expect(requests[0]).toMatchObject({ method: 'PUT', url: 'https://harness.example.test/api/v1/reviews/runs/run-1/artifacts/report_json', body: '{"r":1}' });
    expect(requests[0]!.headers['content-type']).toBe('application/octet-stream');
  });

  it('reads artifacts_disabled as disabled and a digest mismatch as rejected', async () => {
    expect(await sink(() => ({ status: 403, body: { error: 'artifacts_disabled', message: 'capped' } })).sink.putArtifact('r', 'report_md', '#')).toEqual({ kind: 'disabled', reason: 'artifacts_disabled', message: 'capped' });
    expect(await sink(() => ({ status: 422, body: { error: 'validation_error', message: 'digest' } })).sink.putArtifact('r', 'report_md', '#')).toMatchObject({ kind: 'rejected', httpStatus: 422 });
  });
});

describe('HarnessSink.postEvents', () => {
  it('posts the batch and reads the counts', async () => {
    const { sink: s, requests } = sink(() => ({ status: 201, body: { data: { inserted: 1, duplicates: 1 } } }));
    const events = [buildEvent({ kind: 'attempt_claimed', convergeTarget: 't', attempt: 1, payload: { cap: 20 } })];
    expect(await s.postEvents(events)).toMatchObject({ kind: 'ok', value: { inserted: 1, duplicates: 1 } });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ events });
  });
});
