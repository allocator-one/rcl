import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { sha256Hex } from '../../src/report/run-header.js';

const legacyCli = process.env['RCL_TEST_LEGACY_CLI'] ||
  fileURLToPath(new URL('../../node_modules/review-council-legacy412/dist/index.js', import.meta.url));
const candidateCli = process.env['RCL_TEST_PACKAGED_CLI'] ||
  fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function cli(entry: string, args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('cross-version CLI timed out')); }, 45_000);
    child.on('error', reject);
    child.on('close', status => { clearTimeout(timeout); resolve({ status, stdout, stderr }); });
  });
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-legacy-cross-version-')));
  directories.push(dir);
  const gitEnv = { PATH: process.env['PATH'], GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
  git('add', 'a.ts');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD');
  await writeFile(join(dir, 'change.patch'),
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n');
  await writeFile(join(dir, 'context.md'), 'The constant must remain one.\n');
  const roles = Array.from({ length: 14 }, (_, index) => `synthetic-role-${index + 1}`);
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    models: Array.from({ length: 10 }, (_, index) => `openai-compat/b${index + 1}`),
    secondaryModels: Array.from({ length: 4 }, (_, index) => `openai-compat/s${index + 1}`),
    asyncModels: [], roles, customRoles: roles.map(name => ({
      name, systemPrompt: `You review as ${name}.`, focus: ['correctness'],
    })),
    quorumFraction: 2 / 3, maxRetries: 0, timeout: 3000,
    gating: { mode: 'all-findings' }, harness: { telemetry: 'off' },
  }));

  const calls: string[] = [];
  const delayed: ServerResponse[] = [];
  let releaseFailures = false;
  let successes = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const { model } = JSON.parse(body) as { model: string };
      calls.push(model);
      // The OpenAI-compatible request carries the provider-local model name.
      const failing = !releaseFailures && /^b(?:7|8|9|10)$/.test(model);
      if (failing) {
        delayed.push(response);
        if (successes >= 10) setTimeout(flushFailures, 50);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 0, model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
          content: JSON.stringify({ findings: [{
            id: `finding-${model}`,
            file: 'a.ts', startLine: 1, endLine: 1, severity: 'minor', category: 'correctness',
            confidence: 0.9, title: 'Keep the constant stable', description: 'The constant changed.',
            suggestedFix: 'Keep the previous value.',
          }] }),
        } }] }));
      response.on('finish', () => {
        successes++;
        if (successes >= 10) setTimeout(flushFailures, 50);
      });
    });
  });
  function flushFailures() {
    for (const response of delayed.splice(0)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"synthetic reviewer failure"}}');
    }
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address');
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '', TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
    HOME: dir, XDG_CONFIG_HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    RCL_DATA_DIR: join(dir, 'rcl-data'), RCL_NO_HARNESS_KEYS: '1', RCL_TELEMETRY: 'off',
    OPENAI_COMPAT_API_KEY: 'fixture-only', OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  };
  const review = ['review', 'change.patch', '--guarded-converge', '--converge-target', 'legacy-cross-version',
    '--head-sha', head, '--base-sha', head, '--config', 'config.json', '--context', 'context.md',
    '--json-file', 'report.json', '--no-telemetry'];
  return {
    dir, env, review, calls,
    recover: () => { releaseFailures = true; },
    close: async () => {
      for (const response of delayed) response.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('official 4.1.12 to candidate guarded continuation', () => {
  it.each([
    { label: 'same-input', changed: false },
    { label: 'changed-head', changed: true },
  ])('validates legacy health from the original while claiming exactly one $label attempt', async ({ changed }) => {
    const f = await fixture();
    const target = 'legacy-cross-version';
    const common = join(f.dir, '.git');
    try {
      const first = await cli(legacyCli, f.review, f.dir, f.env);
      expect(first.status, first.stderr).toBe(0);
      const reportBytes = await readFile(join(f.dir, 'report.json'));
      const report = JSON.parse(reportBytes.toString('utf8'));
      expect(report.run.rcl_version).toBe('4.1.12');
      expect(report.stats).toMatchObject({ successfulReviews: 10, totalReviews: 14 });
      expect(report.stats.blockingHealth).toBeUndefined();
      expect(report.run.roster.filter((seat: { lane: string }) => seat.lane === 'blocking')).toHaveLength(10);
      expect(report.reviews.filter((row: { status: string; model: string }) =>
        row.status === 'success' && row.model.startsWith('openai-compat/b'))).toHaveLength(6);
      expect(report.findings.length).toBeGreaterThan(0);
      const admitted = await cli(legacyCli,
        ['converge-report', '--target', target, '--round', '1', '--report', 'report.json', '--json'], f.dir, f.env);
      expect(admitted.status, admitted.stderr).toBe(0);
      const annotations = JSON.parse(admitted.stdout) as { findings: Array<{ identity: string }> };
      expect(annotations.findings.length).toBeGreaterThan(0);
      const verdict = await cli(legacyCli, ['converge-verdict', '--target', target, '--round', '1',
        '--run-id', report.run.id, ...annotations.findings.flatMap(row =>
          ['--dismissed', `${row.identity}=Original finding inspected and dismissed.`]), '--json'], f.dir, f.env);
      expect(verdict.status, verdict.stderr).toBe(0);

      const before = await loadConvergeRunState(common, target);
      const attemptsBefore = await loadConvergeAttemptState(common, target);
      expect(before?.rounds).toHaveLength(1);
      expect(Object.keys(before?.findings ?? {})).not.toHaveLength(0);
      expect(before?.lastLaunch).toMatchObject({ status: 'completed', round: 1, attempt: 1,
        successfulReviews: 10, totalReviews: 14 });
      expect(before?.lastLaunch?.reviewerHealth).toBeUndefined();
      expect(attemptsBefore?.attemptsUsed).toBe(1);
      const originalConfig = await readFile(join(f.dir, 'config.json'));
      const originalContext = await readFile(join(f.dir, 'context.md'));
      const originalPatch = await readFile(join(f.dir, 'change.patch'));
      const callCount = f.calls.length;
      const originalHead = f.review[f.review.indexOf('--head-sha') + 1]!;
      let nextHead = originalHead;
      let nextPatch = 'change.patch';
      if (changed) {
        await writeFile(join(f.dir, 'changed-head.ts'), 'export const changed = 3;\n');
        execFileSync('git', ['add', 'changed-head.ts'], { cwd: f.dir });
        execFileSync('git', ['commit', '-qm', 'changed review head'], { cwd: f.dir });
        nextHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.dir, encoding: 'utf8' }).trim();
        nextPatch = 'changed.patch';
        await writeFile(join(f.dir, nextPatch),
          'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 3;\n');
      }
      const retry = [...f.review.slice(0, -3), '--json-file', 'retry.json', '--no-telemetry',
        '--retry-report', 'report.json', '--retry-reason', `Original blocking health inspected; one bounded ${changed ? 'changed-head' : 'same-input'} retry.`]
        .map(arg => arg === 'change.patch' ? nextPatch : arg === originalHead ? nextHead : arg);

      const blindCommand = [...f.review.slice(0, -3), '--json-file', 'blind.json', '--no-telemetry',
        '--retry-reason', 'Original blocking health inspected; one bounded retry.'];
      const blind = await cli(candidateCli, blindCommand, f.dir, f.env);
      expect(blind.status).not.toBe(0);
      expect(blind.stderr).toContain('inputs_unchanged');
      expect(f.calls).toHaveLength(callCount);
      expect((await loadConvergeAttemptState(common, target))?.attempts).toEqual(attemptsBefore?.attempts);

      await writeFile(join(f.dir, 'tampered.json'), reportBytes.toString('utf8') + ' ');
      const tampered = await cli(candidateCli, retry.map(arg => arg === 'report.json' ? 'tampered.json' : arg), f.dir, f.env);
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toContain('retry_report_invalid');
      expect(f.calls).toHaveLength(callCount);
      expect((await loadConvergeAttemptState(common, target))?.attempts).toEqual(attemptsBefore?.attempts);

      f.recover();
      const second = await cli(candidateCli, retry, f.dir, f.env);
      expect(second.status, second.stderr).toBe(0);
      // The installed CLI may reuse retained successful calls; a valid claim
      // must still dispatch reviewer work, while refusals above dispatch none.
      expect(f.calls.length - callCount).toBeGreaterThan(0);
      expect(f.calls.length - callCount).toBeLessThanOrEqual(14);
      expect(await readFile(join(f.dir, 'report.json'))).toEqual(reportBytes);
      expect(await readFile(join(f.dir, 'config.json'))).toEqual(originalConfig);
      expect(await readFile(join(f.dir, 'context.md'))).toEqual(originalContext);
      expect(await readFile(join(f.dir, 'change.patch'))).toEqual(originalPatch);
      const after = await loadConvergeRunState(common, target);
      expect(after?.rounds).toEqual(before?.rounds);
      expect(after?.findings).toEqual(before?.findings);
      expect(after?.lastAnnotations).toEqual(before?.lastAnnotations);
      expect(after?.lastLaunch).toMatchObject({ status: 'completed', round: 2, attempt: 2,
        headSha: nextHead, reviewerHealth: { policy: { seatCount: 10, minimumSuccessful: 7 } } });
      expect(after?.lastLaunch?.reviewerHealth?.successfulSeats).toBeGreaterThanOrEqual(7);
      expect(after?.lastLaunch?.reviewerHealth?.successfulSeats).toBeLessThanOrEqual(10);
      const attemptsAfter = await loadConvergeAttemptState(common, target);
      expect(attemptsAfter).toMatchObject({ cap: attemptsBefore?.cap, attemptsUsed: 2 });
      expect(attemptsAfter?.attempts.slice(0, 1)).toEqual(attemptsBefore?.attempts);
      expect(attemptsAfter?.attempts[1]?.retrySource).toMatchObject({ round: 1, attempt: 1,
        headSha: originalHead, reportJsonSha256: sha256Hex(reportBytes),
        reviewerHealth: { policy: { seatCount: 10, minimumSuccessful: 7 }, successfulSeats: 6 } });
      expect(await readFile(join(common, 'rcl-converge-attempts', 'sources', sha256Hex(reportBytes)))).toEqual(reportBytes);
    } finally { await f.close(); }
  }, 120_000);
});
