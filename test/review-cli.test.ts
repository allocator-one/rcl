import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  asyncTargetKey,
  collectAsyncResults,
  resolveAsyncStoreDir,
  runAsyncWorker,
  spoolAsyncCalls,
} from '../src/dispatch/async-lane.js';
import type { ReviewAdapter } from '../src/dispatch/adapter.js';
import { Quarantine } from '../src/telemetry/quarantine.js';
import { buildRunEnvelope } from '../src/telemetry/envelope.js';
import { sampleResult } from './telemetry/fixtures.js';
import { loadConvergeAttemptState } from '../src/converge/attempt-budget.js';
import { loadConvergeRunState, processRoundReport } from '../src/converge/run-state.js';
import { sha256Hex } from '../src/report/run-header.js';

// Global setup builds dist unless an installed package entrypoint is selected.
const cliEntrypoint = process.env['RCL_TEST_PACKAGED_CLI'] || process.env['RCL_TEST_REVIEW_ENTRYPOINT'] || fileURLToPath(new URL('../dist/index.js', import.meta.url));
// Keep explicit TypeScript development overrides without loading tsx for built CLI runs.
const cliNodeArgs = /\.(?:[cm]?ts|tsx)$/.test(cliEntrypoint)
  ? ['--import', import.meta.resolve('tsx'), cliEntrypoint]
  : [cliEntrypoint];
const tempDirs: string[] = [];
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };

function tempRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rcl-review-cli-'));
  tempDirs.push(directory);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, env: GIT_ENV });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(directory, 'a.ts'), 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  return directory;
}

function runRcl(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [...cliNodeArgs, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      NODE_NO_WARNINGS: '1',
      // Never reach a provider or Harness from this test, and never look like
      // a GitHub Actions job with id-token: write (the suite may run in one).
      RCL_NO_HARNESS_KEYS: '1',
      ACTIONS_ID_TOKEN_REQUEST_URL: '',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      // spawn omits undefined values. The SDK rejects a missing key before
      // any request, but accepts an empty string and attempts a connection.
      OPENAI_API_KEY: undefined,
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      OPENROUTER_API_KEY: '',
    },
    timeout: 30_000,
  });
}

