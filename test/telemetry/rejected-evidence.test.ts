import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTelemetryRuntime, deliverRun, flushOutbox } from '../../src/telemetry/deliver.js';
import { sha256Hex } from '../../src/telemetry/envelope.js';
import { fakeFetch, sampleResult } from './fixtures.js';

describe('retention of refused completed evidence', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'rcl-rejected-')); });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  async function runtime(handler: Parameters<typeof fakeFetch>[0], attested = false) {
    const { fetch, requests } = fakeFetch(handler);
    const rt = await createTelemetryRuntime({
      rclVersion: '3.7.0', env: {}, config: {} as never, dataDir,
      credential: { url: 'https://harness.example.test', token: 'aone_SECRET_DO_NOT_RETAIN', source: attested ? 'attest' : 'login' },
      fetchImpl: fetch, stderr: () => {},
    });
    return { rt, requests };
  }

  it.each(['kept', 'appendix', 'header', 'overflow'] as const)('refuses an invalid %s envelope locally and retains both original artifacts', async (part) => {
    const { rt, requests } = await runtime(() => ({ status: 422, body: { error: 'validation_error' } }));
    const result = sampleResult();
    if (part === 'kept') result.findings[0]!.endLine = 1;
    if (part === 'appendix') result.belowThresholdFindings![0]!.endLine = 1;
    if (part === 'header') result.run!.target.head_sha = 'not-a-git-object';
    if (part === 'overflow') result.findings[0]!.endLine = 2147483648;
    const artifacts = { report_json: JSON.stringify(result, null, 2) + '\n', report_md: '# Original report\n' };
    const outcome = await deliverRun(rt, { result, artifacts, evidenceRequired: true });

    expect(requests).toEqual([]);
    expect(outcome).toMatchObject({ status: 'rejected', spooled: false, exitCode: 4, retention: { status: 'complete' } });
    const dir = join(dataDir, 'quarantine', result.run!.id);
    expect(await readFile(join(dir, 'report.json'), 'utf8')).toBe(artifacts.report_json);
    expect(await readFile(join(dir, 'report.md'), 'utf8')).toBe(artifacts.report_md);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      run_id: result.run!.id, requested_mode: 'asserted', acknowledged: false,
      artifacts: { report_json: { sha256: sha256Hex(artifacts.report_json) } },
    });
    expect(manifest.diagnostics[0].path).toMatch(/findings|run.target.head_sha/);
    expect(await rt.outbox.list()).toEqual([]);
  });

  it.each([false, true])('refuses malformed transport Unicode locally and retains exact originals (attested=%s)', async attested => {
    const { rt, requests } = await runtime(() => ({ status: 400, body: { error: 'bad_request' } }), attested);
    const result = sampleResult();
    result.findings[0]!.file = 'src/invalid\uD800.ts';
    const artifacts = { report_json: JSON.stringify(result, null, 2) + '\n', report_md: '# Original report\n' };
    const outcome = await deliverRun(rt, { result, artifacts, evidenceRequired: true });
    expect(outcome).toMatchObject({ status: 'rejected', exitCode: 4, spooled: false, retention: { status: 'complete' } });
    expect(requests).toEqual([]);
    const dir = join(dataDir, 'quarantine', result.run!.id);
    expect(await readFile(join(dir, 'report.json'), 'utf8')).toBe(artifacts.report_json);
    expect(await readFile(join(dir, 'report.md'), 'utf8')).toBe(artifacts.report_md);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ requested_mode: attested ? 'attested' : 'asserted', acknowledged: false,
      artifacts: { report_json: { sha256: sha256Hex(artifacts.report_json) } },
      diagnostics: [{ path: 'envelope', message: 'Envelope contains an unpaired UTF-16 surrogate' }],
    });
    expect(await rt.outbox.list()).toEqual([]);
  });

  it.each([false, true])('retains a direct 422 without making it auto-retryable (attested=%s)', async (attested) => {
    const { rt, requests } = await runtime(() => ({ status: 422, body: { error: 'validation_error', message: 'findings[1].end_line is invalid' } }), attested);
    rt.level = 'findings';
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original report\n' };
    const outcome = await deliverRun(rt, { result, artifacts, evidenceRequired: true });
    expect(outcome).toMatchObject({ status: 'rejected', spooled: false, exitCode: 4, retention: { status: 'complete' } });
    await flushOutbox(rt);
    await flushOutbox(rt);
    expect(requests).toHaveLength(1);
    const dir = join(dataDir, 'quarantine', result.run!.id);
    expect(await readFile(join(dir, 'report.json'), 'utf8')).toBe(artifacts.report_json);
    expect(await readFile(join(dir, 'report.md'), 'utf8')).toBe(artifacts.report_md);
    const text = await readFile(join(dir, 'manifest.json'), 'utf8');
    expect(text).not.toContain('aone_SECRET_DO_NOT_RETAIN');
    expect(JSON.parse(text)).toMatchObject({ requested_mode: attested ? 'attested' : 'asserted', acknowledged: false });
  });

  it.each(['digest', 'head', 'repo', 'verification', 'call-error'])('rejects backend-invalid %s text before contacting the transport', async (part) => {
    const { rt, requests } = await runtime(() => ({ status: 422, body: { error: 'validation_error' } }));
    const result = sampleResult();
    if (part === 'digest') result.run!.config_sha256 += '\n';
    if (part === 'head') result.run!.target.head_sha += '\n';
    if (part === 'repo') result.run!.target.repo += '\n';
    if (part === 'verification') result.findings[0]!.gating = { reason: 'none', verification: { verdict: 'refuted', note: 'reason\0tail' } };
    if (part === 'call-error') { result.reviews[0]!.status = 'error'; result.reviews[0]!.error = 'failure\0tail'; }
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original\n' };
    const outcome = await deliverRun(rt, { result, artifacts, evidenceRequired: true });
    expect(requests).toEqual([]);
    expect(outcome).toMatchObject({ status: 'rejected', exitCode: 4, retention: { status: 'complete' } });
  });

  it('retains output failures even when the server acknowledges a findings-only run', async () => {
    const result = sampleResult();
    const { rt } = await runtime(() => ({ status: 201, body: { data: { id: result.run!.id, url: 'https://harness.example.test/run', artifacts_expected: [] } } }));
    rt.level = 'findings';
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original\n' };
    const outcome = await deliverRun(rt, { result, artifacts, evidenceRequired: true,
      outputDiagnostics: [{ path: 'output.report_md', message: 'Could not write Markdown: EROFS' }] });
    expect(outcome).toMatchObject({ status: 'recorded', exitCode: 0, spooled: false, retention: { status: 'complete' } });
    const manifest = JSON.parse(await readFile(join(dataDir, 'quarantine', result.run!.id, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ acknowledged: true, diagnostics: [{ path: 'output.report_md', message: expect.stringContaining('EROFS') }] });
    expect(await readFile(join(dataDir, 'quarantine', result.run!.id, 'report.md'), 'utf8')).toBe(artifacts.report_md);
  });

  it('refuses to overwrite retained original bytes when the same run is delivered with different artifacts', async () => {
    const { rt } = await runtime(() => ({ status: 422, body: { error: 'validation_error' } }));
    const result = sampleResult();
    const original = { report_json: JSON.stringify(result), report_md: '# Original\n' };
    await deliverRun(rt, { result, artifacts: original, evidenceRequired: true });
    const outcome = await deliverRun(rt, { result, artifacts: { ...original, report_md: '# Changed\n' }, evidenceRequired: true });
    expect(outcome).toMatchObject({ retention: { status: 'failed' }, exitCode: 4 });
    expect(await readFile(join(dataDir, 'quarantine', result.run!.id, 'report.md'), 'utf8')).toBe(original.report_md);
  });

  it.each([422, 403])('retains both originals when the envelope is acknowledged but an artifact is refused with HTTP %s', async (status) => {
    const result = sampleResult();
    const { rt } = await runtime((request) => request.method === 'POST'
      ? { status: 201, body: { data: { id: result.run!.id, url: 'https://harness.example.test/run', artifacts_expected: ['report_md'] } } }
      : { status, body: { error: status === 403 ? 'artifacts_disabled' : 'validation_error', message: 'artifact refused' } });
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original\n' };
    const outcome = await deliverRun(rt, { result, artifacts, evidenceRequired: true });
    expect(outcome).toMatchObject({ status: 'recorded', spooled: false, exitCode: 4, retention: { status: 'complete' } });
    const manifest = JSON.parse(await readFile(join(dataDir, 'quarantine', result.run!.id, 'manifest.json'), 'utf8'));
    expect(manifest.acknowledged).toBe(true);
    expect(await readFile(join(dataDir, 'quarantine', result.run!.id, 'report.md'), 'utf8')).toBe(artifacts.report_md);
  });

  it('preserves recovery artifacts during a retryable outage even at findings-only delivery level', async () => {
    const { rt } = await runtime(() => new Error('offline'));
    rt.level = 'findings';
    const result = sampleResult();
    result.run!.converge = { target: 'original-target', round: 4, attempt: 7 };
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original\n' };
    const outcome = await deliverRun(rt, { result, artifacts, evidenceRequired: true });
    expect(outcome).toMatchObject({ status: 'spooled', spooled: true, exitCode: 4, retention: { status: 'complete' } });
    const retained = await readFile(join(dataDir, 'quarantine', result.run!.id, 'report.json'), 'utf8');
    expect(retained).toBe(artifacts.report_json);
    expect(await readFile(join(dataDir, 'quarantine', result.run!.id, 'report.md'), 'utf8')).toBe(artifacts.report_md);
    expect((await rt.outbox.list())[0]).toMatchObject({ id: result.run!.id, artifacts: [] });
    expect(result.run!.converge).toEqual({ target: 'original-target', round: 4, attempt: 7 });
  });

  it.each([false, true])('requires explicit server support before sending normalization provenance (attested=%s)', async (attested) => {
    for (const supported of [false, true]) {
      const result = sampleResult();
      result.run!.id = supported ? '019921a0-0000-7000-8000-000000000002' : result.run!.id;
      Object.assign(result.findings[0]!, {
        startLine: 345, endLine: 353,
        locationProvenance: { version: 1, source: 'parser', reason: 'reversed_range', originalStartLine: 353, originalEndLine: 345 },
      });
      const { rt, requests } = await runtime((request) => {
        if (request.method === 'GET') return {
          status: 200, body: { data: attested ? { models: [] } : [], meta: supported ? { evidence_protocol_version: 2 } : {} },
        };
        return { status: 201, body: { data: { id: result.run!.id, url: 'https://harness.example.test/run', artifacts_expected: [] } } };
      }, attested);
      const outcome = await deliverRun(rt, { result, artifacts: { report_json: JSON.stringify(result), report_md: '# Report\n' }, evidenceRequired: true });
      expect(requests[0]?.method).toBe('GET');
      expect(requests[0]?.url).toContain(attested ? '/reviews/model-stats' : '/reviews/runs?page_size=1');
      expect(requests.every((r) => r.headers.authorization === 'Bearer aone_SECRET_DO_NOT_RETAIN')).toBe(true);
      expect(requests.filter((r) => r.method === 'POST')).toHaveLength(supported ? 1 : 0);
      expect(outcome.status).toBe(supported ? 'recorded' : 'rejected');
      expect(outcome.exitCode).toBe(supported ? 0 : 4);
      if (!supported) expect(outcome).toMatchObject({ retention: { status: 'complete' }, spooled: false });
    }
  });
});
