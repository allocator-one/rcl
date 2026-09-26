import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHarnessModelKeys } from '../../src/config/harness.js';
import { loadMergedWeights } from '../../src/models/server-stats.js';
import type { HarnessCredential } from '../../src/telemetry/credentials.js';
import { attestRun } from '../../src/telemetry/attest.js';
import { createTelemetryRuntime, deliverRun } from '../../src/telemetry/deliver.js';
import { openReadSink } from '../../src/telemetry/read-sink.js';
import { fakeFetch, sampleResult, type RecordedRequest } from './fixtures.js';

/**
 * The run-bound credential of `--attest` (RCL-40) in every place a review
 * talks to Harness: model keys, model stats, the evidence runtime and
 * delivery. The stored login and `HARNESS_API_TOKEN` are never consulted, an
 * unmanaged working tree is no obstacle, and nothing is spooled.
 */

const RBC: HarnessCredential = { url: 'https://harness.example.test', token: 'rbc_minted', source: 'attest' };
const ARTIFACTS = { report_json: '{"r":1}', report_md: '# r' };

function answer(request: RecordedRequest): { status: number; body?: unknown } | Error {
  if (request.url.endsWith('/api/v1/model-keys')) return { status: 200, body: { data: { keys: { anthropic: 'sk-ant-from-harness' } } } };
  if (request.url.startsWith('https://harness.example.test/api/v1/reviews/model-stats')) {
    return { status: 200, body: { data: { window_days: 90, computed_at: '2026-09-08T10:00:00Z', min_outcomes_for_weight: 20, models: [] } } };
  }
  if (request.url.endsWith('/api/v1/reviews/runs')) {
    const envelope = JSON.parse(request.body!) as { run: { id: string } };
    return { status: 201, body: { data: { id: envelope.run.id, url: `https://harness.example.test/api/v1/reviews/runs/${envelope.run.id}`, artifacts_expected: ['report_json', 'report_md'] }, meta: { status: 'created' } } };
  }
  if (request.url.includes('/artifacts/')) return new Error('ECONNRESET');
  return { status: 404, body: { error: 'not_found' } };
}

