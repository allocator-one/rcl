import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { describeOutcome, HarnessSink } from '../../src/telemetry/sink.js';
import { fakeFetch, sampleResult } from './fixtures.js';

const CREDENTIAL = { url: 'https://harness.example.test', token: 'aone_TESTTOKEN0123456789', source: 'login' as const };
const ARTIFACTS = { report_json: '{"r":1}', report_md: '# r' };

/** The run id a posted envelope carries, so a fixture can answer with a matching receipt. */
function runIdOf(request: { body?: string }): string {
  return (JSON.parse(request.body ?? '{}') as { run?: { id?: string } }).run?.id ?? 'not-a-run';
}

function sink(handler: Parameters<typeof fakeFetch>[0]) {
  const { fetch, requests } = fakeFetch(handler);
  return { sink: new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.0.0', fetchImpl: fetch, timeoutMs: 500 }), requests };
}

describe('HarnessSink.postRun', () => {
  it('posts the envelope with the client handshake to the credential host and reads the receipt', async () => {
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    const { sink: s, requests } = sink(() => ({
      status: 201,
      body: {
        data: { id: envelope.run.id, url: `https://harness.example.test/api/v1/reviews/runs/${envelope.run.id}`, artifacts_expected: ['report_json', 'report_md'], head_verified: 'current' },
        meta: { status: 'created' },
      },
    }));
    const outcome = await s.postRun(envelope);

    expect(outcome).toMatchObject({ kind: 'ok', httpStatus: 201, value: { id: envelope.run.id, status: 'created', artifacts_expected: ['report_json', 'report_md'], head_verified: 'current' } });
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
    const { sink: s } = sink((request) => ({ status: 200, body: { data: { id: runIdOf(request), url: 'u', artifacts_expected: [] }, meta: { status: 'existing' } } }));
    const outcome = await s.postRun(buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } }));
    expect(outcome).toMatchObject({ kind: 'ok', value: { status: 'existing' } });
  });

  it('refuses a receipt that names another run or forgets which artifacts it expects', async () => {
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    const other = await sink(() => ({ status: 201, body: { data: { id: 'run-1', url: 'u', artifacts_expected: [] } } })).sink.postRun(envelope);
    expect(other).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    const forgetful = await sink(() => ({ status: 201, body: { data: { id: envelope.run.id, url: 'u' } } })).sink.postRun(envelope);
    expect(forgetful).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it('prints server text scrubbed and without control characters', () => {
    const line = describeOutcome({
      kind: 'rejected',
      httpStatus: 422,
      error: 'validation_error',
      message: `Bearer ${'a'.repeat(30)} rejected\u001b[31m boo\r\n`,
    });
    expect(line).not.toContain('aaaa');
    expect(line).not.toMatch(/[\u0000-\u001f]/);
    expect(line).toContain('rejected');
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

  it('keeps a spooled entry alive on 401 and explains a redirect', async () => {
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    const unauthorized = await sink(() => ({ status: 401, body: { error: 'unauthorized', message: 'expired' } })).sink.postRun(envelope);
    expect(unauthorized).toMatchObject({ kind: 'unavailable' });
    expect((unauthorized as { reason: string }).reason).toMatch(/401 credential rejected/);

    const redirected = await sink(() => ({ status: 302 })).sink.postRun(envelope);
    expect(redirected).toMatchObject({ kind: 'rejected', httpStatus: 302, error: 'redirected' });
  });

  it('classifies 5xx, 429 and network failures as unavailable', async () => {
    const envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    expect(await sink(() => ({ status: 503 })).sink.postRun(envelope)).toMatchObject({ kind: 'unavailable' });
    expect(await sink(() => ({ status: 429 })).sink.postRun(envelope)).toMatchObject({ kind: 'unavailable' });
    const down = await sink(() => new TypeError('fetch failed')).sink.postRun(envelope);
    expect(down).toEqual({ kind: 'unavailable', reason: 'TypeError: fetch failed' });
  });

  it('never sends the token anywhere but the credential host, and never follows a redirect with it', async () => {
    const { sink: s, requests } = sink((request) => ({ status: 201, body: { data: { id: runIdOf(request), url: 'u', artifacts_expected: [] } } }));
    await s.postRun(buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } }));
    await s.putArtifact('x', 'report_json', '{}');
    await s.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1 })]);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url.startsWith(`${CREDENTIAL.url}/api/v1/reviews/`)).toBe(true);
      expect(request.headers['authorization']).toBe(`Bearer ${CREDENTIAL.token}`);
      // A 3xx to another host would otherwise carry the header along.
      expect(request.redirect).toBe('manual');
    }
  });

  it('refuses a credential whose URL the token must not travel to, and normalizes a trailing slash', () => {
    const build = (url: string) => () => new HarnessSink({ credential: { url, token: 't', source: 'env' }, rclVersion: '3.0.0' });
    expect(build('http://harness.example.test')).toThrow(/not a deliverable base URL/);
    expect(build('https://user:pw@harness.example.test')).toThrow(/not a deliverable base URL/);
    expect(build('https://harness.example.test/?x=1')).toThrow(/not a deliverable base URL/);
    expect(build('not a url')).toThrow(/not a deliverable base URL/);
    expect(build('https://harness.example.test')).not.toThrow();
    expect(build('http://harness.infraone.localhost:4110')).not.toThrow();
    expect(new HarnessSink({ credential: { url: 'https://harness.example.test/', token: 't', source: 'env' }, rclVersion: '3.0.0' }).baseUrl).toBe(
      'https://harness.example.test'
    );
  });

  it('reads a WHATWG opaque redirect as redirected and refuses an oversized response', async () => {
    const opaque = new HarnessSink({
      credential: CREDENTIAL,
      rclVersion: '3.0.0',
      fetchImpl: (async () => Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' })) as typeof fetch,
    });
    expect(await opaque.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1 })])).toMatchObject({ kind: 'rejected', error: 'redirected' });

    const huge = new HarnessSink({
      credential: CREDENTIAL,
      rclVersion: '3.0.0',
      fetchImpl: (async () => new Response(`{"data":{"inserted":1,"pad":"${'x'.repeat(70_000)}"}}`, { status: 201 })) as typeof fetch,
    });
    const outcome = await huge.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1 })]);
    expect(outcome).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    expect(describeOutcome(outcome)).toContain('receipt limit');
  });

  it('honors a shorter per-request timeout than its own', async () => {
    const { fetch } = fakeFetch(() => 'hang');
    const s = new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.0.0', fetchImpl: fetch, timeoutMs: 60_000 });
    const started = Date.now();
    expect(await s.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1 })], { timeoutMs: 50 })).toMatchObject({ kind: 'unavailable' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives up on a hung request after the timeout and calls it unavailable', async () => {
    const { sink: s } = sink(() => 'hang');
    const outcome = await s.putArtifact('run-1', 'report_md', '# r');
    expect(outcome).toMatchObject({ kind: 'unavailable' });
    expect((outcome as { reason: string }).reason).toMatch(/TimeoutError/);
  });

  it('sends nothing from the environment but the credential it was given (poisoned env)', async () => {
    const poison = {
      ANTHROPIC_API_KEY: 'poison-anthropic-9f8e7d6c',
      OPENAI_API_KEY: 'poison-openai-1a2b3c4d',
      GITHUB_TOKEN: 'poison-github-5e6f7a8b',
      HARNESS_API_TOKEN: 'poison-harness-9c0d1e2f',
    };
    const before = { ...process.env };
    Object.assign(process.env, poison);
    try {
      const { sink: s, requests } = sink((request) => ({ status: 201, body: { data: { id: runIdOf(request), url: 'u', artifacts_expected: [] } } }));
      await s.postRun(buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } }));
      await s.putArtifact('x', 'report_md', '# r');
      await s.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1, payload: { note: 'clean' } })]);
      const wire = JSON.stringify(requests);
      for (const value of Object.values(poison)) expect(wire).not.toContain(value);
      expect(wire).toContain(CREDENTIAL.token);
    } finally {
      for (const key of Object.keys(poison)) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });
});