function runRclAsync(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 30_000,
  onSpawn?: (child: ChildProcess) => void
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...cliNodeArgs, ...args], {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        NODE_NO_WARNINGS: '1',
        RCL_NO_HARNESS_KEYS: '1',
        ACTIONS_ID_TOKEN_REQUEST_URL: '',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GEMINI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`rcl did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeoutHandle);
      resolve({ status, stdout, stderr });
    });
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface GuardedCliFixture {
  repo: string;
  args: string[];
  env: Record<string, string>;
  calls: () => number;
  requestBodies: () => Array<{ messages: Array<{ content: string }> }>;
  holdResponses: () => void;
  releaseResponses: () => void;
  firstRequest: Promise<void>;
}

async function withGuardedFixture(work: (fixture: GuardedCliFixture) => Promise<void>, findings: unknown[] = []): Promise<void> {
  const repo = tempRepository();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
  writeFileSync(join(repo, 'config.json'), JSON.stringify({
    models: ['openai-compat/fixture'], secondaryModels: [], asyncModels: [],
    roles: ['general', 'security-auditor'], harness: { telemetry: 'off' },
  }));
  let calls = 0;
  const requestBodies: Array<{ messages: Array<{ content: string }> }> = [];
  let holdResponses = false;
  const pendingResponses: Array<() => void> = [];
  let notifyRequest: () => void = () => {};
  const firstRequest = new Promise<void>(resolve => { notifyRequest = resolve; });
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { requestBodies.push(JSON.parse(body)); });
    calls++;
    notifyRequest();
    const respond = () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant', content: JSON.stringify({ findings }),
        } }],
      }));
    };
    if (holdResponses) pendingResponses.push(respond);
    else respond();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await work({
      repo,
      args: ['review', 'change.patch', '--guarded-converge', '--converge-target', 'guarded-fixture',
        '--head-sha', head, '--base-sha', head, '--json-file', 'report.json',
        '--config', 'config.json', '--no-telemetry'],
      env: { OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, RCL_DATA_DIR: join(repo, 'rcl-data') },
      calls: () => calls,
      requestBodies: () => requestBodies,
      holdResponses: () => { holdResponses = true; },
      releaseResponses: () => {
        holdResponses = false;
        for (const respond of pendingResponses.splice(0)) respond();
      },
      firstRequest,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('rcl review — bound fix-obligation recovery (RCL-148)', () => {
  const recoveryRunId = '019921a0-0000-7000-8000-000000000002';

  it('advertises the explicit run selection in review help', () => {
    const result = runRcl(['review', '--help'], tempRepository());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--bound-fix-recovery <run-id>');
  });

  it.each([
    { label: 'unguarded review', remove: ['--guarded-converge'], extra: ['--for-pr', 'owner/repo#42', '--evidence-required'], expected: /guarded-converge/ },
    { label: 'optional evidence delivery', remove: [], extra: ['--for-pr', 'owner/repo#42'], expected: /evidence-required/ },
    { label: 'review without PR binding', remove: ['--no-telemetry'], extra: ['--evidence-required'], expected: /PR|pull request|for-pr/i },
    { label: 'fresh review', remove: ['--no-telemetry'], extra: ['--for-pr', 'owner/repo#42', '--evidence-required', '--start-over'], expected: /start-over|fresh|incompatible/i },
    { label: 'infrastructure retry reason', remove: ['--no-telemetry'], extra: ['--for-pr', 'owner/repo#42', '--evidence-required', '--retry-reason', 'Provider repaired'], expected: /retry|incompatible/i },
    { label: 'legacy retry report', remove: ['--no-telemetry'], extra: ['--for-pr', 'owner/repo#42', '--evidence-required', '--retry-report', 'prior.json'], expected: /retry|incompatible/i },
    { label: 'attested review', remove: ['--no-telemetry'], extra: ['--for-pr', 'owner/repo#42', '--evidence-required', '--attest'], expected: /attest|incompatible/i },
    { label: 'stop-upstream intent', remove: ['--no-telemetry'], extra: ['--for-pr', 'owner/repo#42', '--evidence-required', '--launch-intent', 'stop-upstream'], expected: /intent|incompatible/i },
    { label: 'delivery retry intent', remove: ['--no-telemetry'], extra: ['--for-pr', 'owner/repo#42', '--evidence-required', '--launch-intent', 'retry-delivery'], expected: /intent|incompatible/i },
  ])('refuses $label before attempt or provider spend', async ({ remove, extra, expected }) => {
    await withGuardedFixture(async fixture => {
      const args = [...fixture.args.filter(arg => !remove.includes(arg)), '--bound-fix-recovery', recoveryRunId, ...extra];
      const result = await runRclAsync(args, fixture.repo, {
        ...fixture.env, RCL_FOR_PR: '', RCL_CONVERGE_TARGET: '', RCL_CONVERGE_ROUND: '', RCL_CONVERGE_ATTEMPT: '',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toMatch(/unknown option/i);
      expect(result.stderr).toMatch(expected);
      expect(fixture.calls()).toBe(0);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture')).toBeUndefined();
      expect(existsSync(join(fixture.repo, 'report.json'))).toBe(false);
    });
  });
});

describe('rcl review — pending launch recovery (RCL-152, RCL-154)', () => {
  it('advertises unknown finalization, ordinary preview/apply and immutable async bindings', () => {
    const result = runRcl(['review', '--help'], tempRepository());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--resume-pending');
    expect(result.stdout).toContain('--resume-async-sha256 <hashes>');
    expect(result.stdout).toContain('--ordinary-pending-package <path>');
    expect(result.stdout).toContain('--preview-pending');
  });

  it.each([
    ['missing reviewed async bindings', ['--resume-pending', '--retry-report', 'prior.json', '--retry-reason', 'Resume exact claim.']],
    ['async bindings without recovery', ['--resume-async-sha256', 'f'.repeat(64)]],
  ])('refuses %s before attempt or provider spend', async (_label, extra) => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync([...fixture.args, ...extra], fixture.repo, fixture.env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('pending_resume_incompatible');
      expect(fixture.calls()).toBe(0);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture')).toBeUndefined();
    });
  });

  it('requires an exact package path and digest pair before reading review inputs', async () => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync([...fixture.args,
        '--resume-pending', '--resume-async-sha256', 'f'.repeat(64),
        '--ordinary-pending-package', 'reviewed.json', '--retry-reason', 'Owner died.',
        '--evidence-required'], fixture.repo, fixture.env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('pending_resume_incompatible');
      expect(fixture.calls()).toBe(0);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture')).toBeUndefined();
    });
  });
});

describe('rcl review — guarded native launch', () => {
  it.each([false, true])('shares repository rules once without a dedicated seat (explicit context: %s)', async (explicitContext) => {
    await withGuardedFixture(async fixture => {
      const rules = '# Project rules\nUse gettext for application text.\n';
      writeFileSync(join(fixture.repo, 'AGENTS.md'), rules);
      const args = explicitContext ? [...fixture.args, '--context', './AGENTS.md'] : fixture.args;
      const result = await runRclAsync(args, fixture.repo, fixture.env);
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.requestBodies()).toHaveLength(2);
      for (const request of fixture.requestBodies()) {
        expect(request.messages.map(message => message.content).join('\n').split(rules.trim())).toHaveLength(2);
      }
      const report = JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8'));
      expect(report.run.roster.filter((seat: { lane: string }) => seat.lane === 'blocking').map((seat: { role: string }) => seat.role))
        .toEqual(['general', 'security-auditor']);
      expect(report.run.context_files).toEqual([{
        path: expect.stringContaining('AGENTS.md'), sha256: sha256Hex(rules),
      }]);
    });
  });

  it('normalizes fresh reviewer prose before writing report bytes with telemetry off', async () => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync([...fixture.args, '--markdown', 'report.md'], fixture.repo, fixture.env);
      expect(result.status, result.stderr).toBe(0);
      expect(fixture.calls()).toBe(2);
      const bytes = readFileSync(join(fixture.repo, 'report.json'), 'utf8');
      const report = JSON.parse(bytes);
      expect(report.reviews).toHaveLength(2);
      for (const review of report.reviews) {
        expect(review.status).toBe('success');
        expect(review.findings).toHaveLength(1);
        expect(review.findings[0]).toMatchObject({ title: 'A title�', description: 'Preserve 😀 and replace � �', suggestedFix: 'Fix the issue' });
      }
      expect(bytes).not.toMatch(/\\ud[89ab][0-9a-f]{2}|\\ud[cdef][0-9a-f]{2}/i);
      const markdown = readFileSync(join(fixture.repo, 'report.md'), 'utf8');
      expect(markdown).toContain('A title�');
    }, [{ file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', confidence: 0.9,
      title: 'A title\uD800', description: 'Preserve 😀 and replace \uD800 \uDFFF', suggestedFix: 'Fix\0 the issue' }]);
  }, 40_000);

  it('claims and binds one launch only after successful preflight', async () => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync(fixture.args, fixture.repo, fixture.env);

      expect(result.status, result.stderr).toBe(0);
      expect(fixture.calls()).toBe(2);
      expect(JSON.parse(readFileSync(join(fixture.repo, 'report.json'), 'utf8')).run.converge)
        .toEqual({ target: 'guarded-fixture', round: 1, attempt: 1 });
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);

  it('preserves a report file created after guarded preflight', async () => {
    await withGuardedFixture(async fixture => {
      fixture.holdResponses();
      const run = runRclAsync(fixture.args, fixture.repo, fixture.env);
      await fixture.firstRequest;
      writeFileSync(join(fixture.repo, 'report.json'), 'preserved');
      fixture.releaseResponses();
      const result = await run;
      expect(result.status).toBe(1);
      expect(readFileSync(join(fixture.repo, 'report.json'), 'utf8')).toBe('preserved');
      expect((await loadConvergeRunState(join(fixture.repo, '.git'), 'guarded-fixture'))?.lastLaunch?.status)
        .toBe('failed');

      const retryArgs = [...fixture.args, '--json-file', 'retry.json'];
      const blindRetry = await runRclAsync(retryArgs, fixture.repo, fixture.env);
      expect(blindRetry.status).toBe(1);
      expect(blindRetry.stderr).toContain('dispatch_unknown');
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });

      const recovered = await runRclAsync([...retryArgs, '--retry-reason',
        'Known JSON write collision; selected a fresh destination after checking the failed run'], fixture.repo, fixture.env);
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(fixture.calls()).toBe(4);
      expect(JSON.parse(readFileSync(join(fixture.repo, 'retry.json'), 'utf8')).run.converge)
        .toEqual({ target: 'guarded-fixture', round: 1, attempt: 2 });
    });
  }, 40_000);

  it.each(['retained JSON', 'Markdown only'])('reuses the completed report after a %s write failure', async failedOutput => {
    await withGuardedFixture(async fixture => {
      const retainedJson = failedOutput === 'retained JSON';
      const output = retainedJson ? 'report.json' : 'report.md';
      const env = { ...fixture.env, ...(retainedJson ? {
        RCL_TELEMETRY: 'findings', HARNESS_API_URL: 'http://127.0.0.1:1', HARNESS_API_TOKEN: '',
      } : {}) };
      if (retainedJson) {
        mkdirSync(join(fixture.repo, '.harness-cli'));
        writeFileSync(join(fixture.repo, '.harness-cli', 'config.json'), '{}');
      }
      const args = retainedJson
        ? fixture.args.filter(argument => argument !== '--no-telemetry')
        : [...fixture.args, '--markdown', output];
      fixture.holdResponses();
      const run = runRclAsync(args, fixture.repo, env);
      await fixture.firstRequest;
      writeFileSync(join(fixture.repo, output), 'preserved');
      fixture.releaseResponses();
      expect((await run).status).toBe(1);
      const state = await loadConvergeRunState(join(fixture.repo, '.git'), 'guarded-fixture');
      expect(state?.lastLaunch?.status).toBe('completed');
      const reportPath = retainedJson
        ? join(fixture.repo, 'rcl-data', 'quarantine', state!.lastLaunch!.runId!, 'report.json')
        : join(fixture.repo, 'report.json');
      expect(JSON.parse(readFileSync(reportPath, 'utf8')).run.id).toBe(state?.lastLaunch?.runId);

      const retry = await runRclAsync([...args, '--json-file', 'retry.json', '--retry-reason',
        'A fresh output destination is available'], fixture.repo, env);
      expect(retry.status).toBe(1);
      expect(retry.stderr).toContain('report_not_admitted');
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);

  it.each([
    { args: ['--round', '27'], error: /wrong_round.*round 1/i },
    { args: ['--json-file', 'missing-directory/report.json'], error: /ENOENT|output/i },
    { args: ['--reviewer', 'openai/fixture:general'], error: /missing_provider_credentials/i },
    { args: ['--context', 'missing-context.md'], error: /unreadable_context/i },
    { args: ['--spec', 'missing-spec.md'], error: /unreadable_spec/i },
    { args: ['--config', 'missing-config.json'], error: /ConfigError/i },
    { args: ['--markdown', 'report.json'], error: /output_collision/i },
    { args: ['--attempt', '1'], error: /incompatible_launch/i },
    { args: ['--role', 'general'], error: /insufficient_reviewers/i },
    { args: ['--reviewer', 'openai-compat/fixture:general', '--reviewer', 'openai-compat/fixture:missing-role'], error: /invalid_reviewers/i },
    { args: ['--launch-intent', 'stop-review'], error: /review_stopped/i },
    { args: ['--launch-intent', 'retry-delivery'], error: /delivery_only/i },
  ])('refuses predictable failures without an attempt: $args', async scenario => {
    await withGuardedFixture(async fixture => {
      const result = await runRclAsync([...fixture.args, ...scenario.args], fixture.repo, fixture.env);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(scenario.error);
      expect(fixture.calls()).toBe(0);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture')).toBeUndefined();
    });
  }, 40_000);

  it('does not launch again while a completed report awaits native admission', async () => {
    await withGuardedFixture(async fixture => {
      const first = await runRclAsync(fixture.args, fixture.repo, fixture.env);
      expect(first.status, first.stderr).toBe(0);

      const second = await runRclAsync([...fixture.args, '--json-file', 'second.json'], fixture.repo, fixture.env);

      expect(second.status).toBe(1);
      expect(second.stderr).toContain('report_not_admitted');
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);

  it('continues an actually changed head and spec through audited stale recovery with local reviewers only', async () => {
    await withGuardedFixture(async fixture => {
      const first = await runRclAsync(fixture.args,fixture.repo,fixture.env);
      expect(first.status,first.stderr).toBe(0);
      const reportPath = join(fixture.repo,'report.json'), bytes = readFileSync(reportPath);
      writeFileSync(join(fixture.repo,'a.ts'),'export const a = 2;\n');
      execFileSync('git',['add','a.ts'],{cwd:fixture.repo,env:GIT_ENV});
      execFileSync('git',['commit','-q','-m','actual fix'],{cwd:fixture.repo,env:GIT_ENV});
      const head = execFileSync('git',['rev-parse','HEAD'],{cwd:fixture.repo,env:GIT_ENV,encoding:'utf8'}).trim();
      writeFileSync(join(fixture.repo,'current-spec.md'),'The committed behavior must return two.\n');
      const next = [...fixture.args,'--head-sha',head,'--spec','current-spec.md','--json-file','next.json'];
      const refused = await runRclAsync(next,fixture.repo,fixture.env);
      expect(refused.status).toBe(1); expect(refused.stderr).toContain('report_not_admitted');
      const input = refused.stderr.match(/--input-sha256 ([a-f0-9]{64})/)?.[1]; expect(input).toBeTruthy();
      const calls = fixture.calls(), manifest = join(fixture.repo,'stale.json');
      const preview = await runRclAsync(['converge-stale','--preview','--manifest',manifest,'--target','guarded-fixture',
        '--head',head,'--input-sha256',input!,'--report',reportPath,'--report-sha256',sha256Hex(bytes),
        '--reason','The committed behavior and current specification materially supersede the original review.'],fixture.repo,fixture.env);
      expect(preview.status,preview.stderr).toBe(0);
      const digest = sha256Hex(readFileSync(manifest));
      for (const mode of ['apply','resume']) {
        const result = await runRclAsync(['converge-stale',`--${mode}`,'--manifest',manifest,'--manifest-sha256',digest],fixture.repo,fixture.env);
        expect(result.status,result.stderr).toBe(0);
      }
      // A later mistaken selection must not strand the earlier correct input.
      const mistaken = join(fixture.repo,'mistaken.json');
      const extra = await runRclAsync(['converge-stale','--preview','--manifest',mistaken,'--target','guarded-fixture',
        '--head',head,'--input-sha256',sha256Hex('mistyped replacement input'),'--report',reportPath,
        '--report-sha256',sha256Hex(bytes),'--reason','Mistyped replacement input'],fixture.repo,fixture.env);
      expect(extra.status,extra.stderr).toBe(0);
      const applied = await runRclAsync(['converge-stale','--apply','--manifest',mistaken,
        '--manifest-sha256',sha256Hex(readFileSync(mistaken))],fixture.repo,fixture.env);
      expect(applied.status,applied.stderr).toBe(0);
      expect(fixture.calls()).toBe(calls);
      expect(await loadConvergeAttemptState(join(fixture.repo,'.git'),'guarded-fixture')).toMatchObject({attemptsUsed:1});
      const continued = await runRclAsync(next,fixture.repo,fixture.env);
      expect(continued.status,continued.stderr).toBe(0);
      expect(fixture.calls()).toBe(calls+2);
      expect(JSON.parse(readFileSync(join(fixture.repo,'next.json'),'utf8')).run.converge).toEqual({target:'guarded-fixture',round:1,attempt:2});
      expect(readFileSync(reportPath)).toEqual(bytes);
      expect((await loadConvergeRunState(join(fixture.repo,'.git'),'guarded-fixture'))?.rounds).toEqual([]);
    });
  },40000);

  it('does not spend on base-tip movement but requires review of a changed head', async () => {
    await withGuardedFixture(async fixture => {
      const first = await runRclAsync([...fixture.args, '--launch-intent', 'stop-upstream'], fixture.repo, fixture.env);
      expect(first.status, first.stderr).toBe(0);
      const bytes = readFileSync(join(fixture.repo, 'report.json'), 'utf8');
      const report = JSON.parse(bytes);
      await processRoundReport({ gitCommonDir: join(fixture.repo, '.git'), target: 'guarded-fixture',
        round: 1, findings: report.findings, runId: report.run.id, reportSha256: sha256Hex(bytes) });

      const unchanged = await runRclAsync([...fixture.args, '--base-sha', 'b'.repeat(40), '--json-file', 'second.json'], fixture.repo, fixture.env);
      expect(unchanged.status, unchanged.stderr).toBe(1);
      expect(unchanged.stderr).toContain('inputs_unchanged');
      expect(fixture.calls()).toBe(2);
      const changed = await runRclAsync([...fixture.args, '--head-sha', 'c'.repeat(40), '--json-file', 'second.json'], fixture.repo, fixture.env);

      expect(changed.status, changed.stderr).toBe(0);
      expect(fixture.calls()).toBe(4);
      expect(JSON.parse(readFileSync(join(fixture.repo, 'second.json'), 'utf8')).run.converge)
        .toEqual({ target: 'guarded-fixture', round: 2, attempt: 2 });
    });
  }, 40_000);

  it.skipIf(process.platform === 'win32')('preserves uncertain dispatch after an actual process loss and refuses automatic retry', async () => {
    await withGuardedFixture(async fixture => {
      fixture.holdResponses();
      let child: ChildProcess | undefined;
      const first = runRclAsync(fixture.args, fixture.repo, fixture.env, 30_000, process => { child = process; });
      await Promise.race([fixture.firstRequest, first.then(result => {
        throw new Error(`Review did not dispatch: ${result.stderr}`);
      })]);
      try {
        const conflicting = await runRclAsync([...fixture.args, '--json-file', 'conflict.json'], fixture.repo, fixture.env);
        expect(conflicting.status).not.toBe(0);
        expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
          .toMatchObject({ attemptsUsed: 1 });
        expect(child!.exitCode).toBeNull();
      } finally {
        child!.kill('SIGKILL');
      }
      await first;
      const calls = fixture.calls();
      expect(await loadConvergeRunState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ lastLaunch: { status: 'pending', pid: child!.pid } });

      const second = await runRclAsync([...fixture.args, '--json-file', 'second.json'], fixture.repo, fixture.env);

      expect(second.status).toBe(1);
      expect(second.stderr).toContain('dispatch_unknown');
      expect(fixture.calls()).toBe(calls);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture'))
        .toMatchObject({ attemptsUsed: 1 });
    });
  }, 40_000);
});

describe('rcl review — exact-head binding flags', () => {
  it('reviews a captured patch without reading gh credentials', async () => {
    const repo = tempRepository();
    const marker = join(repo, 'gh-called');
    const binaries = join(repo, 'bin');
    mkdirSync(binaries);
    writeFileSync(join(binaries, 'gh'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\nprocess.stdout.write('fixture-token');\n`,
      { mode: 0o700 });
    writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
    writeFileSync(join(repo, 'config.json'), JSON.stringify({
      models: ['openai-compat/fixture'], secondaryModels: [], asyncModels: [],
      harness: { telemetry: 'off' },
    }));
    let calls = 0;
    const server = createServer((request, response) => {
      request.resume();
      calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
        choices: [{ index: 0, finish_reason: 'stop', message: {
          role: 'assistant', content: JSON.stringify({ findings: [] }),
        } }],
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const result = await runRclAsync([
        'review', 'change.patch', '--config', 'config.json',
        '--reviewer', 'openai-compat/fixture:general', '--no-telemetry',
      ], repo, {
        PATH: `${binaries}:${process.env['PATH'] ?? ''}`,
        GITHUB_TOKEN: '', GH_TOKEN: '',
        OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
        RCL_DATA_DIR: join(repo, 'rcl-data'),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(calls).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(result.stdout + result.stderr).not.toContain('fixture-token');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 40_000);

  it('--expect-head-sha fails fast before anything is reviewed when HEAD differs', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--staged', '--expect-head-sha', 'f'.repeat(40)], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/head .*does not match .*--expect-head-sha/i);
  });

  it('--expect-head-sha passes when HEAD matches (and an empty diff then exits cleanly)', () => {
    const repo = tempRepository();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
    const result = runRcl(['review', '--staged', '--expect-head-sha', head], repo);

    expect(result.status).toBe(0);
    // The notice may land on either stream depending on the spinner's TTY
    // detection; the exit status is the primary assertion.
    expect(result.stderr + result.stdout).toMatch(/No staged changes/);
  });

  it('--head-sha rejects anything but a full 40-hex SHA', () => {
    const repo = tempRepository();
    writeFileSync(join(repo, 'x.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
    const result = runRcl(['review', './x.patch', '--head-sha', 'abc123'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--head-sha.*40/);
  });

  it('classifies any non-PR-shaped target as a patch file, whatever its case or path form', () => {
    const repo = tempRepository();
    // Reaches the SHA format check, which only a patch-classified target does.
    for (const name of ['fix.DIFF', 'patches/fix', 'changes.txt']) {
      const result = runRcl(['review', name, '--head-sha', 'abc123'], repo);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/--head-sha.*40/);
    }
  });

  it('a mistyped PR reference explains what a target can be instead of a bare file error', () => {
    const repo = tempRepository();
    for (const typo of ['owner/repo#12x', 'owner/repo/pull/123']) {
      const result = runRcl(['review', typo], repo);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/No such patch file: .*owner\/repo#N, or a GitHub PR URL/);
    }
  });

  it('--head-sha and --base-sha apply to patch files only', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--staged', '--head-sha', 'a'.repeat(40)], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--head-sha.*patch file/);
  });

  it('--spec-source without a spec is an error, not a silently dropped claim', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--staged', '--spec-source', 'harness_issue:IO-12475'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--spec-source was given without a spec/);
  });

  it('--head-sha with a git target fails before any configuration or diff work', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--working-tree', '--base-sha', 'a'.repeat(40)], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/patch files only.*--working-tree resolves HEAD itself/);
  });

  it('--spec-source rejects an unknown source', () => {
    const repo = tempRepository();
    const result = runRcl(['review', '--staged', '--spec-source', 'linear:ABC-1'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--spec-source/);
  });
});