describe('the run-bound credential of --attest', () => {
  let plainRepo: string;
  let dataDir: string;
  let stale: string;

  beforeEach(async () => {
    // No `.harness-cli/config.json`: the attestation is the membership proof.
    plainRepo = await mkdtemp(join(tmpdir(), 'rcl-attested-repo-'));
    dataDir = await mkdtemp(join(tmpdir(), 'rcl-attested-data-'));
    // A stored login that must never be read.
    stale = join(plainRepo, 'credentials.json');
    await writeFile(stale, JSON.stringify({ url: 'https://other.example.test', token: 'aone_login' }));
    await mkdir(join(dataDir, 'outbox'), { recursive: true });
  });

  afterEach(async () => {
    await rm(plainRepo, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('fetches model keys with it, from its host, without the repository signal or the stored login', async () => {
    const { fetch, requests } = fakeFetch(answer);
    const env: Record<string, string | undefined> = { HARNESS_API_TOKEN: 'aone_ci', HARNESS_API_URL: 'https://ci.example.test' };
    const result = await applyHarnessModelKeys({ env, cwd: plainRepo, credentialsPath: stale, fetchImpl: fetch, credential: RBC });

    expect(result.injected).toEqual(['anthropic']);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-from-harness');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://harness.example.test/api/v1/model-keys');
    expect(requests[0]!.headers['authorization']).toBe('Bearer rbc_minted');
  });

  it('reads model stats with it, whatever the environment names', async () => {
    const { fetch, requests } = fakeFetch(answer);
    const env = { HARNESS_API_TOKEN: 'aone_ci', HARNESS_API_URL: 'https://ci.example.test' };

    const opened = await openReadSink({ rclVersion: '3.2.0', env, cwd: plainRepo, credentialsPath: stale, fetchImpl: fetch, credential: RBC });
    expect(opened.host).toBe('harness.example.test');

    const weights = await loadMergedWeights({
      rclVersion: '3.2.0',
      env,
      cwd: plainRepo,
      credentialsPath: stale,
      fetchImpl: fetch,
      credential: RBC,
      localStats: async () => [],
    });
    expect(weights.size).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toMatch(/^https:\/\/harness\.example\.test\/api\/v1\/reviews\/model-stats\?/);
    expect(requests[0]!.headers['authorization']).toBe('Bearer rbc_minted');
  });

  it('builds an attested runtime around it — managed, sink in hand — and never spools what Harness could not take', async () => {
    const { fetch, requests } = fakeFetch(answer);
    const lines: string[] = [];
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.2.0',
      env: { HARNESS_API_TOKEN: 'aone_ci', HARNESS_API_URL: 'https://ci.example.test' },
      cwd: plainRepo,
      dataDir,
      credentialsPath: stale,
      fetchImpl: fetch,
      stderr: (line) => lines.push(line),
      credential: RBC,
    });

    expect(runtime.repoManaged).toBe(true);
    expect(runtime.attested).toBe(true);
    expect(runtime.credential).toEqual(RBC);
    expect(runtime.level).toBe('full');

    const result = sampleResult();
    result.findings[0]!.gating = { reason: 'none', verification: { verdict: 'refuted', model: 'google/gemini-3.8-flash', note: 'The earlier branch returns.' } };
    // The envelope lands; the artifacts hit a dead connection mid-delivery.
    const outcome = await deliverRun(runtime, { result, artifacts: ARTIFACTS, evidenceRequired: true });
    expect(outcome.status).toBe('recorded');
    expect(JSON.parse(requests.find(r => r.url.endsWith('/api/v1/reviews/runs'))!.body!).findings[0]).toMatchObject({ verification_verdict: 'refuted', verification_model: 'google/gemini-3.8-flash', verification_note: 'The earlier branch returns.' });
    expect(outcome.spooled).toBe(false);
    expect(outcome.exitCode).toBe(4);
    expect(outcome.line).toMatch(/nothing spooled/);
    expect(await readdir(join(dataDir, 'outbox'))).toEqual([]);
    expect(requests.filter((r) => r.url.endsWith('/api/v1/reviews/runs'))[0]!.headers['authorization']).toBe('Bearer rbc_minted');
  });

  it('an unreachable Harness at the envelope is an error, not a spool, under the run-bound credential', async () => {
    const { fetch } = fakeFetch(() => new Error('ECONNREFUSED'));
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.2.0',
      env: {},
      cwd: plainRepo,
      dataDir,
      credentialsPath: stale,
      fetchImpl: fetch,
      stderr: () => {},
      credential: RBC,
    });

    const outcome = await deliverRun(runtime, { result: sampleResult(), artifacts: ARTIFACTS, evidenceRequired: true });
    expect(outcome.status).toBe('error');
    expect(outcome.spooled).toBe(false);
    expect(outcome.exitCode).toBe(4);
    expect(outcome.line).toMatch(/does not outlive its workflow run/);
    expect(await readdir(join(dataDir, 'outbox'))).toEqual([]);
  });

  it.each(['2999-01-01T00:00:00Z', '2999-01-01T00:00:00.000Z'])(
    'recovers lost delivery acknowledgements using the minted expiry %s', async expiresAt => {
      const result = sampleResult();
      const artifacts = { report_json: JSON.stringify(result), report_md: '# Original report\n' };
      let posts = 0;
      const { fetch, requests } = fakeFetch(request => {
        if (request.url.startsWith('https://oidc.example.test/token')) return { status: 200, body: { value: 'synthetic-oidc' } };
        if (request.url.endsWith('/api/v1/reviews/attest')) return { status: 201, body: { data: {
          credential: 'rbc_minted', token_type: 'bearer', expires_at: expiresAt, run_id: result.run!.id,
        } } };
        if (request.url.endsWith(`/api/v1/reviews/runs/${result.run!.id}`)) return { status: 404, body: { error: 'not_found' } };
        if (request.url.endsWith('/api/v1/reviews/runs')) {
          if (++posts === 1) return new TypeError('lost acknowledgement');
          return { status: 201, body: { data: {
            id: result.run!.id, url: `https://harness.example.test/api/v1/reviews/runs/${result.run!.id}`,
            artifacts_expected: ['report_json', 'report_md'],
          }, meta: { status: 'created' } } };
        }
        if (request.url.includes('/artifacts/')) {
          const kind = request.url.slice(request.url.lastIndexOf('/') + 1);
          return { status: 201, body: { data: { kind, sha256: createHash('sha256').update(request.body ?? '', 'utf8').digest('hex') } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      });
      const attestation = await attestRun({
        runId: result.run!.id, rclVersion: '4.0.1', fetchImpl: fetch,
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test/token',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-runner', HARNESS_API_URL: RBC.url,
        },
      });
      expect(attestation.expiresAt).toBe(expiresAt);
      const runtime = await createTelemetryRuntime({
        rclVersion: '4.0.1', env: {}, cwd: plainRepo, dataDir, credentialsPath: stale, fetchImpl: fetch, stderr: () => {},
        credential: attestation.credential, attestedExpiresAt: attestation.expiresAt,
      });

      const outcome = await deliverRun(runtime, { result, artifacts, evidenceRequired: true });

      expect(outcome).toMatchObject({ status: 'recorded', spooled: false, exitCode: 0 });
      expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
        ['GET', '/token'], ['POST', '/api/v1/reviews/attest'], ['POST', '/api/v1/reviews/runs'],
        ['GET', `/api/v1/reviews/runs/${result.run!.id}`], ['POST', '/api/v1/reviews/runs'],
        ['PUT', `/api/v1/reviews/runs/${result.run!.id}/artifacts/report_json`],
        ['PUT', `/api/v1/reviews/runs/${result.run!.id}/artifacts/report_md`],
      ]);
      expect(requests[4]!.body).toBe(requests[2]!.body);
      expect(requests[5]!.body).toBe(artifacts.report_json);
      expect(requests[6]!.body).toBe(artifacts.report_md);
      expect(await readdir(join(dataDir, 'outbox'))).toEqual([]);
    },
  );

  it('does a receipt-first, bounded same-workflow replay after an uncertain envelope acknowledgement', async () => {
    let posts = 0;
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith(`/api/v1/reviews/runs/${sampleResult().run!.id}`)) return { status: 404, body: { error: 'not_found' } };
      if (request.url.endsWith('/api/v1/reviews/runs')) {
        posts++;
        if (posts === 1) return new TypeError('fetch failed');
        const envelope = JSON.parse(request.body!) as { run: { id: string } };
        return { status: 201, body: { data: { id: envelope.run.id, url: `https://harness.example.test/api/v1/reviews/runs/${envelope.run.id}`, artifacts_expected: [] }, meta: { status: 'created' } } };
      }
      return { status: 404, body: { error: 'not_found' } };
    });
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.8.1', env: {}, cwd: plainRepo, dataDir, credentialsPath: stale, fetchImpl: fetch, stderr: () => {},
      credential: RBC, attestedExpiresAt: '2999-01-01T00:00:00.000Z',
    });
    const result = sampleResult();

    const outcome = await deliverRun(runtime, { result, artifacts: ARTIFACTS, evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'recorded', spooled: false, exitCode: 0 });
    const postBodies = requests.filter((request) => request.url.endsWith('/api/v1/reviews/runs')).map((request) => request.body);
    expect(postBodies).toHaveLength(2);
    expect(postBodies[1]).toBe(postBodies[0]);
    expect(requests.filter((request) => request.url.endsWith(`/api/v1/reviews/runs/${result.run!.id}`))).toHaveLength(1);
    expect(await readdir(join(dataDir, 'outbox'))).toEqual([]);
  });

  it('rechecks versioned evidence capability before a prepared attested replay', async () => {
    const result = sampleResult();
    result.findings[0]!.locationProvenance = {
      version: 1, source: 'parser', reason: 'reversed_range', originalStartLine: 12, originalEndLine: 10,
    };
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original report\n' };
    let capabilities = 0;
    const { fetch, requests } = fakeFetch(request => {
      if (request.url.endsWith('/api/v1/reviews/model-stats')) {
        capabilities++;
        return { status: 200, body: { data: { models: [] }, meta: { evidence_protocol_version: capabilities === 1 ? 2 : 1 } } };
      }
      if (request.url.endsWith(`/api/v1/reviews/runs/${result.run!.id}`)) return { status: 404, body: { error: 'not_found' } };
      if (request.url.endsWith('/api/v1/reviews/runs')) return new TypeError('lost acknowledgement');
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const runtime = await createTelemetryRuntime({
      rclVersion: '4.0.2', env: {}, cwd: plainRepo, dataDir, credentialsPath: stale, fetchImpl: fetch, stderr: () => {},
      credential: RBC, attestedExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    const outcome = await deliverRun(runtime, { result, artifacts, evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'rejected', spooled: false, exitCode: 4, retention: { status: 'complete' } });
    expect(requests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/reviews/model-stats'],
      ['POST', '/api/v1/reviews/runs'],
      ['GET', `/api/v1/reviews/runs/${result.run!.id}`],
      ['GET', '/api/v1/reviews/model-stats'],
    ]);
    expect(JSON.parse(requests[1]!.body!).findings[0].location_provenance).toEqual({
      version: 1, source: 'parser', reason: 'reversed_range', original_start_line: 12, original_end_line: 10,
    });
    expect(await readdir(join(dataDir, 'outbox'))).toEqual([]);
    const retained = await runtime.quarantine!.inspect(result.run!.id);
    expect(retained).toMatchObject({ status: 'complete', manifest: { acknowledged: false, requested_mode: 'attested' } });
    for (const [kind, bytes] of Object.entries(artifacts)) {
      expect(await readFile(join(retained!.path, retained!.manifest!.artifacts[kind]!.file), 'utf8')).toBe(bytes);
    }
  });

  it('retains an unavailable attested POST without recovery requests when its expiry is invalid', async () => {
    const result = sampleResult();
    const { fetch, requests } = fakeFetch(() => new TypeError('lost acknowledgement'));
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.8.5', env: {}, cwd: plainRepo, dataDir, credentialsPath: stale, fetchImpl: fetch, stderr: () => {},
      credential: RBC, attestedExpiresAt: 'not-a-timestamp',
    });

    const outcome = await deliverRun(runtime, { result, artifacts: ARTIFACTS, evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'rejected', spooled: false, exitCode: 4, retention: { status: 'complete' } });
    expect(requests.map(request => request.method)).toEqual(['POST']);
    expect(outcome.line).toContain('attested_recovery_invalid_expiry');
    expect(await readdir(join(dataDir, 'outbox'))).toEqual([]);
    const retained = await runtime.quarantine!.inspect(result.run!.id);
    expect(retained).toMatchObject({ status: 'complete', manifest: { acknowledged: false, requested_mode: 'attested' } });
    expect(retained!.manifest!.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'delivery.initial_transport', message: expect.stringContaining('lost acknowledgement') }),
      expect.objectContaining({ path: 'delivery', message: expect.stringContaining('attested_recovery_invalid_expiry') }),
    ]));
  });

  it('binds a recovered receipt to the immutable accepted envelope and resumes artifacts without another POST', async () => {
    const result = sampleResult();
    let posts = 0;
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith(`/api/v1/reviews/runs/${result.run!.id}`)) {
        const posted = JSON.parse(requests.find(candidate => candidate.url.endsWith('/api/v1/reviews/runs'))!.body!) as { artifacts_declared: unknown };
        return { status: 200, body: { data: {
          id: result.run!.id,
          url: `https://harness.example.test/api/v1/reviews/runs/${result.run!.id}`,
          envelope_sha256: createHash('sha256').update(requests.find(candidate => candidate.url.endsWith('/api/v1/reviews/runs'))!.body!, 'utf8').digest('hex'),
          artifacts_declared: posted.artifacts_declared,
        }, meta: { status: 'existing' } } };
      }
      if (request.url.endsWith('/api/v1/reviews/runs')) {
        posts++;
        return new TypeError('lost acknowledgement');
      }
      if (request.url.includes('/artifacts/')) {
        const kind = request.url.slice(request.url.lastIndexOf('/') + 1);
        return { status: 201, body: { data: { kind, sha256: createHash('sha256').update(request.body ?? '', 'utf8').digest('hex') } } };
      }
      return { status: 404, body: { error: 'not_found' } };
    });
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.8.5', env: {}, cwd: plainRepo, dataDir, credentialsPath: stale, fetchImpl: fetch, stderr: () => {},
      credential: RBC, attestedExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    const outcome = await deliverRun(runtime, { result, artifacts: ARTIFACTS, evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'recorded', spooled: false, exitCode: 0 });
    expect(posts).toBe(1);
    expect(requests.filter(request => request.url.endsWith('/api/v1/reviews/runs'))).toHaveLength(1);
    expect(requests.filter(request => request.url.includes('/artifacts/')).map(request => request.method)).toEqual(['PUT', 'PUT']);
  });

  it('rejects a recovered receipt for changed bytes despite the same run identity and declarations', async () => {
    const result = sampleResult();
    let posts = 0;
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith(`/api/v1/reviews/runs/${result.run!.id}`)) {
        const posted = JSON.parse(requests.find(candidate => candidate.url.endsWith('/api/v1/reviews/runs'))!.body!) as { artifacts_declared: unknown };
        return { status: 200, body: { data: {
          id: result.run!.id,
          url: `https://harness.example.test/api/v1/reviews/runs/${result.run!.id}`,
          envelope_sha256: createHash('sha256').update(`${requests.find(candidate => candidate.url.endsWith('/api/v1/reviews/runs'))!.body!} changed`, 'utf8').digest('hex'),
          artifacts_declared: posted.artifacts_declared,
        }, meta: { status: 'existing' } } };
      }
      if (request.url.endsWith('/api/v1/reviews/runs')) {
        posts++;
        return new TypeError('lost acknowledgement');
      }
      return { status: 404, body: { error: 'not_found' } };
    });
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.8.5', env: {}, cwd: plainRepo, dataDir, credentialsPath: stale, fetchImpl: fetch, stderr: () => {},
      credential: RBC, attestedExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    const outcome = await deliverRun(runtime, { result, artifacts: ARTIFACTS, evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'rejected', spooled: false, exitCode: 4 });
    expect(posts).toBe(1);
    expect(requests.filter(request => request.url.endsWith('/api/v1/reviews/runs'))).toHaveLength(1);
    expect(requests.some(request => request.url.includes('/artifacts/'))).toBe(false);
  });

  it('preserves disabled status and private originals when the replay disables review evidence', async () => {
    const secret = 'Abcdef1234567890Abcdef1234567890';
    const failure = new TypeError('fetch failed', { cause: new Error(`socket reset authorization=Bearer ${secret}`) });
    const result = sampleResult();
    let posts = 0;
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith(`/api/v1/reviews/runs/${result.run!.id}`)) return { status: 404, body: { error: 'not_found' } };
      if (request.url.endsWith('/api/v1/reviews/runs')) {
        posts++;
        return posts === 1 ? failure : { status: 403, body: { error: 'reviews_disabled', message: 'Review evidence is disabled' } };
      }
      return { status: 404, body: { error: 'not_found' } };
    });
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.8.1', env: {}, cwd: plainRepo, dataDir, credentialsPath: stale, fetchImpl: fetch, stderr: () => {},
      credential: RBC, attestedExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    const outcome = await deliverRun(runtime, { result, artifacts: ARTIFACTS, evidenceRequired: true });

    expect(outcome).toMatchObject({ status: 'disabled', spooled: false, exitCode: 4, retention: { status: 'complete' } });
    expect(outcome.line).toContain('has not enabled review evidence for this organization');
    expect(outcome.line).toContain('original evidence retained');
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'POST']);
    expect(requests[1]!.url).toBe(`https://harness.example.test/api/v1/reviews/runs/${result.run!.id}`);
    expect(requests[2]!.body).toBe(requests[0]!.body);
    expect(await readdir(join(dataDir, 'outbox'))).toEqual([]);
    const retained = await runtime.quarantine!.inspect(result.run!.id);
    expect(retained).toMatchObject({ status: 'complete', manifest: { run_id: result.run!.id, requested_mode: 'attested', acknowledged: false } });
    expect((await stat(retained!.path)).mode & 0o777).toBe(0o700);
    for (const [kind, bytes] of Object.entries(ARTIFACTS)) {
      const path = join(retained!.path, retained!.manifest!.artifacts[kind]!.file);
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    const diagnostic = retained!.manifest!.diagnostics.find((entry) => entry.path === 'delivery.initial_transport');
    expect(diagnostic?.message).toContain('TypeError: fetch failed; cause: Error: socket reset');
    expect(diagnostic!.message).not.toContain(secret);
    expect(retained!.manifest!.diagnostics.find((entry) => entry.path === 'delivery')?.message).toContain('organization has not enabled review evidence');
  });

  it.each([
    { receiptStatus: 0, status: 'error', posts: 1 },
    { receiptStatus: 408, status: 'error', posts: 1 },
    { receiptStatus: 429, status: 'error', posts: 1 },
    { receiptStatus: 503, status: 'error', posts: 1 },
    { receiptStatus: 403, status: 'rejected', posts: 1 },
    { receiptStatus: 404, status: 'conflict', posts: 2 },
  ])('retains the original safe transport diagnostic when receipt $receiptStatus ends recovery as $status', async ({ receiptStatus, status, posts }) => {
    const secret = 'Abcdef1234567890Abcdef1234567890';
    const failure = new TypeError('fetch failed', { cause: new Error(`socket reset authorization=Bearer ${secret}`) });
    let submitted = 0;
    const result = sampleResult();
    const { fetch, requests } = fakeFetch((request) => {
      if (request.url.endsWith(`/api/v1/reviews/runs/${result.run!.id}`)) {
        return receiptStatus === 0 ? new TypeError('receipt unavailable') : { status: receiptStatus, body: { error: 'fixture_receipt_failure' } };
      }
      if (request.url.endsWith('/api/v1/reviews/runs')) {
        submitted++;
        return submitted === 1 ? failure : { status: 409, body: { error: 'conflict' } };
      }
      return { status: 404, body: { error: 'not_found' } };
    });
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.8.2', env: {}, cwd: plainRepo, dataDir, credentialsPath: stale, fetchImpl: fetch, stderr: () => {},
      credential: RBC, attestedExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    const outcome = await deliverRun(runtime, { result, artifacts: ARTIFACTS, evidenceRequired: true });

    expect(outcome).toMatchObject({ status, spooled: false, exitCode: 4 });
    expect(requests.filter((request) => request.url.endsWith('/api/v1/reviews/runs'))).toHaveLength(posts);
    expect(requests.map((request) => request.method)).toEqual(posts === 1 ? ['POST', 'GET'] : ['POST', 'GET', 'POST']);
    expect(requests[1]!.url).toBe(`https://harness.example.test/api/v1/reviews/runs/${result.run!.id}`);
    const retained = await runtime.quarantine!.inspect(result.run!.id);
    expect(retained).toMatchObject({ status: 'complete', manifest: { run_id: result.run!.id, requested_mode: 'attested', acknowledged: false } });
    const diagnostic = retained!.manifest!.diagnostics.find((entry) => entry.path === 'delivery.initial_transport');
    expect(diagnostic?.message).toContain('TypeError: fetch failed; cause: Error: socket reset');
    expect(diagnostic!.message).not.toContain(secret);
    expect(diagnostic!.message.length).toBeLessThanOrEqual(300);
    if (status === 'error') {
      expect(outcome.line).toContain('attested_recovery_receipt_unavailable');
      expect(retained!.manifest!.diagnostics.find((entry) => entry.path === 'delivery')?.message).toContain('attested_recovery_receipt_unavailable');
    }
    expect(await readdir(join(dataDir, 'outbox'))).toEqual([]);
  });

  it('still honours telemetry off: no sink, nothing sent', async () => {
    const { fetch, requests } = fakeFetch(answer);
    const runtime = await createTelemetryRuntime({
      rclVersion: '3.2.0',
      env: { RCL_TELEMETRY: 'off' },
      cwd: plainRepo,
      dataDir,
      credentialsPath: stale,
      fetchImpl: fetch,
      stderr: () => {},
      credential: RBC,
    });
    expect(runtime.level).toBe('off');
    expect(runtime.sink).toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});
