import { readTextFixture } from '../support/text-fixture.js';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, realpath, rm, readdir, stat, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { ReviewerDeliveryQueue } from '../../src/telemetry/reviewer-delivery.js';
import { createReviewerRecoveryPreflight } from '../../src/telemetry/reviewer-preflight.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { inspectReviewerArtifact, serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { buildRunEnvelope, declareReviewerRecovery } from '../../src/telemetry/envelope.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { deliverRun, flushOutbox, createTelemetryRuntime } from '../../src/telemetry/deliver.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const rows = JSON.parse(readTextFixture(new URL('../fixtures/reviewer-artifact-lineage.json', import.meta.url))).rows;
  const entry = inspectReviewerArtifact(rows[0].artifact_bytes, rows[0].expectations);
  const result = JSON.parse(entry.reportBytes); result.run.reviewer_evidence = entry.descriptor;
  const artifacts = { report_json: JSON.stringify(result), report_md: '# Synthetic review' };
  const artifact = serializeReviewerArtifact({ assembly: entry.assembly, reportBytes: artifacts.report_json, representation: entry.representation });
  const declaration = declareReviewerRecovery({ artifact, descriptor: entry.descriptor });
  const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-private-delivery-'))); roots.push(root);
  return { root, entry, result, artifacts, artifact, envelope, runId: result.run.id as string };
}
function server(f: Awaited<ReturnType<typeof fixture>>) {
  const requests: Array<{ method: string; url: string; body?: string; token: string }> = [];
  let privateBytes: string | undefined; let posted = false; let lostAck = false; let refused = false; let capability = true; let requireReports = false;
  const generic = new Map<string, string>();
  const fetchImpl = async (url: any, options: any): Promise<Response> => {
    const route = String(url); requests.push({ method: options.method, url: route, body: options.body, token: options.headers.authorization });
    if (route.endsWith('/model-stats')) return Response.json({ data: { models: [] }, meta: capability ? { reviewer_recovery_protocol: 1, reviewer_artifact_schema: 1, reviewer_artifact_max_bytes: 25000000 } : {} });
    if (refused) return Response.json({ error: 'forbidden', message: 'SYNTHETIC_PRIVATE_DETAIL' }, { status: 403 });
    if (route.endsWith('/reviewer-artifact')) {
      if (options.method === 'PUT') { if (requireReports && (generic.get('report_json') !== f.artifacts.report_json || generic.get('report_md') !== f.artifacts.report_md)) return Response.json({ error: 'source_unavailable' }, { status: 503 }); privateBytes = options.body; if (lostAck) throw new Error('lost ACK'); return Response.json({ data: { run_id: f.runId, sha256: f.artifact.digest, bytes: Buffer.byteLength(privateBytes!) }, meta: { status: 'created' } }, { status: 201 }); }
      if (privateBytes === undefined) return Response.json(posted ? { error: 'reviewer_artifact_pending', data: { run_id: f.runId, sha256: f.artifact.digest, bytes: Buffer.byteLength(f.artifact.bytes) } } : { error: 'not_found' }, { status: 404 });
      return new Response(privateBytes, { headers: { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256(privateBytes), 'cache-control': 'private, no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' } });
    }
    if (route.endsWith('/runs')) { posted = true; return Response.json({ data: { id: f.runId, url: 'https://harness.example.test/run', artifacts_expected: ['report_json', 'report_md'] }, meta: { status: 'existing' } }); }
    const kind = route.split('/').at(-1)!;
    if (options.method === 'PUT') { generic.set(kind, options.body); return Response.json({ data: { kind, sha256: sha256(options.body) } }, { status: 201 }); }
    return new Response(generic.get(kind), { headers: { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256(generic.get(kind) ?? '') } });
  };
  const sink = (token = 'first-login', source: 'login' | 'env' = 'login') => new HarnessSink({ credential: { url: 'https://harness.example.test', token, source }, rclVersion: 'test', fetchImpl });
  return { requests, sink, fetchImpl, requireReports: () => { requireReports = true; }, loseAck: () => { lostAck = true; }, refuse: () => { refused = true; }, unsupported: () => { capability = false; }, posted: () => { posted = true; } };
}

