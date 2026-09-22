import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { processRoundReport, convergeRunStatePath } from '../../src/converge/run-state.js';
import { describeClaim } from '../../src/consensus/claim-identity.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { sampleFinding, sampleResult } from '../telemetry/fixtures.js';

const entrypoint = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let repo: string;
let env: NodeJS.ProcessEnv;
let server: Server;
let requests: string[];

async function snapshot(directory: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...await snapshot(path));
    else {
      const metadata = await stat(path);
      result.push([path, sha(await readFile(path)), metadata.mode, metadata.mtimeMs]);
    }
  }
  return result;
}

async function cli(...args: string[]) {
  try {
    const output = await promisify(execFile)(process.execPath, ['--import', tsx, entrypoint, ...args, '--json'],
      { cwd: repo, env, timeout: 15_000 });
    return { ...output, code: 0 };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'rcl-round-binding-'));
  requests = [];
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push(`${request.method} ${request.url}`);
    const input = body ? JSON.parse(body) : {};
    const data = request.url === '/api/v1/reviews/runs'
      ? { id: input.run?.id, artifacts_expected: [] }
      : { inserted: input.events?.length ?? 0, duplicates: 0 };
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  env = {
    PATH: process.env['PATH'], HOME: process.env['HOME'],
    GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice, GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: join(repo, 'config'), RCL_DATA_DIR: join(repo, 'data'),
    HARNESS_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    HARNESS_API_TOKEN: 'synthetic-round-binding-token', RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1',
  };
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  await mkdir(join(repo, '.harness-cli'));
  await writeFile(join(repo, '.harness-cli/config.json'), '{}');
  await writeFile(join(repo, '.review-council.json'), JSON.stringify({ harness: { telemetry: 'envelope' } }));
  const queued = sampleResult();
  const artifacts = { report_json: JSON.stringify(queued) };
  await new Outbox(join(repo, 'data/outbox')).spoolRun({ runId: queued.run!.id,
    envelope: buildRunEnvelope(queued, artifacts, { level: 'envelope', delivery: { mode: 'direct' } }), artifacts });
  await writeFile(join(repo, 'data/outcomes.jsonl'), '{"synthetic":"preserved precision history"}\n');
  await mkdir(join(repo, '.git/rcl-converge-attempts'));
  await writeFile(join(repo, '.git/rcl-converge-attempts/sentinel.json'), '{"synthetic":"preserved attempt accounting"}\n');
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(repo, { recursive: true, force: true });
});

