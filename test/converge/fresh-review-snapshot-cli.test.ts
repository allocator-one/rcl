import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { ReviewCycleReceipt } from '../../src/converge/review-cycle.js';
import { prSnapshotFrom, writePrSnapshot } from '../../src/converge/pr-snapshot.js';

const cli = process.env.RCL_TEST_PACKAGED_CLI || fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

// A grid host's reviewer: GitHub answers nothing without credentials, and the
// review process holds none (RCL-216). Adapted from fresh-review-cli.test.ts.
async function fixture(work: (f: {
  root: string; run: (args: string[], extraEnv?: Record<string, string>) => Promise<{ code: number | null; output: string }>;
  base: string; head: string;
  calls: () => number; events: any[]; envelopes: any[]; cycles: ReviewCycleReceipt[]; requests: string[];
  setStatusHead: (headSha: string) => void; advanceHead: () => string;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rcl-fresh-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, 'a.ts'), 'export const a = 0;\n'); git('add', '.'); git('commit', '-qm', 'base');
  const mergeBase = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  let head = git('rev-parse', 'HEAD');
  let statusHead = head;
  const setStatusHead = (headSha: string) => { statusHead = headSha; };
  const advanceHead = () => { git('commit', '--allow-empty', '-qm', 'next fixture head'); head = git('rev-parse', 'HEAD'); return head; };
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
    if (path.startsWith('/github/') && req.headers.authorization === undefined) return (res.writeHead(401, { 'content-type': 'application/json' }), res.end('{"message":"Requires authentication"}'));
    const answer = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (path.startsWith('/github/repos/fixture/repo/compare/')) return answer(200, { merge_base_commit: { sha: mergeBase }, files: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1,
      patch: '@@ -1 +1 @@\n-export const a = 0;\n+export const a = 1;', sha: head }] });
    if (path === '/github/repos/fixture/repo/pulls/42/files') return answer(200, [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1,
      patch: '@@ -1 +1 @@\n-export const a = 0;\n+export const a = 1;', sha: head }]);
    if (path.startsWith('/github/repos/fixture/repo/pulls/42/files?')) return answer(200, [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1,
      patch: '@@ -1 +1 @@\n-export const a = 0;\n+export const a = 1;', sha: head }]);
    if (path === '/github/repos/fixture/repo/pulls/42') return answer(200, { number: 42, changed_files: 1, labels: [], title: 'Fixture', body: '', html_url: 'https://github.com/fixture/repo/pull/42', merged: false, state: 'open',
      base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'fixture/repo' } }, head: { sha: head, ref: 'fixture', repo: { full_name: 'fixture/repo' } } });
    if (path === '/api/v1/reviews/prs/fixture/repo/42' && req.method === 'GET') return answer(200, { data: {
      repo: 'fixture/repo', pr_number: 42, head: { sha: statusHead, merged: false }, cycle_protocol: 1, active_cycle: cycles.at(-1) ?? null } });
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
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', RCL_NO_HARNESS_KEYS: '1',
    HARNESS_API_URL: base, HARNESS_API_TOKEN: 'fixture', OPENAI_COMPAT_BASE_URL: `${base}/v1`, OPENAI_BASE_URL: `${base}/v1`,
    RCL_DATA_DIR: join(root, 'data'), RCL_TELEMETRY: 'full', RCL_CONVERGE_ROUND: '13', RCL_CONVERGE_ATTEMPT: '17' };
  const run = (args: string[], extraEnv: Record<string, string> = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', shim, cli, ...args], { cwd: root, env: { ...env, ...extraEnv } });
    let output = ''; child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture CLI timeout')); }, 30_000);
    child.on('error', reject); child.on('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  try { await work({ root, run, base: mergeBase, head, calls: () => calls, events, envelopes, cycles, requests, setStatusHead, advanceHead }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}


async function capturedPatch(root: string, base: string, head: string): Promise<string> {
  const path = join(root, 'review.patch');
  await writeFile(path, execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', `${base}..${head}`],
    { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }));
  return path;
}

it('refuses a fresh review of a captured patch when the reviewer can read neither GitHub nor a snapshot', async () => {
  await fixture(async f => {
    const patch = await capturedPatch(f.root, f.base, f.head);
    const refused = await f.run(['review', patch, '--start-over', '--for-pr', 'fixture/repo#42', '--head-sha', f.head, '--base-sha', f.base]);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('fresh_review_github_unavailable');
    expect(f.cycles).toHaveLength(0);
  });
}, 60_000);

it('starts a fresh review of a captured patch from a parent\'s PR snapshot, without GitHub credentials', async () => {
  await fixture(async f => {
    const patch = await capturedPatch(f.root, f.base, f.head);
    const snapshot = join(f.root, 'pr.json');
    await writePrSnapshot(snapshot, prSnapshotFrom('fixture/repo', 42, { head: { sha: f.head }, base: { sha: f.base, ref: 'main' }, merged: false, state: 'open' }));

    const fresh = await f.run(['review', patch, '--start-over', '--for-pr', 'fixture/repo#42', '--head-sha', f.head, '--base-sha', f.base,
      '--pr-snapshot', snapshot]);

    expect(fresh.code, fresh.output).toBe(0);
    expect(f.cycles).toHaveLength(1);
    expect(f.cycles[0]!.head_sha).toBe(f.head);
    expect(f.requests.filter(request => request.includes(' /github/'))).toEqual([]);
  });
}, 60_000);

it('refuses a snapshot taken at another head', async () => {
  await fixture(async f => {
    const patch = await capturedPatch(f.root, f.base, f.head);
    const snapshot = join(f.root, 'pr.json');
    await writePrSnapshot(snapshot, prSnapshotFrom('fixture/repo', 42, { head: { sha: 'e'.repeat(40) }, base: { sha: f.base, ref: 'main' }, merged: false, state: 'open' }));
    const refused = await f.run(['review', patch, '--start-over', '--for-pr', 'fixture/repo#42', '--head-sha', f.head, '--base-sha', f.base,
      '--pr-snapshot', snapshot]);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain('fresh_review_head_changed');
    expect(f.cycles).toHaveLength(0);
  });
}, 60_000);

it('captures the snapshot in a parent that holds GitHub credentials', async () => {
  await fixture(async f => {
    const out = join(f.root, 'captured.json');
    const captured = await f.run(['pr-snapshot', 'fixture/repo#42', '--out', out, '--json'], { GITHUB_TOKEN: 'fixture' });
    expect(captured.code, captured.output).toBe(0);
    const written = JSON.parse(await readFile(out, 'utf8'));
    expect(written).toMatchObject({ kind: 'rcl-pr-snapshot', repo: 'fixture/repo', prNumber: 42, headSha: f.head, merged: false, state: 'open' });
    expect(JSON.parse(captured.output).sha256).toBe(digest(await readFile(out)));
  });
}, 60_000);
