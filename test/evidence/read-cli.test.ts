import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { sampleResult } from '../telemetry/fixtures.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = process.env['RCL_TEST_PACKAGED_CLI'] || join(root, 'dist/index.js');

async function snapshot(dir: string): Promise<Record<string, { bytes: string; mtime: number }>> {
  const files: Record<string, { bytes: string; mtime: number }> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(path));
    else files[path] = { bytes: (await readFile(path)).toString('base64'), mtime: (await stat(path)).mtimeMs };
  }
  return files;
}

describe('built evidence read commands', () => {
  it.each(['show', 'status'] as const)('%s issues only its GET and leaves a valid populated retry queue untouched', async (command) => {
    const cwd = await mkdtemp(join(tmpdir(), 'rcl-evidence-read-synthetic-'));
    const dataDir = join(cwd, 'data');
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Synthetic queued report' };
    const envelope = buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } });
    const events = [buildEvent({ kind: 'round_processed', convergeTarget: 'synthetic', round: 1, runId: envelope.run.id, payload: {} })];
    await new Outbox(join(dataDir, 'outbox')).spoolRun({ runId: envelope.run.id, envelope, artifacts, events });
    await mkdir(join(cwd, '.harness-cli'));
    await writeFile(join(cwd, '.harness-cli/config.json'), JSON.stringify({ team: 'RCL' }));
    await writeFile(join(cwd, 'SYNTHETIC_TEST_ONLY'), 'Evidence read regression fixture; never import.\n');
    const before = await snapshot(dataDir);
    const requests: string[] = [];
    const projection = { status: 'converged', conclusive: true, actionable: [], rounds: [] };
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* Drain any unintended write so the assertion can report it. */ }
      requests.push(`${req.method} ${req.url}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'GET') {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: 'unexpected_write' }));
      } else {
        res.end(JSON.stringify({ data: command === 'show'
          ? { id: envelope.run.id, target: { kind: 'patch' }, findings: [], calls: [] }
          : { repo: 'allocator-one/rcl', pr_number: 42, head: null, advisory: projection, enforced: projection, decision: null } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local server');
      await exec(process.execPath, [cli, 'evidence', command, command === 'show' ? envelope.run.id : 'allocator-one/rcl#42', '--json'], {
        cwd, timeout: 15_000,
        env: { PATH: process.env.PATH, HOME: cwd, RCL_DATA_DIR: dataDir,
          HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN', HARNESS_API_URL: `http://127.0.0.1:${address.port}`,
          NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      expect(requests).toEqual([command === 'show'
        ? `GET /api/v1/reviews/runs/${envelope.run.id}`
        : 'GET /api/v1/reviews/prs/allocator-one/rcl/42']);
      expect(await snapshot(dataDir)).toEqual(before);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 25_000);
});