describe('rcl telemetry rejected', () => {
  it('inspects a selected retained original without delivering it', async () => {
    const repo = tempRepository();
    const dataDir = mkdtempSync(join(tmpdir(), 'rcl-rejected-cli-'));
    tempDirs.push(dataDir);
    const result = sampleResult();
    const artifacts = { report_json: JSON.stringify(result), report_md: '# Original report\n' };
    const store = new Quarantine(join(dataDir, 'quarantine'));
    await store.retain({
      runId: result.run!.id,
      artifacts,
      envelope: buildRunEnvelope(result, artifacts, { level: 'full', delivery: { mode: 'direct' } }),
      events: [],
      requestedMode: 'asserted',
      acknowledged: false,
      diagnostics: [{ path: 'delivery', message: 'HTTP 422' }],
    });

    const command = runRcl(['telemetry', 'rejected', '--run', result.run!.id, '--json'], repo, { RCL_DATA_DIR: dataDir });

    expect(command.status, command.stderr).toBe(0);
    expect(JSON.parse(command.stdout)).toMatchObject({
      entries: [{ runId: result.run!.id, status: 'complete' }],
    });
  });
});

describe('rcl review - async convergence identity', () => {
  it.each([
    { mode: 'patch', context: 'flag', attributed: false },
    { mode: 'patch', context: 'flag', attributed: true },
    { mode: 'patch', context: 'environment', attributed: false },
    { mode: 'patch', context: 'environment', attributed: true },
    { mode: 'patch', context: 'none', attributed: false },
    { mode: 'staged', context: 'flag', attributed: false },
    { mode: 'working-tree', context: 'flag', attributed: false },
    { mode: 'plan', context: 'flag', attributed: false },
  ])('collects with $mode identity, $context context, PR attribution=$attributed', async ({ mode, context, attributed }) => {
    const repo = tempRepository();
    const first = join(mkdtempSync(join(repo, 'round-1-')), 'review.patch');
    const next = join(mkdtempSync(join(repo, 'round-2-')), 'review.patch');
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    writeFileSync(first, patch, { mode: 0o600 });
    const nextContent = mode === 'plan' ? '# Fixture plan\n\nA later plan.\n' : patch.replace('+b', '+c');
    writeFileSync(next, nextContent, { mode: 0o600 });
    const target = 'repo-12';
    const store = await resolveAsyncStoreDir(repo);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo, env: GIT_ENV, encoding: 'utf8',
    }).trim();
    const label = mode === 'patch' ? (context === 'none' ? next : first)
      : mode === 'plan' ? `plan:${next}` : `git-${mode}-${branch}`;
    const key = asyncTargetKey(label, mode === 'patch' && context !== 'none' ? target : undefined);
    if (mode === 'staged' || mode === 'working-tree') {
      writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
      if (mode === 'staged') execFileSync('git', ['add', 'a.ts'], { cwd: repo, env: GIT_ENV });
    }
    const model = 'openrouter/async-fixture';
    const [spool] = await spoolAsyncCalls([{
      model, role: 'general', provider: 'openrouter',
      systemPrompt: 'fixture', userPrompt: patch,
    }], { storeDir: store, targetKey: key, timeoutMs: 1000, maxRetries: 0 });
    expect(await collectAsyncResults(store, key)).toEqual([]);
    const adapter: ReviewAdapter = {
      name: 'fixture', provider: 'openrouter',
      review: async (model, role) => ({
        model, role, provider: 'openrouter', findings: [], durationMs: 1, status: 'success',
      }),
      ask: async () => { throw new Error('not used'); },
    };
    await runAsyncWorker(spool!, () => adapter);

    const config = join(repo, 'config.json');
    writeFileSync(config, JSON.stringify({
      models: ['openai/fixture'], secondaryModels: [], asyncModels: [model],
    }));
    const reportPath = join(repo, 'report.json');
    const home = join(repo, 'home');
    mkdirSync(home);
    // Explicit reviewers suppress async dispatch, not collection. The blocking
    // fixture has no API key and records an error without contacting a provider.
    // Only the already-published fake result can supply an async review here.
    const result = runRcl([
      ...(mode === 'plan' ? ['review-plan', next]
        : mode === 'patch' ? ['review', next] : ['review', `--${mode}`]),
      '--config', config, '--reviewer', 'openai/fixture:general',
      ...(mode === 'patch' ? ['--head-sha', 'a'.repeat(40), '--base-sha', 'b'.repeat(40)] : []),
      ...(context === 'none' ? [] : ['--round', '2', '--attempt', '2']),
      '--no-telemetry', '--json-file', reportPath,
      ...(context === 'flag' ? ['--converge-target', ` ${target} `] : []),
      ...(attributed && context === 'flag' ? ['--for-pr', 'owner/repo#12'] : []),
    ], repo, {
      HOME: home, XDG_CONFIG_HOME: home, RCL_DATA_DIR: join(home, 'rcl'),
      RCL_CONVERGE_TARGET: context === 'none' ? '' : context === 'flag' ? 'must-not-win' : ` ${target} `,
      RCL_CONVERGE_ROUND: '', RCL_CONVERGE_ATTEMPT: '',
      RCL_FOR_PR: attributed && context === 'environment' ? 'owner/repo#12' : '',
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.run.converge).toEqual(context === 'none' ? undefined : { target, round: 2, attempt: 2 });
    expect(report.run.target.kind).toBe(mode === 'working-tree' ? 'working_tree' : mode);
    if (mode === 'patch') expect(report.run.target.head_sha).toBe('a'.repeat(40));
    expect(report.run.target.pr_number).toBe(attributed ? 12 : undefined);
    expect.soft(report.reviews.filter((review: { async?: boolean }) => review.async)).toEqual([
      expect.objectContaining({ model, role: 'general', status: 'success', async: true }),
    ]);
    expect(report.reviews.find((review: { model: string }) => review.model === 'openai/fixture')).toMatchObject({
      status: 'error', error: expect.stringContaining('Missing credentials'),
    });
    expect.soft(report.stats.asyncMerged).toBe(1);
    expect(report.stats.asyncLaunched).toBeUndefined();
    expect.soft(await collectAsyncResults(store, key)).toEqual([]);
    expect(readFileSync(first, 'utf8')).toBe(patch);
    expect(readFileSync(next, 'utf8')).toBe(nextContent);
  });
});