describe('private immutable reviewer delivery', () => {
  it('persists privately before network and recovers lost PUT ACK with renewed login and no duplicate private PUT', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    remote.requireReports(); remote.loseAck();
    await expect(queue.deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact })).rejects.toThrow('reviewer_delivery_unavailable');
    const before = remote.requests.length;
    const fresh = new ReviewerDeliveryQueue(f.root);
    expect(await fresh.flush(remote.sink('renewed-login'))).toMatchObject({ delivered: [f.runId], remaining: [] });
    const replay = remote.requests.slice(before);
    expect(replay[0]!.url).toMatch(/model-stats$/);
    expect(replay.find(row => !row.url.endsWith('/model-stats'))).toMatchObject({ method: 'GET', url: expect.stringContaining('/reviewer-artifact') });
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
    expect(remote.requests.filter(row => row.url.endsWith('/runs')).map(row => row.body)).toEqual([JSON.stringify(f.envelope), JSON.stringify(f.envelope)]);
    expect(replay.every(row => row.token === 'Bearer renewed-login')).toBe(true);
    const directory = join(f.root, 'reviewer-outbox', f.runId.toLowerCase());
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(directory)) { const path = join(directory, name); expect((await stat(path)).mode & 0o777).toBe(0o600); const text = await readFile(path, 'utf8'); expect(text).not.toContain('first-login'); expect(text).not.toContain('renewed-login'); }
    expect(await readFile(join(directory, 'reviewer-artifact.json'), 'utf8')).toBe(f.artifact.bytes);
    expect(await fresh.flush(remote.sink())).toMatchObject({ delivered: [], remaining: [] });
  });

  it('never sends stored private bytes for a changed owner/token, unsupported capability, unknown run or corrupt disk', async () => {
    for (const scenario of ['owner', 'capability', 'unknown', 'corrupt'] as const) {
      const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
      await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
      if (scenario === 'owner') remote.refuse();
      if (scenario === 'capability') remote.unsupported();
      if (scenario === 'corrupt') await writeFile(join(f.root, 'reviewer-outbox', f.runId.toLowerCase(), 'reviewer-artifact.json'), 'corrupt');
      const result = await queue.flush(remote.sink('different-login'));
      expect(result.delivered).toEqual([]); expect(result.remaining).toEqual([f.runId]);
      expect(remote.requests.some(row => row.method !== 'GET')).toBe(false);
      expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_DETAIL');
    }
  });

  it('preserves immutable payload conflicts and binds host/credential kind without token-string identity', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    await expect(queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: { ...f.artifacts, report_md: 'changed' }, artifact: f.artifact })).rejects.toThrow();
    expect((await queue.flush(remote.sink('API-token', 'env'))).delivered).toEqual([]);
    expect(remote.requests).toHaveLength(0);
    await expect(queue.deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: structuredClone(f.artifact) })).rejects.toThrow();
    expect(remote.requests).toHaveLength(0);
  });

  it('integrates the coordinator without placing private bytes into generic outbox/artifact routes', async () => {
    const f = await fixture(), remote = server(f); remote.loseAck();
    const lines: string[] = [];
    const checkedFetch = async (url: any, options: any) => { expect(lines.join('\n')).toContain('captured prompts and raw reviewer results'); return remote.fetchImpl(url, options); };
    const runtime = await createTelemetryRuntime({ rclVersion: 'test', config: {}, dataDir: f.root, env: {}, credential: { url: 'https://harness.example.test', token: 'first-login', source: 'login' }, fetchImpl: checkedFetch, stderr: line => { lines.push(line); } });
    expect(await deliverRun(runtime, { result: f.result, artifacts: f.artifacts, reviewerArtifact: f.artifact, evidenceRequired: true })).toMatchObject({ status: 'spooled', spooled: true, exitCode: 4 });
    expect(await readdir(join(f.root, 'outbox')).catch(() => [])).toEqual([]);
    expect(await flushOutbox(runtime)).toMatchObject({ delivered: [f.runId] });
    expect(lines.join('\n')).not.toContain('first-login');
    expect(lines.join('\n')).not.toContain(f.artifact.bytes);
    expect(remote.requests.filter(row => row.method === 'PUT' && row.body === f.artifact.bytes).every(row => row.url.endsWith('/reviewer-artifact'))).toBe(true);
  });

  it('checks real credential capability and immediate source before recovery work, treating pending as unavailable source', async () => {
    const f = await fixture(), remote = server(f); const request = { target: f.entry.proof.plan.target, headSha: f.entry.proof.plan.headSha, successorRunId: '00000000-0000-4000-8000-000000000999', source: { runId: f.runId, reportSha256: sha256(f.artifacts.report_json), reviewerArtifactSha256: f.artifact.digest }, lineage: [{ runId: f.runId, reportSha256: sha256(f.artifacts.report_json), reviewerArtifactSha256: f.artifact.digest }] };
    const preflight = createReviewerRecoveryPreflight(remote.sink());
    await expect(preflight(request)).rejects.toThrow('reviewer_recovery_source_unavailable');
    remote.posted();
    await expect(preflight(request)).rejects.toThrow('reviewer_recovery_source_unavailable');
    await new ReviewerDeliveryQueue(f.root).deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    await expect(preflight(request)).resolves.toBeUndefined();
    remote.unsupported();
    await expect(preflight(request)).rejects.toThrow('reviewer_recovery_capability_unavailable');
  });
  it('reopens lost-ACK delivery in a fresh process over actual loopback HTTP with the same immutable files', async () => {
    const f = await fixture(), remote = server(f); remote.requireReports(); remote.loseAck();
    const http = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      try {
        const answer = await remote.fetchImpl(`http://localhost${request.url}`, { method: request.method, body: Buffer.concat(chunks).toString('utf8'), headers: request.headers });
        response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(Buffer.from(await answer.arrayBuffer()));
      } catch { response.destroy(); }
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(http.address() as any).port}`;
      const sink = new HarnessSink({ credential: { url, source: 'login', token: 'first-login' }, rclVersion: 'test' });
      await expect(new ReviewerDeliveryQueue(f.root).deliver({ sink, envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact })).rejects.toThrow('reviewer_delivery_unavailable');
      const script = `import {ReviewerDeliveryQueue} from './src/telemetry/reviewer-delivery.ts'; import {HarnessSink} from './src/telemetry/sink.ts';
        const sink = new HarnessSink({credential:{url:process.argv[1],source:'login',token:'renewed-login'},rclVersion:'test'});
        console.log(JSON.stringify(await new ReviewerDeliveryQueue(process.argv[2]).flush(sink)));`;
      const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, url, f.root], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 15000,
        env: Object.fromEntries(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
      });
      expect(child.stderr).not.toContain('SYNTHETIC_PRIVATE'); expect(JSON.parse(child.stdout)).toMatchObject({ delivered: [f.runId], remaining: [] });
      expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
      expect(remote.requests.some(row => row.url.includes('provider'))).toBe(false);
    } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
  });

  it('serializes concurrent replay and refuses replacement API tokens through current server ownership', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    remote.loseAck(); await expect(queue.deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact })).rejects.toThrow();
    const replies = await Promise.all([queue.flush(remote.sink()), new ReviewerDeliveryQueue(f.root).flush(remote.sink('renewed-login'))]);
    expect(replies.flatMap(reply => reply.delivered)).toEqual([f.runId]);
    expect(remote.requests.filter(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'))).toHaveLength(1);
    const next = await fixture(), api = server(next), apiQueue = new ReviewerDeliveryQueue(next.root);
    await apiQueue.retain({ sink: api.sink('original-api', 'env'), envelope: next.envelope, artifacts: next.artifacts, artifact: next.artifact });
    api.refuse();
    expect((await apiQueue.flush(api.sink('different-api', 'env'))).remaining).toEqual([next.runId]);
    expect(api.requests.every(row => row.method === 'GET' && row.token === 'Bearer different-api')).toBe(true);
  });

  it('refuses unsafe private payloads and keeps a zero-deadline flush provider/network free', async () => {
    const f = await fixture(), remote = server(f), queue = new ReviewerDeliveryQueue(f.root);
    await queue.retain({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    expect(await queue.flush(remote.sink(), { deadlineMs: 0 })).toMatchObject({ remaining: [f.runId], stopped: 'deadline' });
    expect(remote.requests).toHaveLength(0);
    const path = join(f.root, 'reviewer-outbox', f.runId, 'reviewer-artifact.json');
    await chmod(path, 0o644);
    expect((await queue.flush(remote.sink())).delivered).toEqual([]);
    await chmod(path, 0o600); await rm(path); await symlink(join(f.root, 'nonexistent'), path);
    expect((await queue.flush(remote.sink())).delivered).toEqual([]);
    expect(remote.requests).toHaveLength(0);
  });

  it('stores and reads back the exact ordinary reports before private admission', async () => {
    const f = await fixture(), remote = server(f); remote.requireReports();
    await new ReviewerDeliveryQueue(f.root).deliver({ sink: remote.sink(), envelope: f.envelope, artifacts: f.artifacts, artifact: f.artifact });
    const privatePut = remote.requests.findIndex(row => row.method === 'PUT' && row.url.endsWith('/reviewer-artifact'));
    for (const kind of ['report_json', 'report_md']) {
      const readback = remote.requests.findIndex(row => row.method === 'GET' && row.url.endsWith(`/artifacts/${kind}`));
      expect(readback).toBeGreaterThanOrEqual(0); expect(readback).toBeLessThan(privatePut);
    }
  });

});
