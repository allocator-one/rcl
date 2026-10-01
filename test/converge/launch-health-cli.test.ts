import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asyncTargetKey, resolveAsyncStoreDir, runAsyncWorker, spoolAsyncCalls } from '../../src/dispatch/async-lane.js';
import { loadConvergeRunState, convergeRunStatePath } from '../../src/converge/run-state.js';
import { loadConvergeAttemptState, convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { sha256Hex } from '../../src/report/run-header.js';
import { guardedInputSha256 } from '../../src/report/run-header.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';

const entry = process.env['RCL_TEST_PACKAGED_CLI'] || fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture(work: (f: { dir: string; common: string; args: string[]; calls: () => number;
  run: (args: string[], overrides?: Record<string, string>) => Promise<{ status: number | null; stderr: string }> }) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-launch-health-cli-')));
  directories.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  await writeFile(join(dir, 'a.ts'), 'a\n'); git('add', '.'); git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD').trim();
  const patch = join(dir, 'review.patch');
  await writeFile(patch, 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
  await writeFile(join(dir, 'config.json'), JSON.stringify({ models: ['openai-compat/m0'], secondaryModels: [],
    asyncModels: ['openai-compat/async'], concurrency: 17, maxRetries: 0, timeout: 2000,
    gating: { mode: 'all-findings' }, harness: { telemetry: 'off' } }));
  const store = await resolveAsyncStoreDir(dir);
  const [spool] = await spoolAsyncCalls([{ model: 'openai-compat/async', role: 'general', provider: 'openai-compat',
    systemPrompt: 'fixture', userPrompt: 'fixture' }], {
    storeDir: store, targetKey: asyncTargetKey(patch, 'health-fixture'), timeoutMs: 1000, maxRetries: 0,
  });
  await runAsyncWorker(spool!, () => ({ name: 'fixture', provider: 'openai-compat',
    review: async (model, role) => ({ model, role, provider: 'openai-compat', status: 'success', findings: [], durationMs: 1 }),
    ask: async () => { throw new Error('unused'); },
  }));
  let calls = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', chunk => { body += chunk; });
    request.on('end', () => {
      calls++;
      const { model } = JSON.parse(body) as { model: string };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 0, model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
          content: Number(model.slice(1)) < 11 ? '{"findings":[]}' : 'invalid reviewer output' } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  const env = { PATH: process.env['PATH'], TMPDIR: process.env['TMPDIR'], HOME: dir, XDG_CONFIG_HOME: dir,
    RCL_DATA_DIR: join(dir, 'data'), RCL_NO_HARNESS_KEYS: '1', RCL_TELEMETRY: 'off',
    OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${address.port}/v1` };
  const run = (args: string[], overrides: Record<string, string> = {}) => new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: dir, env: { ...env, ...overrides }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('fixture CLI timeout')); }, 20_000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timeout); resolve({ status, stderr }); });
  });
  try {
    await work({ dir, common: join(dir, '.git'), calls: () => calls, run,
      args: ['review', patch, '--guarded-converge', '--converge-target', 'health-fixture', '--head-sha', head,
        '--base-sha', head, '--config', 'config.json', '--json-file', 'report.json', '--no-telemetry',
        ...Array.from({ length: 17 }, (_, i) => ['--reviewer', `openai-compat/m${i}:general`]).flat()] });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('ordinary launch health through the public CLI', () => {
  it('previews an ordinary dead-owner package without mutating state or invoking providers', async () => {
    await fixture(async f => {
      const input = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dir, encoding: 'utf8' }).trim(),
        kind: 'patch', repo: 'allocator-one/rcl', pr: 1, diff: 'a'.repeat(64), config: 'b'.repeat(64),
        roster: [{ model: 'openai-compat/async', role: 'general', provider: 'openai-compat', lane: 'async' }],
        prompts: [], asyncRoles: [{ name: 'general' }], spec: { source: 'flag', sha256: 'c'.repeat(64) } };
      const inputSha256 = guardedInputSha256(input);
      await guardReviewLaunch({ gitCommonDir: f.common, target: 'health-fixture', headSha: input.head,
        inputSha256, maxAttempts: 20, maxRounds: 15, validate: async () => {},
        run: async () => ({ runId: '018f21b4-bf80-7fd5-8000-000000000001', reportJsonSha256: 'd'.repeat(64), successfulReviews: 1, totalReviews: 1, deliveryPending: false }) });
      const nativePath = convergeRunStatePath(f.common, 'health-fixture');
      const native = JSON.parse(await readFile(nativePath, 'utf8'));
      native.lastLaunch.status = 'pending'; native.lastLaunch.pid = 987_654;
      delete native.lastLaunch.runId; delete native.lastLaunch.reportJsonSha256; delete native.lastLaunch.successfulReviews;
      delete native.lastLaunch.totalReviews; delete native.lastLaunch.deliveryPending;
      await writeFile(nativePath, JSON.stringify(native));
      const store = await resolveAsyncStoreDir(f.dir);
      const asyncPath = join(store, (await readdir(store)).find(name => name.startsWith('result-'))!);
      const asyncBytes = await readFile(asyncPath), asyncSha = sha256Hex(asyncBytes);
      const pkg = { target: 'health-fixture', headSha: input.head, baseSha: input.head, attempt: 1, round: 1, pid: 987_654,
        retainedAsyncSha256: [asyncSha], retainedAsync: [{ sha256: asyncSha, model: 'openai-compat/async', role: 'general', provider: 'openai-compat', lane: 'async' }], guardedInput: input };
      await writeFile(join(f.dir, 'ordinary.json'), JSON.stringify(pkg));
      await writeFile(join(f.dir, 'config.json'), JSON.stringify({ models: ['openai-compat/m0'], secondaryModels: [],
        asyncModels: ['openai-compat/async'], concurrency: 17, maxRetries: 0, timeout: 2000,
        gating: { mode: 'all-findings' }, harness: { telemetry: 'full' } }));
      await mkdir(join(f.dir, '.harness-cli'), { recursive: true });
      await writeFile(join(f.dir, '.harness-cli', 'config.json'), JSON.stringify({ team: 'RCL' }));
      const attemptPath = convergeAttemptStatePath(f.common, 'health-fixture');
      const before = [await readFile(nativePath), await readFile(attemptPath), asyncBytes];
      const args = f.args.filter(arg => arg !== '--no-telemetry').concat(['--resume-pending', '--ordinary-pending-package', 'ordinary.json', '--preview-pending', '--resume-async-sha256', asyncSha, '--retry-reason', 'dead owner', '--max-attempts', '20', '--evidence-required']);
      const result = await f.run(args, { RCL_TELEMETRY: 'full', HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN', HARNESS_API_URL: 'http://127.0.0.1:1' });
      expect(result.status, result.stderr).toBe(0); expect(f.calls()).toBe(0);
      expect([await readFile(nativePath), await readFile(attemptPath), await readFile(asyncPath)]).toEqual(before);
      pkg.baseSha = 'e'.repeat(40); await writeFile(join(f.dir, 'ordinary.json'), JSON.stringify(pkg));
      expect((await f.run(args, { RCL_TELEMETRY: 'full', HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN', HARNESS_API_URL: 'http://127.0.0.1:1' })).status).not.toBe(0);
      expect([await readFile(nativePath), await readFile(attemptPath), await readFile(asyncPath)]).toEqual(before);
    });
  }, 30_000);
  it('keeps aggregate 12/18 informational and records only 11/17 complete blocking seats', async () => {
    await fixture(async f => {
      const result = await f.run(f.args);
      expect(result.status, result.stderr).toBe(0);
      expect(f.calls()).toBe(17);
      const report = JSON.parse(await readFile(join(f.dir, 'report.json'), 'utf8'));
      expect(report.stats).toMatchObject({ successfulReviews: 12, totalReviews: 18 });
      const state = await loadConvergeRunState(f.common, 'health-fixture');
      expect(state?.lastLaunch).toMatchObject({ successfulReviews: 12, totalReviews: 18,
        reviewerHealth: { version: 1, policy: { version: 1, fraction: 2 / 3, seatCount: 17, minimumSuccessful: 12 }, successfulSeats: 11 } });
    });
  }, 30_000);

  it('audits an exact legacy report on one new claim without admission or history reset', async () => {
    await fixture(async f => {
      expect((await f.run(f.args)).status).toBe(0);
      const statePath = convergeRunStatePath(f.common, 'health-fixture');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      // Synthetic historical writer with its supported producer version. Old
      // releases recorded aggregate counts and did not persist reviewerHealth.
      const legacyReport = JSON.parse(await readFile(join(f.dir, 'report.json'), 'utf8'));
      legacyReport.run.rcl_version = '4.1.12';
      const legacyBytes = JSON.stringify(legacyReport);
      await writeFile(join(f.dir, 'report.json'), legacyBytes);
      delete state.lastLaunch.reviewerHealth;
      state.lastLaunch.successfulReviews = 12; state.lastLaunch.totalReviews = 18;
      state.lastLaunch.reportJsonSha256 = sha256Hex(legacyBytes);
      await writeFile(statePath, JSON.stringify(state));
      const before = await loadConvergeAttemptState(f.common, 'health-fixture');
      const reportBytes = await readFile(join(f.dir, 'report.json'));
      const retry = [...f.args, '--json-file', 'retry.json', '--retry-reason', 'Original provider failure inspected; bounded retry.',
        '--retry-report', 'report.json'];
      const result = await f.run(retry);
      expect(result.status, result.stderr).toBe(0);
      expect(f.calls()).toBe(34);
      const after = await loadConvergeAttemptState(f.common, 'health-fixture');
      expect(after).toMatchObject({ attemptsUsed: 2, cap: 20 });
      expect(after?.attempts.slice(0, 1)).toEqual(before?.attempts);
      expect(after?.attempts[1]).toMatchObject({ retrySource: { version: 1, runId: state.lastLaunch.runId,
        reportJsonSha256: state.lastLaunch.reportJsonSha256,
        reviewerHealth: { policy: { seatCount: 17, minimumSuccessful: 12 }, successfulSeats: 11 } } });
      expect((await loadConvergeRunState(f.common, 'health-fixture'))?.rounds).toEqual([]);
      expect(await readFile(join(f.dir, 'report.json'))).toEqual(reportBytes);
      expect(await readFile(join(f.common, 'rcl-converge-attempts', 'sources', state.lastLaunch.reportJsonSha256))).toEqual(reportBytes);
      const replay = await f.run([...retry, '--json-file', 'replay.json']);
      expect(replay.status).toBe(1);
      expect(f.calls()).toBe(34);
      expect((await loadConvergeAttemptState(f.common, 'health-fixture'))?.attemptsUsed).toBe(2);
    });
  }, 30_000);
});
