import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttestedReviewerDelivery } from '../../src/telemetry/attested-reviewer-delivery.js';
import { attestRun, type Attestation } from '../../src/telemetry/attest.js';
import { inspectReviewerArtifact, serializeReviewerArtifact } from '../../src/report/reviewer-artifact.js';
import { buildRunEnvelope, declareReviewerRecovery, sha256Hex } from '../../src/telemetry/envelope.js';
import { createTelemetryRuntime, deliverRun } from '../../src/telemetry/deliver.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const host = 'https://harness.example.test';
const env = { HARNESS_API_URL: host, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example.test/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-request' };
function fixture(index = 0) {
  const rows = JSON.parse(readFileSync(new URL('../fixtures/reviewer-artifact-lineage.json', import.meta.url), 'utf8')).rows;
  const entries = rows.map((r: any) => inspectReviewerArtifact(r.artifact_bytes, r.expectations));
  const entry = entries[index]!, parent = entries[index - 1];
  const result = JSON.parse(entry.reportBytes); result.run.reviewer_evidence = entry.descriptor;
  const artifacts = { report_json: JSON.stringify(result), report_md: '# Synthetic report\n' };
  const artifact = serializeReviewerArtifact({ assembly: entry.assembly, representation: entry.representation, reportBytes: artifacts.report_json });
  const source = parent && { run_id: parent.runId, report_sha256: parent.reportSha256, reviewer_artifact_sha256: parent.artifact.digest };
  const declaration = declareReviewerRecovery({ artifact, descriptor: entry.descriptor, ...(source ? { source } : {}) });
  const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' }, reviewerRecovery: declaration });
  const operationBytes = entry.proof.bindings[index ? 'operation' : 'launch']!;
  const operation = JSON.parse(operationBytes);
  vi.spyOn(Date, 'now').mockReturnValue(operation.startedAtMs + 10);
  return { entry, entries, parent, source, result, envelope, artifacts, artifact, operationBytes, operation };
}
function remote(f: ReturnType<typeof fixture>) {
  const requests: Array<{ path: string; method: string; body?: string; authorization: string | null }> = [];
  let posted = false, privateBytes: string | undefined, losePost = false, losePrivate = false, unavailablePrivate = false, capability = true, parentStatus = 200;
  const ordinary = new Map<string, string>();
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET';
    requests.push({ path, method, body: init?.body as string | undefined, authorization: new Headers(init?.headers).get('authorization') });
    const json = (status: number, value: unknown) => Response.json(value, { status });
    if (path === '/oidc') return json(200, { value: 'synthetic.jwt' });
    if (path.endsWith('/attest')) return json(201, { data: { credential: 'rbc_synthetic', run_id: f.entry.runId, expires_at: new Date(100_000).toISOString() } });
    if (path.endsWith('/model-stats')) return json(200, { data: { models: [] }, meta: capability ? {
      reviewer_recovery_protocol: 1, reviewer_artifact_schema: 1, reviewer_artifact_max_bytes: 25_000_000 } : {} });
    const receipt = () => ({ data: { id: f.entry.runId, url: `${host}/api/v1/reviews/runs/${f.entry.runId}`,
      envelope_sha256: sha256Hex(JSON.stringify(f.envelope)), artifacts_declared: f.envelope.artifacts_declared,
      artifacts_expected: f.envelope.artifacts_declared.map(a => a.kind) }, meta: { status: 'existing' } });
    if (path.endsWith('/runs')) {
      expect(method).toBe('POST'); expect(init?.body).toBe(JSON.stringify(f.envelope)); posted = true;
      if (losePost) { losePost = false; throw new Error('synthetic lost POST acknowledgement'); }
      return json(201, receipt());
    }
    if (path.endsWith(`/runs/${f.entry.runId}`)) return posted ? json(200, receipt()) : json(404, { error: 'not_found' });
    const raw = (bytes: string) => new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-artifact-sha256': sha256Hex(bytes),
      'cache-control': 'private, no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff' } });
    if (f.parent && path.endsWith(`/runs/${f.parent.runId}/reviewer-artifact`)) {
      expect(method).toBe('GET'); return parentStatus === 200 ? raw(f.parent.artifact.bytes) : json(parentStatus, { error: 'source_unavailable' });
    }
    if (path.endsWith(`/runs/${f.entry.runId}/reviewer-artifact`)) {
      if (method === 'PUT') {
        expect(ordinary.get('report_json')).toBe(f.artifacts.report_json);
        expect(init?.body).toBe(f.artifact.bytes); privateBytes = init!.body as string;
        if (losePrivate) { losePrivate = false; throw new Error('synthetic lost private acknowledgement'); }
        return json(201, { data: { run_id: f.entry.runId, sha256: f.artifact.digest, bytes: Buffer.byteLength(privateBytes) }, meta: { status: 'created' } });
      }
      if (unavailablePrivate) return json(503, { error: 'source_unavailable' });
      if (privateBytes) return raw(privateBytes);
      return json(404, posted ? { error: 'reviewer_artifact_pending', data: {
        run_id: f.entry.runId, sha256: f.artifact.digest, bytes: Buffer.byteLength(f.artifact.bytes) } } : { error: 'not_found' });
    }
    if (path.includes('/artifacts/')) {
      // RunBoundScope permits PUT, never generic artifact GET.
      expect(method).toBe('PUT'); const kind = path.split('/').at(-1)!;
      ordinary.set(kind, init!.body as string);
      return json(201, { data: { kind, sha256: sha256Hex(init!.body as string) }, meta: { status: 'created' } });
    }
    return json(403, { error: 'out_of_scope' });
  };
  const mint = () => attestRun({ runId: f.entry.runId, rclVersion: '4.1.5', env, fetchImpl,
    ...(f.source ? { reviewerRecovery: { version: 1, source: f.source } as const } : {}) });
  return { fetchImpl, requests, mint, lostPost: () => { losePost = true; }, lostPrivate: () => { losePrivate = true; },
    unreadable: (v: boolean) => { unavailablePrivate = v; }, unsupported: () => { capability = false; }, missingParent: () => { parentStatus = 503; } };
}
function transport(f: ReturnType<typeof fixture>, r: ReturnType<typeof remote>, attestation: Attestation) {
  return new AttestedReviewerDelivery(attestation, { rclVersion: '4.1.5', operationBytes: f.operationBytes,
    kind: f.parent ? 'successor' : 'original', fetchImpl: r.fetchImpl });
}
function preflight(f: ReturnType<typeof fixture>) {
  const lineage = f.entries.slice(0, -1).map((e: any) => ({ runId: e.runId, reportSha256: e.reportSha256, reviewerArtifactSha256: e.artifact.digest }));
  return { target: f.entry.proof.plan.target, headSha: f.entry.proof.plan.headSha,
    successorRunId: f.entry.runId, source: lineage.at(-1)!, lineage };
}

