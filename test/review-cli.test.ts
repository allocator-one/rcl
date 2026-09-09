import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const cliEntrypoint = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
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
  return spawnSync(process.execPath, ['--import', tsxImport, cliEntrypoint, ...args], {
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

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('rcl review — exact-head binding flags', () => {
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

  it('needs the full telemetry level, read from the environment and the project config before any token is requested', () => {
    const repo = tempRepository();
    const reduced = runRcl(['review', 'allocator-one/rcl#42', '--attest'], repo, { RCL_TELEMETRY: 'findings' });
    expect(reduced.status).toBe(1);
    expect(reduced.stderr).toMatch(/--attest needs the telemetry level full \(resolved: findings\)/);

    writeFileSync(join(repo, '.review-council.yml'), 'harness:\n  telemetry: off\n');
    const off = runRcl(['review', 'allocator-one/rcl#42', '--attest'], repo);
    expect(off.status).toBe(1);
    expect(off.stderr).toMatch(/--attest needs the telemetry level full \(resolved: off\)/);

    // The file --config names is the one read, before any token is requested.
    writeFileSync(join(repo, 'alt.yml'), 'harness:\n  telemetry: envelope\n');
    const alt = runRcl(['review', 'allocator-one/rcl#42', '--attest', '--config', 'alt.yml'], repo, { RCL_TELEMETRY: '' });
    expect(alt.status).toBe(1);
    expect(alt.stderr).toMatch(/--attest needs the telemetry level full \(resolved: envelope\)/);
  });
});
