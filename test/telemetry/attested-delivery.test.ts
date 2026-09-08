import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHarnessModelKeys } from '../../src/config/harness.js';
import { loadMergedWeights } from '../../src/models/server-stats.js';
import type { HarnessCredential } from '../../src/telemetry/credentials.js';
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

    // The envelope lands; the artifacts hit a dead connection mid-delivery.
    const outcome = await deliverRun(runtime, { result: sampleResult(), artifacts: ARTIFACTS, evidenceRequired: true });
    expect(outcome.status).toBe('recorded');
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