describe('rcl converge-report — pre-3.0 reports', () => {
  it('still loads a report without a run header or finding identities', () => {
    const repo = tempRepository();
    const report = {
      reviews: [
        { model: 'm1', role: 'general', provider: 'test', findings: [], durationMs: 1, status: 'success' },
        { model: 'm2', role: 'general', provider: 'test', findings: [], durationMs: 1, status: 'success' },
      ],
      findings: [
        {
          id: 'f1',
          file: 'src/a.ts',
          startLine: 10,
          endLine: 12,
          severity: 'important',
          category: 'correctness',
          title: 'Off by one',
          description: 'd',
          consensus: {
            score: 2,
            total: 2,
            models: ['m1', 'm2'],
            roles: ['general'],
            crossRole: false,
            crossModel: true,
            elevated: false,
            elevation: 'none',
            confidence: 0.7,
            confidenceLabel: 'High',
            tier: 'unanimous',
          },
          gating: { reason: 'consensus' },
        },
      ],
      stats: {
        totalReviews: 2,
        successfulReviews: 2,
        totalRawFindings: 2,
        totalDeduped: 1,
        belowThreshold: 0,
        durationMs: 10,
      },
    };
    writeFileSync(join(repo, 'report.json'), JSON.stringify(report));

    const result = runRcl(
      ['converge-report', '--target', 'legacy-target', '--report', 'report.json', '--round', '1', '--json'],
      repo
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.counts).toEqual({ new: 1, repeat: 0, suppressed: 0, regating: 0 });
    expect(parsed.findings[0]).toMatchObject({ status: 'new', gating: 'consensus', file: 'src/a.ts' });
  });
});

