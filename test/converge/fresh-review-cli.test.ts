import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Outbox } from '../../src/telemetry/outbox.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { sampleResult } from '../telemetry/fixtures.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import type { ReviewCycleReceipt } from '../../src/converge/review-cycle.js';

const cli = process.env.RCL_TEST_PACKAGED_CLI || fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function fixture(work: (f: {
  root: string; run: (args: string[]) => Promise<{ code: number | null; output: string }>;
  calls: () => number; events: any[]; envelopes: any[]; cycles: ReviewCycleReceipt[]; requests: string[];
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rcl-fresh-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  await mkdir(join(root, '.harness-cli'));
  await writeFile(join(root, '.harness-cli/config.json'), '{}');
  await writeFile(join(root, '.review-council.json'), JSON.stringify({ models: ['openai-compat/fixture'], secondaryModels: [], asyncModels: [],
    roles: ['general', 'security-auditor'], harness: { telemetry: 'full' }, gating: { mode: 'all-findings' } }));
  let calls = 0;
  const cycles: ReviewCycleReceipt[] = [], envelopes: any[] = [], events: any[] = [], requests: string[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    const raw = Buffer.concat(parts), path = req.url!;
    requests.push(`${req.method} ${path}`);
    const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (path.startsWith('/github/repos/fixture/repo/compare/')) return answer(200, { files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1,
      patch: '@@ -1 +1 @@\n-export const a = 0;\n+export const a = 1;', sha: head }] });
    if (path === '/github/repos/fixture/repo/pulls/42/files') return answer(200, [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1,
      patch: '@@ -1 +1 @@\n-export const a = 0;\n+export const a = 1;', sha: head }]);
    if (path.startsWith('/github/repos/fixture/repo/pulls/42/files?')) return answer(200, [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1,
      patch: '@@ -1 +1 @@\n-export const a = 0;\n+export const a = 1;', sha: head }]);
    if (path === '/github/repos/fixture/repo/pulls/42') return answer(200, { number: 42, changed_files: 1, labels: [], title: 'Fixture', body: '', html_url: 'https://github.com/fixture/repo/pull/42',
      base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { sha: head, ref: 'fixture', repo: { full_name: 'fixture/repo' } } });
    if (path === '/api/v1/reviews/prs/fixture/repo/42' && req.method === 'GET') return answer(200, { data: {
      repo: 'fixture/repo', pr_number: 42, head: { sha: head, merged: false }, cycle_protocol: 1, active_cycle: cycles.at(-1) ?? null } });
    if (path === '/api/v1/reviews/prs/fixture/repo/42/cycles') {
      const body = JSON.parse(raw.toString());
      const existing = cycles.find(c => c.operation_id === body.operation_id);
      if (existing) return answer(200, { data: existing });
      if (body.previous_cycle_id !== (cycles.at(-1)?.id ?? null)) return answer(409, { message: 'Fresh review refused: cycle_conflict' });
      const cycle = { ...body, id: randomUUID(), inserted_at: new Date().toISOString() };
      cycles.push(cycle); return answer(201, { data: cycle });
    }
    if (path === '/v1/chat/completions') {
      calls++;
      return answer(200, { id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"findings":[]}' } }] });
    }
    if (path === '/api/v1/reviews/runs' && req.method === 'POST') {
      const envelope = JSON.parse(raw.toString()); envelopes.push(envelope);
      return answer(201, { data: { id: envelope.run.id, url: `http://127.0.0.1/runs/${envelope.run.id}`, artifacts_expected: envelope.artifacts_declared.map((a: any) => a.kind) } });
    }
    const artifact = path.match(/^\/api\/v1\/reviews\/runs\/[^/]+\/artifacts\/(report_json|report_md)$/);
    if (artifact && req.method === 'PUT') return answer(201, { data: { kind: artifact[1], sha256: digest(raw) } });
    if (path === '/api/v1/reviews/converge/events') {
      events.push(...JSON.parse(raw.toString()).events);
      return answer(200, { data: { inserted: 1, duplicates: 0 } });
    }
    return answer(404, { error: 'unexpected_fixture_request', path });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const shim = join(root, 'network.mjs');
  await writeFile(shim, `const original = globalThis.fetch; globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === 'https://api.github.com') return original(${JSON.stringify(base)} + '/github' + url.pathname + url.search, options);
    if (url.origin !== ${JSON.stringify(base)}) throw new Error('Unexpected external fixture request: ' + url.origin);
    return original(input, options);
  };`);
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, NODE_NO_WARNINGS: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GITHUB_TOKEN: 'fixture', RCL_NO_HARNESS_KEYS: '1',
    HARNESS_API_URL: base, HARNESS_API_TOKEN: 'fixture', OPENAI_COMPAT_BASE_URL: `${base}/v1`, OPENAI_BASE_URL: `${base}/v1`,
    RCL_DATA_DIR: join(root, 'data'), RCL_TELEMETRY: 'full', RCL_CONVERGE_ROUND: '13', RCL_CONVERGE_ATTEMPT: '17' };
  const run = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', shim, cli, ...args], { cwd: root, env });
    let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture CLI timeout')); }, 30_000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  try { await work({ root, run, calls: () => calls, events, envelopes, cycles, requests }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}

