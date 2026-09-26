import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HarnessSink } from '../../src/telemetry/sink.js';

const id = '00000000-0000-4000-8000-000000000105';
const bytes = '{"private":"synthetic capture only"}';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const expected = { sha256: sha(bytes), bytes: Buffer.byteLength(bytes) };
const capability = { data: { models: [] }, meta: { reviewer_recovery_protocol: 1, reviewer_artifact_schema: 1, reviewer_artifact_max_bytes: 25_000_000 } };
const rawHeaders = { 'content-type': 'application/octet-stream', 'x-artifact-sha256': expected.sha256,
  'cache-control': 'private, no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' };
function client(handler: (url: string, options: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: any, options: any) => {
    calls.push({ url: String(url), options });
    return String(url).endsWith('/model-stats') ? Response.json(capability) : handler(String(url), options);
  }) as typeof fetch;
  const sink = new HarnessSink({ credential: { url: 'https://harness.example.test', token: 'synthetic-login', source: 'login' }, rclVersion: 'test', fetchImpl });
  return { sink: sink as any, calls };
}
const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

describe('private reviewer artifact transport', () => {
  it('checks the actual credential capability and transfers raw exact bytes only through the private route', async () => {
    const { sink, calls } = client((_url, options) => options.method === 'PUT'
      ? Response.json({ data: { run_id: id, ...expected }, meta: { status: 'created' } }, { status: 201 })
      : new Response(bytes, { headers: rawHeaders }));
    expect(await sink.putReviewerArtifact(id, bytes, expected)).toEqual({ kind: 'ok', httpStatus: 201, value: { runId: id, ...expected, status: 'created' } });
    const read = await sink.getReviewerArtifact(id, expected);
    expect(read).toMatchObject({ kind: 'ok', value: { sha256: expected.sha256 } });
    expect(read.value.bytes.equals(Buffer.from(bytes))).toBe(true);
    expect(calls.map(call => call.url)).toEqual([
      'https://harness.example.test/api/v1/reviews/model-stats', `https://harness.example.test/api/v1/reviews/runs/${id}/reviewer-artifact`,
      'https://harness.example.test/api/v1/reviews/model-stats', `https://harness.example.test/api/v1/reviews/runs/${id}/reviewer-artifact`,
    ]);
    expect(calls[1]!.options).toMatchObject({ body: bytes, redirect: 'manual', headers: { authorization: 'Bearer synthetic-login', 'content-type': 'application/octet-stream' } });
    expect(read.value).not.toHaveProperty('url');
  });

  it('only recognizes owner-checked pending with the exact immutable declaration', async () => {
    for (const body of [
      { error: 'not_found' },
      { error: 'reviewer_artifact_pending' },
      { error: 'reviewer_artifact_pending', data: { run_id: id, ...expected, sha256: '0'.repeat(64) } },
    ]) {
      const { sink } = client(() => Response.json(body, { status: 404 }));
      expect((await sink.getReviewerArtifact(id, expected)).kind).toBe('rejected');
    }
    const { sink } = client(() => Response.json({ error: 'reviewer_artifact_pending', message: 'Pending.', data: { run_id: id, ...expected } }, { status: 404 }));
    expect(await sink.getReviewerArtifact(id, expected)).toEqual({ kind: 'pending', runId: id, ...expected });
  });

  it('fails closed on unsupported capability before any private request', async () => {
    for (const meta of [{}, { ...capability.meta, reviewer_artifact_max_bytes: 24_999_999 }, { ...capability.meta, reviewer_recovery_protocol: 2 }]) {
      const fetchImpl = vi.fn(async () => Response.json({ data: { models: [] }, meta }));
      const sink = new HarnessSink({ credential: { url: 'https://harness.example.test', token: 'synthetic', source: 'login' }, rclVersion: 'test', fetchImpl }) as any;
      expect(await sink.putReviewerArtifact(id, bytes, expected)).toMatchObject({ kind: 'rejected', error: 'unsupported_reviewer_recovery' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('enforces exact 25M limits and digest before network and rejects mismatched read receipts', async () => {
    const large = 'x'.repeat(25_000_000), binding = { sha256: sha(large), bytes: Buffer.byteLength(large) };
    const { sink, calls } = client(() => Response.json({ data: { run_id: id, ...binding }, meta: { status: 'existing' } }));
    expect((await sink.putReviewerArtifact(id, large, binding)).kind).toBe('ok');
    const count = calls.length;
    expect((await sink.putReviewerArtifact(id, large + 'x', { sha256: sha(large + 'x'), bytes: 25_000_001 })).kind).toBe('rejected');
    expect((await sink.putReviewerArtifact(id, bytes, { ...expected, sha256: '0'.repeat(64) })).kind).toBe('rejected');
    expect(calls).toHaveLength(count);
    const bad = client(() => new Response(bytes + 'x', { headers: rawHeaders }));
    expect((await bad.sink.getReviewerArtifact(id, expected)).kind).toBe('rejected');
  });

  it('never echoes private server text or follows redirects and refuses receipt URLs', async () => {
    const secret = 'SYNTHETIC_PRIVATE_PROMPT';
    for (const response of [
      () => Response.json({ error: secret, message: secret }, { status: 503 }),
      () => new Response(secret, { status: 302, headers: { location: 'https://other.invalid/private' } }),
      () => Response.json({ data: { run_id: id, ...expected, url: secret }, meta: { status: 'created' } }, { status: 201 }),
    ]) {
      const { sink, calls } = client(response);
      const result = await sink.putReviewerArtifact(id, bytes, expected);
      expect(result.kind).not.toBe('ok'); expect(JSON.stringify(result)).not.toContain(secret);
      expect(calls).toHaveLength(2);
    }
  });

  it('honors caller cancellation while using the private route against real local HTTP', async () => {
    let artifactRequests = 0;
    const server = createServer((request, response) => {
      if (request.url?.endsWith('/model-stats')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(capability)); }
      else { artifactRequests++; request.resume(); }
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const sink = new HarnessSink({ credential: { url: `http://127.0.0.1:${port}`, token: 'synthetic', source: 'login' }, rclVersion: 'test' }) as any;
    const controller = new AbortController();
    const result = sink.putReviewerArtifact(id, bytes, expected, { signal: controller.signal });
    await vi.waitFor(() => expect(artifactRequests).toBe(1)); controller.abort();
    expect((await result).kind).toBe('unavailable');
  });
  it('rejects a public-cache response', async () => {
    const publicRead = client(() => new Response(bytes, { headers: { ...rawHeaders, 'cache-control': 'public, no-store' } }));
    expect((await publicRead.sink.getReviewerArtifact(id, expected)).kind).toBe('rejected');
  });

  it('bounds capability plus transfer by one caller deadline', async () => {
    const server = createServer((request, response) => {
      request.resume();
      setTimeout(() => {
        response.setHeader('content-type', 'application/json');
        response.statusCode = request.url?.endsWith('/model-stats') ? 200 : 201;
        response.end(JSON.stringify(request.url?.endsWith('/model-stats') ? capability : { data: { run_id: id, ...expected }, meta: { status: 'created' } }));
      }, 75);
    }); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const sink = new HarnessSink({ credential: { url: `http://127.0.0.1:${(server.address() as any).port}`, token: 'synthetic', source: 'login' }, rclVersion: 'test' });
    expect((await sink.putReviewerArtifact(id, bytes, expected, { timeoutMs: 110 })).kind).toBe('unavailable');
  });

  it('does not extend expired attestation or an explicit shorter artifact ceiling', async () => {
    const fetchImpl = vi.fn(async () => Response.json(capability));
    const expired = new HarnessSink({ credential: { url: 'https://harness.example.test', token: 'rbc_synthetic', source: 'attest' }, rclVersion: 'test', attestedExpiresAt: '2020-01-01T00:00:00.000Z', fetchImpl });
    expect((await expired.putReviewerArtifact(id, bytes, expected)).kind).toBe('unavailable');
    expect((await expired.getReviewerArtifact(id, expected)).kind).toBe('unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    const { sink, calls } = client(() => new Response(bytes, { headers: rawHeaders }));
    expect((await sink.getReviewerArtifact(id, expected, { signal: controller.signal })).kind).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

});
