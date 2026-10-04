import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_TIMER_DELAY_MS } from '../../src/config/schema.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';

// Match review-cli.test.ts: global setup builds the executable, and package
// verification may explicitly select the installed artifact instead.
const entrypoint = process.env['RCL_TEST_PACKAGED_CLI'] || process.env['RCL_TEST_REVIEW_ENTRYPOINT'] ||
  fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const nodeArgs = /\.(?:[cm]?ts|tsx)$/.test(entrypoint)
  ? ['--import', import.meta.resolve('tsx'), entrypoint] : [entrypoint];
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

describe('review CLI timer validation before guarded launch', () => {
  it.each(['timeout', 'asyncTimeout'] as const)('refuses oversized %s before claim or provider work', async field => {
    const cwd = mkdtempSync(join(tmpdir(), 'rcl-timer-preclaim-'));
    let providerCalls = 0;
    const server = createServer((_request, response) => {
      providerCalls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"findings":[]}' } }] }));
    });
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice } });
      git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
      writeFileSync(join(cwd, 'a.ts'), 'a\n');
      git('add', '.'); git('commit', '-qm', 'fixture');
      const head = git('rev-parse', 'HEAD').trim();
      const common = join(cwd, '.git');
      const nativeFilesBefore = readdirSync(common).sort();
      writeFileSync(join(cwd, 'change.patch'),
        'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
      writeFileSync(join(cwd, 'config.json'), JSON.stringify({
        models: ['openai-compat/fixture'], secondaryModels: [], asyncModels: ['openai-compat/async-fixture'],
        roles: ['general', 'security-auditor'], harness: { telemetry: 'off' },
        timeout: 1000, asyncTimeout: 1000, maxRetries: 0, [field]: MAX_TIMER_DELAY_MS + 1,
      }));
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [...nodeArgs, 'review', 'change.patch', '--guarded-converge',
          '--converge-target', 'timer-preclaim', '--head-sha', head, '--base-sha', head,
          '--json-file', 'report.json', '--config', 'config.json', '--no-telemetry'], {
          cwd, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_NO_WARNINGS: '1', RCL_NO_HARNESS_KEYS: '1',
            RCL_DATA_DIR: join(cwd, 'rcl-data'), RCL_FOR_PR: '', RCL_CONVERGE_TARGET: '',
            RCL_CONVERGE_ROUND: '', RCL_CONVERGE_ATTEMPT: '',
            ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
            ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '', OPENROUTER_API_KEY: '',
            OPENAI_COMPAT_API_KEY: 'local-fixture', OPENAI_COMPAT_BASE_URL: endpoint, OPENAI_BASE_URL: endpoint },
        });
        let stdout = '', stderr = '';
        child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
        child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
        const timer = setTimeout(() => {
          child.kill('SIGKILL'); reject(new Error('Timer preclaim CLI fixture exceeded 15 seconds'));
        }, 15_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
      });

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('Invalid config');
      expect(result.stderr).toContain(field);
      expect(providerCalls).toBe(0);
      expect(await loadConvergeAttemptState(common, 'timer-preclaim')).toBeUndefined();
      expect(await loadConvergeRunState(common, 'timer-preclaim')).toBeUndefined();
      // No async spool or native claim directory was created either: detached
      // work cannot hide behind a callback that has not reached the server yet.
      expect(readdirSync(common).sort()).toEqual(nativeFilesBefore);
      expect(existsSync(join(cwd, 'report.json'))).toBe(false);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