it('runs a bare explicit fresh PR review, retains outputs, binds admission, and preserves its budget on bare continuation', async () => {
  await fixture(async f => {
    const outbox = new Outbox(join(f.root, 'data', 'outbox'));
    const old = buildRunEnvelope(sampleResult(), { report_json: '{}' }, { level: 'full', delivery: { mode: 'direct' } });
    await outbox.spoolRun({ runId: old.run.id, envelope: old, artifacts: { report_json: '{}' } });
    const first = await f.run(['review', 'fixture/repo#42', '--start-over']);
    expect(first.code, first.output).toBe(0);
    expect(f.calls()).toBe(2);
    expect(f.cycles).toHaveLength(1);
    expect(f.envelopes.map(e => e.run.id)).not.toContain(old.run.id);
    expect((await outbox.list()).map(entry => entry.id)).toContain(old.run.id);
    // Later admission commands retain their ordinary startup flush behavior.
    await outbox.remove(old.run.id);
    const directory = join(f.root, '.git', 'rcl-fresh-reports');
    const reportPath = join(directory, (await readdir(directory)).find(p => p.endsWith('.json'))!);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(report.run).toMatchObject({ cycle_id: f.cycles[0].id, converge: { target: 'repo-42', round: 1, attempt: 1 } });
    expect(report.run.converge).not.toHaveProperty('cycleId');
    expect(f.envelopes[0].run.cycle_id).toBe(report.run.cycle_id);
    const admitted = await f.run(['converge-report', '--target', 'repo-42', '--round', '1', '--report', reportPath, '--json']);
    expect(admitted.code, admitted.output).toBe(0);
    expect(await loadConvergeRunState(join(f.root, '.git'), 'repo-42')).toMatchObject({ rounds: [{ round: 1, runId: report.run.id }] });
    const continuation = await f.run(['review', 'fixture/repo#42']);
    expect(continuation.code).not.toBe(0);
    expect(continuation.output).toContain('inputs_unchanged');
    expect(f.calls()).toBe(2);
    expect(f.cycles).toHaveLength(1);
    expect(await loadConvergeAttemptState(join(f.root, '.git'), 'repo-42')).toMatchObject({ cap: 20, attemptsUsed: 1 });
    const next = await f.run(['review', 'fixture/repo#42', '--start-over']);
    expect(next.code, next.output).toBe(0);
    expect(f.calls()).toBe(4);
    expect(f.cycles).toHaveLength(2);
    expect(f.events.filter(e => e.kind === 'attempt_claimed').map(e => e.payload)).toEqual(
      f.cycles.map(cycle => ({ attempt: 1, cap: 20, cycle_id: cycle.id }))
    );
    const oldAdmission = await f.run(['converge-report', '--target', 'repo-42', '--round', '1', '--report', reportPath]);
    expect(oldAdmission.output).toContain('review_cycle_mismatch');
    expect(await loadConvergeAttemptState(join(f.root, '.git'), 'repo-42')).toMatchObject({ attemptsUsed: 1, cycle: { history: { attempts: 1, rounds: 1 } } });
    if (process.env.RCL_TEST_EVIDENCE_DIR) {
      const destination = process.env.RCL_TEST_EVIDENCE_DIR;
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await writeFile(join(destination, 'cycles.json'), JSON.stringify(f.cycles));
      await writeFile(join(destination, 'events.json'), JSON.stringify({ events: f.events }));
      for (const [i, envelope] of f.envelopes.entries()) {
        await writeFile(join(destination, `envelope-${i + 1}.json`), JSON.stringify(envelope));
      }
      for (const path of await readdir(directory)) {
        if (path.endsWith('.json')) {
          const bytes = await readFile(join(directory, path));
          const saved = JSON.parse(bytes.toString());
          await writeFile(join(destination, `${saved.run.id}.json`), bytes);
        }
      }
    }
  });
}, 60_000);
