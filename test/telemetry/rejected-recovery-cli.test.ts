import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildRunEnvelope, sha256Hex } from '../../src/telemetry/envelope.js';
import { Quarantine } from '../../src/telemetry/quarantine.js';
import { sampleFinding, sampleResult, sampleReview, sampleRunHeader } from './fixtures.js';

const exec = promisify(execFile);
const cli = process.env['RCL_TEST_PACKAGED_CLI'] || fileURLToPath(new URL('../../dist/index.js', import.meta.url));

describe('built rejected-evidence recovery command', () => {
  it('writes a private GET-only dry-run manifest and leaves retained originals unchanged', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rcl-rejected-recovery-cli-'));
    const dataDir = join(cwd, 'data');
    await mkdir(join(cwd, '.harness-cli'));
    await writeFile(join(cwd, '.harness-cli/config.json'), JSON.stringify({ team: 'RCL' }));
    const runId = '01a0ee2a-d7b2-7062-bf75-51780915dd8b';
    const findings = [
      sampleFinding({ id: 'F1', identity: 'a'.repeat(16), severity: 'important', gating: undefined }),
      sampleFinding({ id: 'F2', identity: 'b'.repeat(16), severity: 'minor', gating: undefined }),
    ];
    const reviews = [sampleReview({ status: 'success' })];
    const result = sampleResult({
      run: sampleRunHeader({ id: runId, rcl_version: '4.4.7', converge: { target: 'allocator-one-9356', round: 5, attempt: 11 } }),
      reviews, findings, belowThresholdFindings: [],
      stats: {
        totalReviews: 1, successfulReviews: 1, totalRawFindings: 2, totalDeduped: 2, belowThreshold: 0, durationMs: 1,
        blockingHealth: { version: 1, fraction: 2 / 3, seats: 1, required: 1, successful: 1, conclusive: true,
          excludedSuccesses: { secondary: 0, async: 0, verification: 0 } },
      },
    });
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original\n' };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
    const quarantine = new Quarantine(join(dataDir, 'quarantine'));
    expect((await quarantine.retain({
      runId, artifacts, envelope, events: [], requestedMode: 'asserted', acknowledged: false,
      diagnostics: [{ path: 'findings.0.gating.reason', message: 'Verified-consensus finding is missing a valid gating label' }],
    })).status).toBe('complete');
    const beforeReport = await readFile(join(dataDir, 'quarantine', runId, 'report.json'), 'utf8');
    const beforeEnvelope = await readFile(join(dataDir, 'quarantine', runId, 'envelope.json'), 'utf8');
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        data: [],
        meta: { org_id: '019921a0-0000-7000-8000-000000000099', severity_fallback_recovery_version: 1 },
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const manifestPath = join(cwd, 'manifest.json');
      const { stdout } = await exec(process.execPath, [cli, 'telemetry', 'recover-rejected', '--run', runId, '--manifest', manifestPath, '--json'], {
        cwd, timeout: 15_000,
        env: { PATH: process.env.PATH, HOME: cwd, RCL_DATA_DIR: dataDir, HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN',
          HARNESS_API_URL: `http://127.0.0.1:${address.port}`, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(JSON.parse(stdout)).toMatchObject({ source: { run_id: runId }, recovery: { actionable_findings: 1 } });
      expect(manifest).toMatchObject({
        source: { report_sha256: sha256Hex(artifacts.report_json), converge: { round: 5, attempt: 11 } },
        recovery: { reason: 'severity-fallback', actionable_findings: 1 },
      });
      expect(requests).toEqual(['GET /api/v1/reviews/runs?page_size=1']);
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(dataDir, 'quarantine', runId, 'report.json'), 'utf8')).toBe(beforeReport);
      expect(await readFile(join(dataDir, 'quarantine', runId, 'envelope.json'), 'utf8')).toBe(beforeEnvelope);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