describe('transient attested private delivery', () => {
  it('delivers a fresh original with no grant, resolving both lost acknowledgements without duplicate writes', async () => {
    const f = fixture(), r = remote(f), attestation = await r.mint(), t = transport(f, r, attestation);
    r.lostPost(); r.lostPrivate();
    await t.checkOriginal();
    expect(await t.deliver(f)).toMatchObject({ reportJsonVerified: true, markdown: 'put_receipt' });
    expect(r.requests.filter(x => x.method === 'POST' && x.path.endsWith('/runs'))).toHaveLength(1);
    expect(r.requests.filter(x => x.method === 'PUT' && x.path.endsWith('/reviewer-artifact'))).toHaveLength(1);
    expect(r.requests.some(x => x.method === 'GET' && x.path.includes('/artifacts/'))).toBe(false);
  });

  it('cold-restarts exact retained bytes only with a recorded own-run receipt and live unchanged deadline', async () => {
    const f = fixture(), r = remote(f), attestation = await r.mint(); r.lostPrivate(); r.unreadable(true);
    await expect(transport(f, r, attestation).deliver(f)).rejects.toThrow();
    r.unreadable(false);
    const copied = structuredClone(attestation);
    const restarted = transport(f, r, copied);
    expect(await restarted.deliver(f)).toMatchObject({ reportJsonVerified: true });
    expect(r.requests.filter(x => x.method === 'POST' && x.path.endsWith('/runs'))).toHaveLength(1);
    expect(r.requests.filter(x => x.method === 'PUT' && x.path.endsWith('/reviewer-artifact'))).toHaveLength(1);
    vi.mocked(Date.now).mockReturnValue(f.operation.expiresAtMs);
    const before = r.requests.length;
    await expect(transport(f, r, copied).deliver(f)).rejects.toThrow('attested_reviewer_deadline');
    expect(r.requests).toHaveLength(before);
  });

  it('refuses unknown-run cold restart and a substituted credential without creating a run or spooling', async () => {
    const f = fixture(), r = remote(f), attestation = await r.mint();
    await expect(transport(f, r, structuredClone(attestation)).deliver(f)).rejects.toThrow('attested_reviewer_unknown_run');
    expect(r.requests.some(x => x.method === 'POST' && x.path.endsWith('/runs'))).toBe(false);
    expect(() => transport(f, r, { ...attestation, credential: { ...attestation.credential, source: 'login', token: 'login' } })).toThrow();
  });

  it('reads only the signed immediate parent, never earlier ancestors, before any paid intent', async () => {
    const f = fixture(2), r = remote(f), attestation = await r.mint(), t = transport(f, r, attestation), request = preflight(f);
    const paid = vi.fn(); await t.preflight(request); paid();
    const privateReads = r.requests.filter(x => x.path.endsWith('/reviewer-artifact'));
    expect(privateReads.map(x => x.path)).toEqual([`/api/v1/reviews/runs/${f.parent.runId}/reviewer-artifact`]);
    expect(paid).toHaveBeenCalledOnce();
    expect(await t.deliver(f)).toMatchObject({ reportJsonVerified: true });
  });

  it('refuses changed parent, unsupported capability, unavailable source and expired credentials before paid work', async () => {
    for (const reason of ['parent', 'capability', 'source', 'expiry'] as const) {
      const f = fixture(2), r = remote(f), attestation = await r.mint(), t = transport(f, r, attestation), request = preflight(f), paid = vi.fn();
      if (reason === 'parent') request.source = { ...request.source, reviewerArtifactSha256: 'a'.repeat(64) };
      if (reason === 'capability') r.unsupported();
      if (reason === 'source') r.missingParent();
      if (reason === 'expiry') vi.mocked(Date.now).mockReturnValue(100_000);
      await expect(t.preflight(request).then(paid)).rejects.toThrow();
      expect(paid).not.toHaveBeenCalled(); expect(r.requests.some(x => x.method === 'PUT')).toBe(false);
      if (reason === 'parent' || reason === 'expiry') expect(r.requests).toHaveLength(2);
      vi.restoreAllMocks();
    }
  });

  it('rejects changed report/proof binding and canceled work before transmitting private bytes', async () => {
    const f = fixture(), r = remote(f), attestation = await r.mint(), t = transport(f, r, attestation);
    await expect(t.deliver({ ...f, artifacts: { ...f.artifacts, report_json: '{}' } })).rejects.toThrow();
    await expect(t.deliver({ ...f, artifact: structuredClone(f.artifact) })).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(t.deliver(f, { signal: controller.signal })).rejects.toThrow();
    expect(r.requests).toHaveLength(2);
  });

  it('keeps the first immutable delivery bytes even after local cancellation before transmission', async () => {
    const f = fixture(), r = remote(f), attestation = await r.mint(), t = transport(f, r, attestation);
    const controller = new AbortController(); controller.abort();
    await expect(t.deliver(f, { signal: controller.signal })).rejects.toThrow();
    await expect(t.deliver({ ...f, envelope: { ...f.envelope, delivery: { mode: 'retried' } } }))
      .rejects.toThrow('attested_reviewer_immutable_conflict');
    expect(r.requests).toHaveLength(2);
  });

  it('caps unavailable envelope attempts and does not reset them in the same coordinator', async () => {
    const f = fixture(), r = remote(f), attestation = await r.mint(); let posts = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/runs')) { posts++; return Response.json({ error: 'unavailable' }, { status: 503 }); }
      return r.fetchImpl(url, init);
    };
    const t = new AttestedReviewerDelivery(attestation, { kind: 'original', operationBytes: f.operationBytes, rclVersion: '4.1.5', fetchImpl });
    await expect(t.deliver(f)).rejects.toThrow('attested_reviewer_envelope_attempts_exhausted');
    await expect(t.deliver(f)).rejects.toThrow('attested_reviewer_envelope_attempts_exhausted');
    expect(posts).toBe(3);
    expect(r.requests.some(x => x.method === 'PUT')).toBe(false);
  });

  it('aborts an in-flight source read at the shorter deadline without reaching a paid callback', async () => {
    const f = fixture(2), r = remote(f), attestation = await r.mint(); let aborted = false;
    const fetchImpl: typeof fetch = (url, init) => String(url).endsWith('/reviewer-artifact')
      ? new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }, { once: true }); })
      : r.fetchImpl(url, init);
    const t = new AttestedReviewerDelivery(attestation, { kind: 'successor', operationBytes: f.operationBytes, rclVersion: '4.1.5', fetchImpl });
    const paid = vi.fn();
    await expect(t.preflight(preflight(f), { timeoutMs: 20 }).then(paid)).rejects.toThrow();
    expect(aborted).toBe(true); expect(paid).not.toHaveBeenCalled();
  });

  it('integrates only through an explicit matching coordinator and never stores an attested outbox or token', async () => {
    const f = fixture(), r = remote(f), attestation = await r.mint(), t = transport(f, r, attestation);
    const root = await mkdtemp(join(tmpdir(), 'rcl-attested-private-')); roots.push(root);
    const lines: string[] = [];
    const runtime = await createTelemetryRuntime({ rclVersion: '4.1.5', credential: attestation.credential,
      attestedExpiresAt: attestation.expiresAt, dataDir: root, fetchImpl: r.fetchImpl, stderr: line => lines.push(line), env: {} });
    const missing = await deliverRun(runtime, { result: f.result, artifacts: f.artifacts, reviewerArtifact: f.artifact, evidenceRequired: true });
    expect(missing.status).toBe('rejected');
    const delivered = await deliverRun(runtime, { result: f.result, artifacts: f.artifacts, reviewerArtifact: f.artifact,
      attestedReviewer: t, evidenceRequired: true });
    expect(delivered).toMatchObject({ status: 'recorded', spooled: false, exitCode: 0 });
    expect(await readdir(root)).not.toContain('reviewer-outbox');
    expect(lines.join('\n')).toContain('captured prompts'); expect(lines.join('\n')).not.toContain('rbc_synthetic');
  });
});