describe('rcl review — --attest (RCL-40)', () => {
  it('exits non-zero with a clear message outside GitHub Actions, before any network or reviewer work', () => {
    const repo = tempRepository();
    const result = runRcl(['review', 'allocator-one/rcl#42', '--attest'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/GitHub Actions/);
    expect(result.stderr).toMatch(/id-token: write/);
    expect(result.stderr).not.toMatch(/Fetching|Resolving diff/);
  });

  it('refuses a local diff or a patch file: only a pull request can be attested', () => {
    const repo = tempRepository();
    writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n');
    for (const args of [['review', '--staged', '--attest'], ['review', 'change.patch', '--attest']]) {
      const result = runRcl(args, repo);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/--attest applies to a pull request target/);
    }
  });

  it('contradicts --no-telemetry: an attested review is recorded or it does not run', () => {
    const repo = tempRepository();
    const result = runRcl(['review', 'allocator-one/rcl#42', '--attest', '--no-telemetry'], repo);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--attest contradicts --no-telemetry/);
  });

  it.each([
    {
      source: 'the environment',
      expected: 'findings',
      prepare: (_repo: string) => ({ args: [] as string[], env: { RCL_TELEMETRY: 'findings' } }),
    },
    {
      source: 'the project config',
      expected: 'off',
      prepare: (repo: string) => {
        writeFileSync(join(repo, '.review-council.yml'), 'harness:\n  telemetry: off\n');
        return { args: [] as string[], env: { RCL_TELEMETRY: '' } };
      },
    },
    {
      source: 'the explicitly named config',
      expected: 'envelope',
      prepare: (repo: string) => {
        writeFileSync(join(repo, 'alt.yml'), 'harness:\n  telemetry: envelope\n');
        return { args: ['--config', 'alt.yml'], env: { RCL_TELEMETRY: '' } };
      },
    },
  ])('needs the full telemetry level from $source before any token is requested', ({ expected, prepare }) => {
    const repo = tempRepository();
    const { args, env } = prepare(repo);
    const result = runRcl(['review', 'allocator-one/rcl#42', '--attest', ...args], repo, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(new RegExp(`--attest needs the telemetry level full \\(resolved: ${expected}\\)`));
  });
});

