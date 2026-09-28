import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { Outbox } from '../../src/telemetry/outbox.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { sampleResult } from './fixtures.js';

const exec = promisify(execFile);
const cli = process.env['RCL_TEST_PACKAGED_CLI'] || fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rcl-envelope-cli-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const requests: Array<{ method: string; body: string }> = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method!, body });
    const data = request.method === 'POST'
      ? { id: JSON.parse(body).run.id, url: 'http://localhost/run', artifacts_expected: ['report_json', 'report_md'] }
      : { kind: request.url!.split('/').at(-1), sha256: createHash('sha256').update(body).digest('hex') };
    const timer = setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data, meta: { status: 'existing' } }));
    }, request.method === 'POST' ? 100 : 0);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const run = async (timeout: string) => {
    const options = { cwd: directory, timeout: 4000, env: { ...process.env, RCL_DATA_DIR: directory,
      RCL_TELEMETRY: 'full', HARNESS_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      HARNESS_API_TOKEN: 'local-fixture', RCL_NO_HARNESS_KEYS: '1' } };
    try {
      return { code: 0, ...await exec(process.execPath, [cli, 'telemetry', 'flush', '--json', '--envelope-timeout-ms', timeout], options) };
    } catch (error) {
      return error as { code: number; stdout: string; stderr: string };
    }
  };
  return { directory, requests, run };
}

it.each(['abc', '10000ms', 'NaN', 'Infinity', '0', '-1', '1.5', '120001'])('refuses invalid CLI timeout %s before runtime or network', async timeout => {
  const f = await fixture();
  const result = await f.run(timeout);
  expect(result.code).toBe(1);
  expect(result.stderr).toMatch(/envelope.*timeout.*120000/i);
  expect(f.requests).toEqual([]);
  expect(await readdir(f.directory)).toEqual([]);
});

it('uses the CLI override to retain a timed-out run, then delivers its original artifacts with a longer limit', async () => {
  const f = await fixture();
  const report = sampleResult({ findings: [], belowThresholdFindings: [] });
  const artifacts = { report_json: JSON.stringify(report), report_md: '# Original\n' };
  const envelope = buildRunEnvelope(report, artifacts, { level: 'full', delivery: { mode: 'direct' } });
  const outbox = new Outbox(join(f.directory, 'outbox'));
  await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts });
  const failed = await f.run('1');
  expect(failed.code).toBe(1);
  expect(JSON.parse(failed.stdout)).toMatchObject({ delivered: [], remaining: [envelope.run.id] });
  const delivered = await f.run('120000');
  expect(delivered.code).toBe(0);
  expect(JSON.parse(delivered.stdout)).toMatchObject({ delivered: [envelope.run.id], remaining: [], failed: [] });
  expect(f.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([artifacts.report_json, artifacts.report_md]);
  expect(await outbox.list()).toEqual([]);
});
