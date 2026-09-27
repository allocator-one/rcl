import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { asyncTargetKey, resolveAsyncStoreDir, runAsyncWorker, spoolAsyncCalls } from '../src/dispatch/async-lane.js';
import type { ReviewAdapter } from '../src/dispatch/adapter.js';
import { loadConvergeAttemptState } from '../src/converge/attempt-budget.js';
import { loadConvergeRunState } from '../src/converge/run-state.js';
import { buildRunEnvelope } from '../src/telemetry/envelope.js';

// Global setup builds dist unless an installed package entrypoint is selected.
const cliEntrypoint = process.env['RCL_TEST_PACKAGED_CLI'] || fileURLToPath(new URL('../dist/index.js', import.meta.url));
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function rcl(args: string[], cwd: string, env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntrypoint, ...args], {
      cwd,
      env: {
        ...process.env, ...env, NODE_NO_WARNINGS: '1', RCL_NO_HARNESS_KEYS: '1',
        ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENROUTER_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('rcl did not exit')); }, 90_000);
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

type Behavior = 'success' | 'reject-late' | 'hang';

/**
 * A synthetic OpenAI-compatible provider. Each model answers with a finding,
 * answers HTTP 400 only after `releaseAfter` immediate answers were sent and
 * received, or never answers (the client's own per-call timeout applies).
 */
