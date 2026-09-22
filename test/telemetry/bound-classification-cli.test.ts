import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describeClaim } from '../../src/consensus/claim-identity.js';
import { convergeRunStatePath, processRoundReport } from '../../src/converge/run-state.js';
import { migrateConvergeState } from '../../src/converge/semantic-state.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';
import type { WireEvent } from '../../src/telemetry/events.js';
import { sampleFinding, sampleResult } from './fixtures.js';

const entrypoint = process.env['RCL_TEST_PACKAGED_CLI'] || fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const packaged = Boolean(process.env['RCL_TEST_PACKAGED_CLI']);
const tsx = import.meta.resolve('tsx');
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const target = 'synthetic-bound-loop';
let repo: string;
let env: NodeJS.ProcessEnv;
let server: Server;
let events: WireEvent[];

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'rcl-bound-classification-'));
  events = [];
  server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const input = body ? JSON.parse(body) : {};
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [], meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } }));
    } else {
      events.push(...input.events);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { inserted: input.events.length, duplicates: 0 } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  env = { PATH: process.env['PATH'],
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: join(repo, 'config'), RCL_DATA_DIR: join(repo, 'data'),
    HARNESS_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    HARNESS_API_TOKEN: 'synthetic-bound-classification-token', RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1' };
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  await mkdir(join(repo, '.harness-cli'));
  await writeFile(join(repo, '.harness-cli/config.json'), '{}');
  await writeFile(join(repo, '.review-council.json'), JSON.stringify({ harness: { telemetry: 'envelope' } }));
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(repo, { recursive: true, force: true });
});

async function admit(round: number, findings: ConsensusFinding[]) {
  const report = sampleResult({ findings, belowThresholdFindings: [] });
  report.run!.id = `00000000-0000-7000-8000-${String(round).padStart(12, '0')}`;
  report.run!.converge = { target, round };
  report.findings = report.findings.map((finding, i) => finding.claimDescriptor
    ? { ...finding, identity: `report:${report.run!.id}:${String(i + 1).padStart(16, '0')}` }
    : finding);
  const raw = JSON.stringify(report);
  const path = join(repo, `round-${round}.json`);
  await writeFile(path, raw);
  const args = [entrypoint, 'converge-report', '--target', target, '--round', String(round), '--report', path, '--json'];
  const output = await promisify(execFile)(process.execPath, packaged ? args : ['--import', tsx, ...args], { cwd: repo, env, timeout: 15_000 });
  expect(await readFile(path, 'utf8')).toBe(raw);
  return { output: JSON.parse(output.stdout), event: events.at(-1)!, digest: digest(raw) };
}

describe('bound round producer integration', () => {
  it('emits exact immutable bindings for first, repeated and empty semantic rounds while keeping the claim pending', async () => {
    const claim = sampleFinding();
    claim.claimDescriptor = describeClaim(claim);
    const first = await admit(1, [claim]);
    const repeated = await admit(2, [{ ...claim, identity: 'report-second-sighting' }]);
    const empty = await admit(3, []);
    for (const [i, result] of [first, repeated, empty].entries()) {
      expect(result.output.actionableGating).toBe(1);
      expect(result.event).toMatchObject({ kind: 'round_processed', converge_target: target, round: i + 1,
        payload: { classification_version: 1, report_json_sha256: result.digest, actionable_gating: 1 } });
      expect(result.event.payload).not.toHaveProperty('legacy_pending_identities');
      expect(JSON.stringify(result.event)).not.toContain(repo);
    }
    expect(first.event.payload.identities).toMatchObject([{ status: 'new', pending_round: 1 }]);
    expect(repeated.event.payload.identities).toMatchObject([{ status: 'repeat', version: 1, finding_ref: 'f001', pending_round: 2 }]);
    expect(empty.event.payload.identities).toEqual([]);
  });

  it.each([false, true])('preserves the round-time pending snapshot when an old dismissal is delayed=%s', async delayed => {
    const claim = sampleFinding();
    claim.claimDescriptor = describeClaim(claim);
    const first = await admit(1, [claim]);
    const key = first.output.findings[0].identity;
    const dismiss = async () => {
      const args = [entrypoint, 'converge-verdict', '--target', target, '--round', '1',
        '--dismissed', `${key}=synthetic source-backed disposition`, '--json'];
      await promisify(execFile)(process.execPath, packaged ? args : ['--import', tsx, ...args], { cwd: repo, env, timeout: 15_000 });
    };
    if (!delayed) await dismiss();
    const repeated = await admit(2, [claim]);
    const captured = JSON.stringify(repeated.event);
    expect(repeated.event.payload.identities).toMatchObject([{ pending_round: delayed ? 2 : null }]);
    if (delayed) await dismiss();
    const empty = await admit(3, []);
    expect(empty.output.actionableGating).toBe(delayed ? 1 : 0);
    expect(empty.event.payload.actionable_gating).toBe(delayed ? 1 : 0);
    expect(JSON.stringify(repeated.event)).toBe(captured);
  }, 15_000);

  it('makes pending migrated legacy claims explicit on an empty semantic round without fabricating sightings', async () => {
    const original = await processRoundReport({ gitCommonDir: join(repo, '.git'), target, round: 1, findings: [sampleFinding()] });
    const path = convergeRunStatePath(join(repo, '.git'), target);
    const before = await readFile(path, 'utf8');
    const preview = await migrateConvergeState({ gitCommonDir: join(repo, '.git'), target });
    expect(preview.sourceSha256).toBe(digest(before));
    const migration = await migrateConvergeState({ gitCommonDir: join(repo, '.git'), target, apply: true });
    expect(await readFile(migration.snapshotPath!, 'utf8')).toBe(before);
    const result = await admit(2, []);
    expect(result.output.actionableGating).toBe(1);
    expect(result.event.payload).toMatchObject({ classification_version: 1, report_json_sha256: result.digest,
      identities: [], legacy_pending_identities: [original.findings[0]!.identity] });
  });

  it('keeps descriptor-less legacy rounds outside the new protocol', async () => {
    const result = await admit(1, [sampleFinding()]);
    expect(result.event.payload).not.toHaveProperty('classification_version');
    expect(result.event.payload).not.toHaveProperty('report_json_sha256');
  });
});