describe('HarnessSink.putArtifact', () => {
  it('sends the raw bytes as octet-stream and reads the digest back', async () => {
    const digest = createHash('sha256').update('{"r":1}', 'utf8').digest('hex');
    const { sink: s, requests } = sink(() => ({ status: 201, body: { data: { kind: 'report_json', sha256: digest, url: 'u' }, meta: { status: 'created' } } }));
    const outcome = await s.putArtifact('run-1', 'report_json', '{"r":1}');
    expect(outcome).toMatchObject({ kind: 'ok', value: { kind: 'report_json', sha256: digest, status: 'created' } });
    expect(requests[0]).toMatchObject({ method: 'PUT', url: 'https://harness.example.test/api/v1/reviews/runs/run-1/artifacts/report_json', body: '{"r":1}' });
    expect(requests[0]!.headers['content-type']).toBe('application/octet-stream');
  });

  it('never lets a run id reshape the request path', async () => {
    const digest = createHash('sha256').update('#', 'utf8').digest('hex');
    for (const hostile of ['../events', 'a/b', 'a?x=1', 'a#frag', '%2e%2e%2fevents']) {
      const { sink: s, requests } = sink(() => ({ status: 201, body: { data: { kind: 'report_md', sha256: digest } } }));
      await s.putArtifact(hostile, 'report_md', '#');
      const url = new URL(requests[0]!.url);
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
      expect(url.pathname).toBe(`/api/v1/reviews/runs/${encodeURIComponent(hostile)}/artifacts/report_md`);
      expect(url.pathname.split('/')).toHaveLength(8);
    }
  });

  it('refuses a receipt for another kind or another digest', async () => {
    const digest = createHash('sha256').update('#', 'utf8').digest('hex');
    const wrongKind = await sink(() => ({ status: 201, body: { data: { kind: 'report_json', sha256: digest } } })).sink.putArtifact('r', 'report_md', '#');
    expect(wrongKind).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    const wrongDigest = await sink(() => ({ status: 201, body: { data: { kind: 'report_md', sha256: 'f'.repeat(64) } } })).sink.putArtifact('r', 'report_md', '#');
    expect(wrongDigest).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    const upper = await sink(() => ({ status: 200, body: { data: { kind: 'report_md', sha256: digest.toUpperCase() }, meta: { status: 'existing' } } })).sink.putArtifact('r', 'report_md', '#');
    expect(upper).toMatchObject({ kind: 'ok', value: { status: 'existing' } });
  });

  it('reads artifacts_disabled as disabled and a digest mismatch as rejected', async () => {
    expect(await sink(() => ({ status: 403, body: { error: 'artifacts_disabled', message: 'capped' } })).sink.putArtifact('r', 'report_md', '#')).toEqual({ kind: 'disabled', reason: 'artifacts_disabled', message: 'capped' });
    expect(await sink(() => ({ status: 422, body: { error: 'validation_error', message: 'digest' } })).sink.putArtifact('r', 'report_md', '#')).toMatchObject({ kind: 'rejected', httpStatus: 422 });
  });
});