async function syntheticProvider(behavior: (model: string) => Behavior, releaseAfter = 0) {
  const calls: string[] = [];
  const late: Array<() => void> = [];
  let answered = 0;
  const releaseLate = () => { if (answered >= releaseAfter) for (const reject of late.splice(0)) reject(); };
  const open: ServerResponse[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const model = (JSON.parse(body) as { model: string }).model;
      calls.push(model);
      open.push(response);
      const mode = behavior(model);
      if (mode === 'hang') return;
      if (mode === 'reject-late') {
        late.push(() => { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":{"message":"synthetic rejection"}}'); });
        releaseLate();
        return;
      }
      // Count an answer only once the client has it, then release late rejections.
      response.on('finish', () => { answered++; setTimeout(releaseLate, 200); });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ findings: [{
          file: 'a.ts', startLine: 1, endLine: 1, severity: 'minor', category: 'correctness', confidence: 0.9,
          title: `Finding from ${model}`, description: 'synthetic', suggestedFix: 'none',
        }] }) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    close: async () => {
      for (const response of open) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function repository(blocking: number, secondary: number, target: string) {
  const repo = mkdtempSync(join(tmpdir(), 'rcl-blocking-health-'));
  tempDirs.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
  // One specialized role per seat: deterministic guarded dispatch gives role
  // i to model i, so the first `blocking` seats are the council's own models
  // and the rest are secondary.
  const roles = Array.from({ length: blocking + secondary }, (_, index) => `synthetic-role-${index + 1}`);
  writeFileSync(join(repo, 'config.json'), JSON.stringify({
    models: Array.from({ length: blocking }, (_, index) => `openai-compat/b${index + 1}`),
    secondaryModels: Array.from({ length: secondary }, (_, index) => `openai-compat/s${index + 1}`),
    asyncModels: ['openai-compat/async1'],
    customRoles: roles.map((name) => ({ name, systemPrompt: `You review as ${name}.`, focus: ['correctness'] })),
    roles, maxRetries: 0, timeout: 3_000, harness: { telemetry: 'off' },
    gating: { mode: 'all-findings' },
  }));
  // One successful async opinion delivered by an earlier round of this target.
  const store = await resolveAsyncStoreDir(repo);
  const [spool] = await spoolAsyncCalls([{ model: 'openai-compat/async1', role: 'general', provider: 'openai-compat',
    systemPrompt: 'fixture', userPrompt: 'fixture' }], { storeDir: store, targetKey: asyncTargetKey('change.patch', target), timeoutMs: 1_000, maxRetries: 0 });
  const asyncAdapter: ReviewAdapter = {
    name: 'fixture', provider: 'openai-compat',
    review: async (model, role) => ({ model, role, provider: 'openai-compat', durationMs: 1, status: 'success', findings: [{
      file: 'a.ts', startLine: 1, endLine: 1, severity: 'minor', category: 'correctness', confidence: 0.9,
      title: 'Async opinion', description: 'retained, not counted',
    }] }),
    ask: async () => { throw new Error('not used'); },
  };
  await runAsyncWorker(spool!, () => asyncAdapter);
  const review = ['review', 'change.patch', '--guarded-converge', '--converge-target', target,
    '--head-sha', head, '--base-sha', head, '--json-file', 'report.json', '--config', 'config.json', '--no-telemetry'];
  return { repo, review };
}

/** Harness `Status.conclusive?/1` over the delivered envelope, unchanged. */
function harnessConclusive(report: Parameters<typeof buildRunEnvelope>[0]): boolean {
  const calls = buildRunEnvelope(report, { report_json: '{}', report_md: '' }, { level: 'full', delivery: { mode: 'direct' } })
    .calls.filter((call) => call.lane === 'blocking');
  const successful = calls.filter((call) => call.status === 'success').length;
  return calls.length >= 2 && successful >= Math.max(2, Math.floor((2 * calls.length + 2) / 3));
}

describe('rcl review and converge-report — blocking reviewer quorum (RCL-136)', () => {
  it('10 blocking (6 complete) + 4 secondary + 1 async: no premature cancellation, inconclusive, 7 required, not admitted', async () => {
    const target = 'blocking-ten';
    const { repo, review } = await repository(10, 4, target);
    let recovered = false;
    // Rejections wait until all 10 bonus-inflated successes (6 blocking + 4 secondary) were answered.
    const provider = await syntheticProvider((model) => !recovered && ['b7', 'b8', 'b9', 'b10'].includes(model) ? 'reject-late' : 'success', 10);
    const env = { OPENAI_COMPAT_BASE_URL: provider.url, OPENAI_BASE_URL: provider.url, RCL_DATA_DIR: join(repo, 'rcl-data') };
    try {
      const first = await rcl(review, repo, env);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stderr).toContain('Blocking reviewer health inconclusive: 6/10 blocking seats complete; 7 required; ' +
        'excluded from quorum: 4 secondary, 1 async successful; incomplete: ');
      const report = JSON.parse(readFileSync(join(repo, 'report.json'), 'utf8'));
      expect(report.stats).toMatchObject({ totalReviews: 15, successfulReviews: 11, blockingHealth: {
        version: 1, fraction: 2 / 3, seats: 10, required: 7, successful: 6, conclusive: false,
        excludedSuccesses: { secondary: 4, async: 1, verification: 0 } } });
      // The four slow blocking seats were awaited, not canceled by bonus successes.
      expect(report.stats.canceledCalls).toBeUndefined();
      expect(report.reviews.filter((row: { status: string }) => row.status === 'error').map((row: { model: string }) => row.model).sort())
        .toEqual(['openai-compat/b10', 'openai-compat/b7', 'openai-compat/b8', 'openai-compat/b9']);
      // Secondary and async findings stay in the report.
      expect(report.reviews.filter((row: { model: string; findings: unknown[] }) =>
        /\/(s\d|async1)$/.test(row.model) && row.findings.length === 1)).toHaveLength(5);
      expect(harnessConclusive(report)).toBe(false);

      const common = join(repo, '.git');
      const admission = await rcl(['converge-report', '--target', target, '--round', '1', '--report', 'report.json', '--json'], repo, env);
      expect(admission.status).toBe(4);
      expect(admission.stdout).toBe('');
      expect(JSON.parse(admission.stderr).error).toMatchObject({
        code: 'report_health_inconclusive',
        reviewerHealth: { conclusive: false, blockingSeats: 10, successfulBlockingSeats: 6, requiredSuccessfulSeats: 7,
          excludedSuccesses: { secondary: 4, async: 1, verification: 0 },
          incompleteSeats: ['b7', 'b8', 'b9', 'b10'].map((model) => ({ model: `openai-compat/${model}`, role: expect.any(String), status: 'error' })) },
      });
      expect(await loadConvergeRunState(common, target)).toMatchObject({ rounds: [], findings: {} });
      // A rewritten copy that looks healthy is still refused: the launch recorded inconclusive health.
      const forged = { ...report, reviews: report.reviews.map((row: object) => ({ ...row, status: 'success' })),
        stats: { ...report.stats, blockingHealth: undefined } };
      writeFileSync(join(repo, 'forged.json'), JSON.stringify(forged));
      const forgedAdmission = await rcl(['converge-report', '--target', target, '--round', '1', '--report', 'forged.json', '--json'], repo, env);
      expect(forgedAdmission.status).toBe(4);
      expect(JSON.parse(forgedAdmission.stderr).error.code).toBe('report_health_inconclusive');
      expect(await loadConvergeRunState(common, target)).toMatchObject({ rounds: [], findings: {} });

      // Supported continuation: same round, one more bounded attempt, nothing reset.
      const callsBefore = provider.calls.length;
      const refused = await rcl(review, repo, env);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/infrastructure_failure|retry reason/i);
      expect(provider.calls.length).toBe(callsBefore);
      recovered = true;
      const original = readFileSync(join(repo, 'report.json'), 'utf8');
      const retry = review.map((arg) => arg === 'report.json' ? 'report-2.json' : arg);
      const retried = await rcl([...retry, '--retry-reason', 'Blocking quorum 6/10 < 7; same roster and head, bounded retry.'], repo, env);
      expect(retried.status, retried.stderr).toBe(0);
      expect(readFileSync(join(repo, 'report.json'), 'utf8')).toBe(original);
      const healthy = JSON.parse(readFileSync(join(repo, 'report-2.json'), 'utf8'));
      expect(healthy.run.converge).toEqual({ target, round: 1, attempt: 2 });
      expect(healthy.stats.blockingHealth).toMatchObject({ seats: 10, required: 7, conclusive: true });
      expect(harnessConclusive(healthy)).toBe(true);
      const admitted = await rcl(['converge-report', '--target', target, '--round', '1', '--report', 'report-2.json', '--json'], repo, env);
      expect(admitted.status, admitted.stderr).toBe(0);
      expect(JSON.parse(admitted.stdout).reviewerHealth).toMatchObject({ conclusive: true, blockingSeats: 10, requiredSuccessfulSeats: 7 });
      expect(await loadConvergeAttemptState(common, target)).toMatchObject({ attemptsUsed: 2 });
      expect((await loadConvergeRunState(common, target))!.rounds).toHaveLength(1);
    } finally {
      await provider.close();
    }
  }, 180_000);

  it('17 blocking (11 complete, 6 timed out) + 1 async: inconclusive with 12 required, not admitted', async () => {
    const target = 'blocking-seventeen';
    const { repo, review } = await repository(17, 0, target);
    const provider = await syntheticProvider((model) => Number(model.slice(1)) > 11 ? 'hang' : 'success');
    const env = { OPENAI_COMPAT_BASE_URL: provider.url, OPENAI_BASE_URL: provider.url, RCL_DATA_DIR: join(repo, 'rcl-data') };
    try {
      const run = await rcl(review, repo, env);
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(readFileSync(join(repo, 'report.json'), 'utf8'));
      expect(report.stats).toMatchObject({ totalReviews: 18, successfulReviews: 12, blockingHealth: {
        seats: 17, required: 12, successful: 11, conclusive: false, excludedSuccesses: { secondary: 0, async: 1, verification: 0 } } });
      expect(report.reviews.filter((row: { status: string }) => row.status === 'timeout')).toHaveLength(6);
      expect(harnessConclusive(report)).toBe(false);
      const admission = await rcl(['converge-report', '--target', target, '--round', '1', '--report', 'report.json'], repo, env);
      expect(admission.status).toBe(4);
      expect(admission.stderr).toContain('11/17 blocking seats complete; 12 required');
      expect(admission.stderr).toContain('The report is not admitted');
      expect(await loadConvergeRunState(join(repo, '.git'), target)).toMatchObject({ rounds: [] });
    } finally {
      await provider.close();
    }
  }, 180_000);
});
