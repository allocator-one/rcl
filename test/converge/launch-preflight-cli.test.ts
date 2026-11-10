import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { inspectRoundLiveness } from '../../src/converge/round-liveness.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { Outbox } from '../../src/telemetry/outbox.js';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each([
  { guarded: true, queuedTelemetry: false },
  { guarded: false, queuedTelemetry: false },
  { guarded: true, queuedTelemetry: true },
])('acknowledges preflight and retains a completed --for-pr launch (%j)', async ({ guarded, queuedTelemetry }) => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'rcl-preflight-')));
  const common = join(repo, '.git'), target = 'rcl-42', head = 'a'.repeat(40);
  const configStarted = signal(), releaseConfig = signal(), councilStarted = signal(), releaseCouncil = signal();
  let telemetryCalls = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/api/')) {
      telemetryCalls++;
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ inserted: 1, duplicates: 0 }));
    } else if (request.url === '/config') {
      configStarted.resolve();
      await releaseConfig.promise;
      response.end(JSON.stringify({ models: ['openai-compat/fixture'], roles: ['general', 'security-auditor'],
        secondaryModels: [], asyncModels: [], harness: { telemetry: 'off' } }));
    } else {
      request.resume();
      councilStarted.resolve();
      await releaseCouncil.promise;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"findings":[]}' } }] }));
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let child: ReturnType<typeof spawn> | undefined;
  let result: Promise<number | null> | undefined;
  let diagnostics = '';
  try {
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    execFileSync('git', ['init', '-q'], { cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice } });
    const outbox = new Outbox(join(repo, 'data', 'outbox'));
    let queuedEntry: string | undefined;
    if (queuedTelemetry) {
      await mkdir(join(repo, '.harness-cli'));
      await writeFile(join(repo, '.harness-cli', 'config.json'), '{}');
      await writeFile(join(repo, '.review-council.json'), JSON.stringify({ harness: { telemetry: 'full' } }));
      queuedEntry = await outbox.spoolEvents([buildEvent({ kind: 'loss', payload: { reason: 'fixture' } })]);
    }
    await writeFile(join(repo, 'config.mjs'), `export default await (await fetch(${JSON.stringify(origin + '/config')})).json();`);
    await writeFile(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
    const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
    child = spawn(process.execPath, [entry, 'review', 'change.patch', ...(guarded ? ['--guarded-converge'] : []),
      '--converge-target', target, '--for-pr', 'allocator-one/rcl#42', '--head-sha', head, '--base-sha', 'b'.repeat(40),
      '--config', 'config.mjs', ...(queuedTelemetry ? [] : ['--no-telemetry']), '--json-file', 'report.json'], {
      cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '1', RCL_NO_HARNESS_KEYS: '1',
        RCL_DATA_DIR: join(repo, 'data'), XDG_CONFIG_HOME: join(repo, 'config'),
        HARNESS_API_TOKEN: queuedTelemetry ? 'synthetic-fixture' : '', HARNESS_API_URL: queuedTelemetry ? origin : '',
        RCL_TELEMETRY: '', GITHUB_TOKEN: '', GH_TOKEN: '',
        RCL_CONVERGE_TARGET: '', RCL_CONVERGE_ROUND: '', RCL_CONVERGE_ATTEMPT: '', RCL_FOR_PR: '',
        ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
        OPENAI_COMPAT_BASE_URL: origin + '/v1', OPENAI_BASE_URL: origin + '/v1',
        OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '',
      },
    });
    child.stdout!.on('data', bytes => { diagnostics += bytes.toString(); });
    child.stderr!.on('data', bytes => { diagnostics += bytes.toString(); });
    result = new Promise((done, reject) => { child!.once('exit', done); child!.once('error', reject); });
    await Promise.race([configStarted.promise, result.then(() => { throw new Error(diagnostics); })]);
    if (queuedTelemetry) {
      expect(telemetryCalls).toBe(0);
      expect((await outbox.list()).map(entry => entry.id)).toContain(queuedEntry);
    }
    expect(await inspectRoundLiveness({ gitCommonDir: common, target, headSha: head, lockTimeoutMs: 500 }))
      .toMatchObject({ status: 'launching', action: 'wait' });
    expect(await loadConvergeAttemptState(common, target)).toBeUndefined();
    releaseConfig.resolve();
    await Promise.race([councilStarted.promise, result.then(() => { throw new Error(diagnostics); })]);
    expect(await inspectRoundLiveness({ gitCommonDir: common, target, headSha: head, lockTimeoutMs: 500 }))
      .toMatchObject({ status: 'running', action: 'wait', launch: { attempt: 1, round: 1, headSha: head } });
    releaseCouncil.resolve();
    expect(await result, diagnostics).toBe(0);
    const report = JSON.parse(await readFile(join(repo, 'report.json'), 'utf8'));
    expect(report.run.target).toMatchObject({ kind: 'patch', repo: 'allocator-one/rcl', pr_number: 42, head_sha: head });
    expect((await loadConvergeRunState(common, target))?.lastLaunch)
      .toMatchObject({ status: 'completed', runId: report.run.id, headSha: head, attempt: 1, round: 1 });
    expect(await inspectRoundLiveness({ gitCommonDir: common, target, headSha: head }))
      .toMatchObject({ status: 'completed', action: 'process_report', launch: { runId: report.run.id } });
    if (queuedTelemetry) {
      expect((await outbox.list()).map(entry => entry.id)).toContain(queuedEntry);
    }
  } finally {
    releaseConfig.resolve(); releaseCouncil.resolve();
    if (result) await result;
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await rm(repo, { recursive: true, force: true });
  }
}, 30_000);
