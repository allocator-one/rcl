import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { sampleFinding, sampleResult, sampleReview } from './fixtures.js';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
// The same behavior checks can exercise the installed npm tarball before release.
const cli = process.env['RCL_TEST_PACKAGED_CLI'] ?? join(root, 'dist/index.js');
async function snapshot(dir: string): Promise<Record<string, { bytes: string; mtime: number }>> {
  const files: Record<string, { bytes: string; mtime: number }> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(path));
    else files[path] = { bytes: (await readFile(path)).toString('base64'), mtime: (await stat(path)).mtimeMs };
  }
  return files;
}
beforeAll(async () => {
  if (!process.env['RCL_TEST_PACKAGED_CLI']) await exec(process.execPath, [join(dirname(fileURLToPath(import.meta.resolve('typescript'))), '../bin/tsc')], { cwd: root, timeout: 30_000 });
}, 35_000);

describe('built refutation recovery command', () => {
  it('keeps dry-run GET-only with a valid queued live review, applies explicitly, and repeats with zero writes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rcl-recovery-cli-')); const dataDir = join(cwd, 'data'); const reports = join(cwd, 'reports');
    await mkdir(reports);
    const result = sampleResult({ reviews: [sampleReview()], findings: [sampleFinding({ gating: { reason: 'none', verification: { verdict: 'refuted', model: 'vendor/model', note: 'Original explanation' } } })], belowThresholdFindings: [] });
    const artifacts = { report_json: JSON.stringify(result) };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
    await new Outbox(join(dataDir, 'outbox')).spoolRun({ runId: envelope.run.id, envelope, artifacts, events: [buildEvent({ kind: 'round_processed', convergeTarget: 'synthetic', round: 1, runId: envelope.run.id, payload: {} })] });
    await writeFile(join(reports, 'report.json'), artifacts.report_json);
    await mkdir(join(cwd, '.harness-cli')); await writeFile(join(cwd, '.harness-cli/config.json'), JSON.stringify({ team: 'RCL' }));
    const before = await snapshot(dataDir);
    const requests: string[] = []; let recorded: typeof envelope | undefined; let stored = false;
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      requests.push(`${req.method} ${req.url}`); res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/v1/reviews/runs?page_size=1') res.end(JSON.stringify({ data: [], meta: { org_id: '919921a0-0000-4000-8000-000000000001' } }));
      else if (req.method === 'POST' && req.url === '/api/v1/reviews/runs') {
        recorded = JSON.parse(body); res.statusCode = 201;
        res.end(JSON.stringify({ data: { id: recorded!.run.id, url: '/runs/' + recorded!.run.id, artifacts_expected: ['report_json'] }, meta: { status: 'created' } }));
      } else if (recorded && req.method === 'PUT' && req.url === `/api/v1/reviews/runs/${recorded.run.id}/artifacts/report_json`) {
        expect(body).toBe(artifacts.report_json); stored = true; res.statusCode = 201;
        res.end(JSON.stringify({ data: { kind: 'report_json', sha256: recorded.artifacts_declared[0]!.sha256 } }));
      } else if (recorded && req.method === 'GET' && req.url === `/api/v1/reviews/runs/${recorded.run.id}`) {
        res.end(JSON.stringify({ data: { ...recorded.run, findings: recorded.findings, calls: recorded.calls, artifacts: recorded.artifacts_declared.map((a) => ({ kind: a.kind, declared_sha256: a.sha256, declared_bytes: a.bytes, stored })) } }));
      } else { res.statusCode = 404; res.end(JSON.stringify({ error: 'not_found' })); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error();
      const env = { PATH: process.env.PATH, HOME: cwd, RCL_DATA_DIR: dataDir, HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN', HARNESS_API_URL: `http://127.0.0.1:${address.port}`, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
      const manifest = join(cwd, 'manifest.json'); const output = join(cwd, 'outcome.json');
      const run = (...args: string[]) => exec(process.execPath, [cli, 'telemetry', 'recover-refutations', '--manifest', manifest, ...args], { cwd, env, timeout: 15_000 });
      await run('--root', reports);
      expect(requests.every((r) => r.startsWith('GET '))).toBe(true);
      expect(JSON.parse(await readFile(manifest, 'utf8')).plans[0].action).toBe('import_history');
      expect(await snapshot(dataDir)).toEqual(before);
      await run('--apply', '--output', output);
      expect(JSON.parse(await readFile(output, 'utf8')).writes).toEqual({ runs: 1, artifacts: 1 });
      const writes = requests.filter((r) => !r.startsWith('GET '));
      await run('--apply', '--output', join(cwd, 'outcome-again.json'));
      expect(requests.filter((r) => !r.startsWith('GET '))).toEqual(writes);
      expect(recorded!.run).toMatchObject({ provenance: 'backfill', historical_source: { original_run_id: result.run!.id } });
      expect(await snapshot(dataDir)).toEqual(before);
      expect(requests.some((r) => r.includes('/events'))).toBe(false);
      expect((await stat(manifest)).mode & 0o777).toBe(0o600);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())); await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