describe('HarnessSink.postEvents', () => {
  it('posts the batch and reads the counts, which must account for every event', async () => {
    const { sink: s, requests } = sink(() => ({ status: 201, body: { data: { inserted: 1, duplicates: 1 } } }));
    const events = [
      buildEvent({ kind: 'attempt_claimed', convergeTarget: 't', attempt: 1, payload: { cap: 20 } }),
      buildEvent({ kind: 'attempt_claimed', convergeTarget: 't', attempt: 2, payload: { cap: 20 } }),
    ];
    expect(await s.postEvents(events)).toMatchObject({ kind: 'ok', value: { inserted: 1, duplicates: 1 } });
    expect(JSON.parse(requests[0]!.body!)).toEqual({ events });

    const short = await sink(() => ({ status: 201, body: { data: { inserted: 1, duplicates: 0 } } })).sink.postEvents(events);
    expect(short).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    const vague = await sink(() => ({ status: 201, body: { data: { inserted: 2 } } })).sink.postEvents(events);
    expect(vague).toMatchObject({ kind: 'rejected', error: 'malformed_response' });

    // Counts are non-negative integers that add up exactly — nothing else reads as a receipt.
    for (const data of [
      { inserted: -1, duplicates: 3 },
      { inserted: 1.5, duplicates: 0.5 },
      { inserted: '2', duplicates: 0 },
      { inserted: null, duplicates: 2 },
      { inserted: 3, duplicates: 0 },
    ]) {
      expect(await sink(() => ({ status: 201, body: { data } })).sink.postEvents(events)).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    }
  });

  it('bounds a body it cannot stream as well', async () => {
    const fake = (async () =>
      ({ type: 'basic', status: 201, body: null, text: async () => `{"pad":"${'x'.repeat(70_000)}"}` }) as unknown as Response) as typeof fetch;
    const s = new HarnessSink({ credential: CREDENTIAL, rclVersion: '3.0.0', fetchImpl: fake });
    expect(await s.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1 })])).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });
});
