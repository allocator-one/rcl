import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function event(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function successfulStream(): string {
  return [
    event('message_start', { message: { id: 'msg_provider_cap', type: 'message', role: 'assistant',
      model: 'claude-fable-5-1', content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: {
      type: 'tool_use', id: 'tool_provider_cap', name: 'report_findings', input: {},
    } }),
    event('content_block_delta', { index: 0, delta: {
      type: 'input_json_delta', partial_json: '{"findings":[]}',
    } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 8 } }),
    event('message_stop', {}),
  ].join('');
}

function run(args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...env, RCL_NO_HARNESS_KEYS: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI timed out')); }, 30_000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timer); resolve({ status, stderr }); });
  });
}

describe('review CLI provider concurrency defaults', () => {
  it('applies the version-owned Anthropic cap when project config has no provider override', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rcl-provider-cap-cli-'));
    directories.push(directory);
    await writeFile(join(directory, 'change.patch'),
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n');
    const roles = ['role-one', 'role-two', 'role-three'];
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      models: ['anthropic/claude-fable-5-1'], secondaryModels: [], asyncModels: [], roles,
      customRoles: roles.map(name => ({ name, systemPrompt: `Review as ${name}.`, focus: ['correctness'] })),
      concurrency: 9, quorumFraction: 1, timeout: 5_000, maxRetries: 0,
      harness: { telemetry: 'off' },
    }));

    let active = 0;
    let peak = 0;
    let calls = 0;
    const server = createServer((request, response) => {
      request.resume();
      calls++;
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(successfulStream());
        active--;
      }, 75);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const reviewerArgs = roles.flatMap(role => [
        '--reviewer', `anthropic/claude-fable-5-1:${role}`,
      ]);
      const result = await run([
        'review', 'change.patch', '--config', 'config.json', ...reviewerArgs,
        '--json-file', 'report.json', '--no-telemetry',
      ], directory, {
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        RCL_DATA_DIR: join(directory, 'rcl-data'),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('concurrency 9 → 2 wave(s)');
      expect(calls).toBe(3);
      expect(peak).toBe(2);
      const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')) as {
        reviews: Array<{ status: string }>;
      };
      expect(report.reviews.map(review => review.status)).toEqual(['success', 'success', 'success']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 40_000);
});