describe('rcl review — completed report output failure', () => {
  it.each(['json', 'markdown'])('retains both originals and attempts the sibling output when %s cannot be written', (failed) => {
    const repo = tempRepository();
    const dataDir = join(repo, 'private-data');
    mkdirSync(join(repo, '.harness-cli'));
    writeFileSync(join(repo, '.harness-cli', 'config.json'), '{}');
    writeFileSync(join(repo, 'change.patch'), 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n');
    writeFileSync(join(repo, 'config.json'), JSON.stringify({ models: ['openai/fixture'], secondaryModels: [], asyncModels: [] }));
    const jsonPath = join(repo, failed === 'json' ? 'missing/report.json' : 'report.json');
    const mdPath = join(repo, failed === 'markdown' ? 'missing/report.md' : 'report.md');
    const result = runRcl([
      'review', 'change.patch', '--config', 'config.json', '--reviewer', 'openai/fixture:general',
      '--head-sha', 'a'.repeat(40),
      '--json-file', jsonPath, '--markdown', mdPath,
    ], repo, {
      RCL_DATA_DIR: dataDir, RCL_TELEMETRY: 'findings',
      // An incomplete explicit credential pair prevents login fallback and all HTTP.
      HARNESS_API_URL: 'http://127.0.0.1:1', HARNESS_API_TOKEN: '',
      RCL_CONVERGE_TARGET: '', RCL_CONVERGE_ROUND: '', RCL_CONVERGE_ATTEMPT: '', RCL_FOR_PR: '',
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Could not write');
    const [runId] = readdirSync(join(dataDir, 'quarantine'));
    const dir = join(dataDir, 'quarantine', runId!);
    const originalJson = readFileSync(join(dir, 'report.json'), 'utf8');
    const originalMd = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(JSON.parse(originalJson).run.id).toBe(runId);
    expect(originalMd).toContain(runId);
    expect(readFileSync(failed === 'json' ? mdPath : jsonPath, 'utf8')).toBe(failed === 'json' ? originalMd : originalJson);
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).diagnostics)
      .toContainEqual(expect.objectContaining({ path: `output.${failed === 'json' ? 'report_json' : 'report_md'}` }));
  });
});

describe('rcl review — bounded verification fallback', () => {
  it('writes a strict-severity CI report when the whole verification pass times out', async () => {
    const repo = tempRepository();
    const reportPath = join(repo, 'report.json');
    writeFileSync(
      join(repo, 'change.patch'),
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n'
    );
    writeFileSync(
      join(repo, 'config.json'),
      JSON.stringify({
        models: ['openai-compat/fixture'],
        secondaryModels: [],
        asyncModels: [],
        thresholds: { minConsensusScore: 0, minConfidence: 0 },
        gating: {
          verificationModel: 'openai-compat/fixture',
          verificationTimeout: 5_000,
          verificationPassTimeout: 100,
        },
        harness: { telemetry: 'off' },
      })
    );

    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      requests++;
      if (requests > 1) return;

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-review',
          object: 'chat.completion',
          created: 0,
          model: 'fixture',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  findings: [
                    {
                      id: 'f1',
                      file: 'a.ts',
                      startLine: 1,
                      endLine: 1,
                      severity: 'important',
                      category: 'correctness',
                      title: 'Synthetic blocking finding',
                      description: 'The fixture finding must fall back to strict severity gating.',
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const result = await runRclAsync(
        [
          'review',
          'change.patch',
          '--config',
          'config.json',
          '--reviewer',
          'openai-compat/fixture:general',
          '--head-sha',
          'a'.repeat(40),
          '--base-sha',
          'b'.repeat(40),
          '--json-file',
          reportPath,
          '--no-telemetry',
          '--ci',
        ],
        repo,
        {
          OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${port}/v1`,
          RCL_DATA_DIR: join(repo, 'rcl-data'),
        },
        5_000
      );

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/Gating pass failed .*falling back to severity gating/i);
      expect(requests).toBe(2);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      expect(report.run.gating.verification_pass_timeout_ms).toBe(100);
      expect(report.stats.verification).toBeUndefined();
      expect(report.findings).toEqual([
        expect.objectContaining({
          severity: 'important',
          title: 'Synthetic blocking finding',
        }),
      ]);
      expect(report.findings[0]).not.toHaveProperty('gating');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 10_000);
});


describe('reviewer identity eligibility at CLI boundaries', () => {
  it.each(['blocking', 'async'] as const)('refuses a blocking/%s collision before attempt, provider, or spool creation', async lane => {
    await withGuardedFixture(async fixture => {
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify({
        models: lane === 'blocking' ? ['openai-compat/vendor', 'openai-compat/vendor::alpha'] : ['openai-compat/vendor'],
        secondaryModels: [], asyncModels: lane === 'async' ? ['openai-compat/vendor::alpha'] : [],
        roles: ['general', 'alpha::general'], customRoles: [{ name: 'alpha::general', systemPrompt: 'Synthetic local role' }],
        maxRetries: 0, timeout: 1000, asyncTimeout: 1000, harness: { telemetry: 'off' },
      }));
      const result = await runRclAsync(fixture.args, fixture.repo, fixture.env);
      expect.soft(result.stderr).toContain('ambiguous_reviewer_identity');
      expect.soft(result.status).toBe(1);
      expect.soft(fixture.calls()).toBe(0);
      expect.soft(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture')).toBeUndefined();
      expect.soft(existsSync(join(fixture.repo, '.git', 'rcl-async'))).toBe(false);
      expect.soft(existsSync(join(fixture.repo, 'report.json'))).toBe(false);
    });
  }, 40_000);

  it('refuses collected legacy async collisions without consuming the stored opinion or refunding calls', async () => {
    await withGuardedFixture(async fixture => {
      writeFileSync(join(fixture.repo, 'config.json'), JSON.stringify({
        models: ['openai-compat/vendor'], secondaryModels: [], asyncModels: ['openai-compat/unused'],
        roles: ['security-auditor', 'alpha::general'], customRoles: [{ name: 'alpha::general', systemPrompt: 'Synthetic local role' }],
        maxRetries: 0, harness: { telemetry: 'off' },
      }));
      const store = await resolveAsyncStoreDir(fixture.repo);
      const key = asyncTargetKey(join(fixture.repo, 'change.patch'), 'guarded-fixture');
      const path = join(store, `result-${key}-retained.json`);
      const bytes = JSON.stringify({ model: 'openai-compat/vendor::alpha', role: 'general', provider: 'openai-compat',
        findings: [], durationMs: 7, status: 'success', usage: { inputTokens: 4 } }) + '\n';
      writeFileSync(path, bytes);
      const result = await runRclAsync([...fixture.args, '--reviewer', 'openai-compat/vendor:alpha::general',
        '--reviewer', 'openai-compat/vendor:security-auditor'], fixture.repo, fixture.env);
      expect.soft(result.status).toBe(1);
      expect.soft(result.stderr).toContain('ambiguous_reviewer_identity');
      expect.soft(existsSync(join(fixture.repo, 'report.json'))).toBe(false);
      expect.soft(existsSync(path)).toBe(true);
      if (existsSync(path)) expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(fixture.calls()).toBe(2);
      expect(await loadConvergeAttemptState(join(fixture.repo, '.git'), 'guarded-fixture')).toMatchObject({ attemptsUsed: 1 });
      const refused = join(fixture.env.RCL_DATA_DIR!, 'assembly-refused');
      expect(existsSync(refused)).toBe(true);
      if (existsSync(refused)) {
        const files = readdirSync(refused);
        expect(files).toHaveLength(1);
        const retainedPath = join(refused, files[0]!);
        const retained = JSON.parse(readFileSync(retainedPath, 'utf8'));
        expect(retained.status).toBe('assembly_refused');
        expect(retained.run.converge).toEqual({ target: 'guarded-fixture', round: 1, attempt: 1 });
        expect(retained.chunkReviews).toHaveLength(2);
        expect(retained.chunkReviews.map((r: { status: string }) => r.status)).toEqual(['success', 'success']);
        expect(retained.chunkReviews.map((r: { model: string; role: string; findings: Array<{ title: string }> }) =>
          [r.model, r.role, r.findings[0]?.title])).toEqual([
          ['openai-compat/vendor', 'alpha::general', 'Retained blocking result'],
          ['openai-compat/vendor', 'security-auditor', 'Retained blocking result'],
        ]);
        expect(retained.asyncArtifacts).toEqual([{
          path,
          sha256: sha256Hex(bytes),
          bytesBase64: Buffer.from(bytes).toString('base64'),
        }]);
        utimesSync(path, new Date(0), new Date(0));
        await collectAsyncResults(store, asyncTargetKey('different-target'));
        expect(existsSync(path)).toBe(false);
        expect(Buffer.from(retained.asyncArtifacts[0].bytesBase64, 'base64').toString('utf8')).toBe(bytes);
        expect(sha256Hex(Buffer.from(retained.asyncArtifacts[0].bytesBase64, 'base64'))).toBe(sha256Hex(bytes));
        expect(retained).not.toHaveProperty('findings');
        expect(retained).not.toHaveProperty('ci_exit_code');
        expect(statSync(refused).mode & 0o777).toBe(0o700);
        expect(statSync(retainedPath).mode & 0o777).toBe(0o600);
      }
    }, [{ file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', confidence: 0.9,
      title: 'Retained blocking result', description: 'This result must survive refusal.' }]);
  }, 40_000);
});