describe('immutable report-round binding before side effects', () => {
  it.each([2, undefined, '1', 0, 1.5])('refuses report round %s before flushing a valid unrelated outbox item', async round => {
    const report = { run: { id: '00000000-0000-7000-8000-000000000099', converge: { target: 'test', round } }, findings: [sampleFinding()] };
    await writeFile(join(repo, 'report.json'), JSON.stringify(report));
    const before = await snapshot(repo);
    const result = await cli('converge-report', '--target', 'test', '--round', '1', '--report', 'report.json');
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { message: expect.stringMatching(/round/i) } });
    expect(requests).toEqual([]);
    expect(await snapshot(repo)).toEqual(before);
  });

  it('accepts matching descriptor-less evidence and sends only its explicitly requested events', async () => {
    await writeFile(join(repo, 'report.json'), JSON.stringify({ run: { id: '00000000-0000-7000-8000-000000000099',
      converge: { target: 'test', round: 1 } }, findings: [sampleFinding()] }));
    const outboxBefore = await snapshot(join(repo, 'data/outbox'));
    const result = await cli('converge-report', '--target', 'test', '--round', '1', '--report', 'report.json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).findings[0].status).toBe('new');
    expect(requests).toEqual(['POST /api/v1/reviews/converge/events']);
    expect(await snapshot(join(repo, 'data/outbox'))).toEqual(outboxBefore);
    const native = JSON.parse(await readFile(convergeRunStatePath(join(repo, '.git'), 'test'), 'utf8'));
    expect(native.rounds[0].reportBinding).toBeDefined();
  });

  it('refuses fresh verdict assertions from an unverified legacy run binding before all writes', async () => {
    const result = await processRoundReport({ gitCommonDir: join(repo, '.git'), target: 'test', round: 1,
      runId: '00000000-0000-7000-8000-000000000099', findings: [sampleFinding()] });
    const before = await snapshot(repo);
    const verdict = await cli('converge-verdict', '--target', 'test', '--round', '1', '--dismissed', `${result.findings[0]!.identity}=synthetic reason`);
    expect(verdict.code).toBe(3);
    expect(verdict.stderr).toMatch(/bind|evidence|legacy/i);
    expect(requests).toEqual([]);
    expect(await snapshot(repo)).toEqual(before);
  });

  it('keeps an untriaged semantic claim actionable through repeat and empty reports', async () => {
    const findings = [sampleFinding()];
    let firstIdentity: string | undefined;
    for (let round = 1; round <= 3; round++) {
      const id = `00000000-0000-7000-8000-${String(round).padStart(12, '0')}`;
      const rows = round === 3 ? [] : findings.map(f => ({ ...f, identity: `report:${id}:0123456789abcdef`, claimDescriptor: describeClaim(f) }));
      await writeFile(join(repo, 'report.json'), JSON.stringify({ run: { id, converge: { target: 'test', round } }, findings: rows }));
      const result = await cli('converge-report', '--target', 'test', '--round', String(round), '--report', 'report.json');
      expect(result.code).toBe(0);
      const classified = JSON.parse(result.stdout);
      firstIdentity ??= classified.findings[0].identity;
      expect(classified.actionableIdentities).toEqual([firstIdentity]);
      expect(classified.actionableGating).toBe(1);
      if (round === 2) expect(classified.findings[0].status).toBe('repeat');
      if (round === 3) expect(classified.findings).toEqual([]);
    }
  });

  it('accepts a clean semantic follow-up after a source-bound fixed verdict', async () => {
    const id = '00000000-0000-7000-8000-000000000099';
    const finding = sampleFinding();
    await writeFile(join(repo, 'report.json'), JSON.stringify({ run: { id, converge: { target: 'test', round: 1 } },
      findings: [{ ...finding, identity: `report:${id}:0123456789abcdef`, claimDescriptor: describeClaim(finding) }] }));
    const first = await cli('converge-report', '--target', 'test', '--round', '1', '--report', 'report.json');
    expect(first.code).toBe(0);
    const key = JSON.parse(first.stdout).findings[0].identity;
    const fixed = await cli('converge-verdict', '--target', 'test', '--round', '1', '--fixed', key);
    expect(fixed.code).toBe(0);
    expect(JSON.parse(fixed.stdout).resolution.status).toBe('fixes-pending-fresh-round');
    await writeFile(join(repo, 'report.json'), JSON.stringify({ run: { id: '00000000-0000-7000-8000-000000000100',
      converge: { target: 'test', round: 2 } }, findings: [] }));
    const clean = await cli('converge-report', '--target', 'test', '--round', '2', '--report', 'report.json');
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ actionableGating: 0, actionableIdentities: [], findings: [] });
  });

  it('previews legacy migration without flushing or writing and preserves the source on explicit apply', async () => {
    await processRoundReport({ gitCommonDir: join(repo, '.git'), target: 'test', round: 1, findings: [sampleFinding()] });
    const path = convergeRunStatePath(join(repo, '.git'), 'test');
    const original = await readFile(path);
    const before = await snapshot(repo);
    const preview = await cli('converge-migrate', '--target', 'test');
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ status: 'preview', fromVersion: 1, toVersion: 2, sourceSha256: sha(original) });
    expect(await snapshot(repo)).toEqual(before);
    const applied = await cli('converge-migrate', '--target', 'test', '--apply');
    expect(applied.code).toBe(0);
    const receipt = JSON.parse(applied.stdout);
    expect(receipt.status).toBe('migrated');
    expect(await readFile(receipt.snapshotPath)).toEqual(original);
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(2);
    expect(requests).toEqual([]);
    const after = await snapshot(repo);
    expect(after.filter((x: unknown) => (x as string[])[0]!.includes('/data/')))
      .toEqual(before.filter((x: unknown) => (x as string[])[0]!.includes('/data/')));
  });
});
