import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function runRcl(args: string[], cwd: string) {
  return spawnSync(process.execPath, ['--import', tsxImport, cliEntrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      // Never reach a provider or Harness from this test.
      RCL_NO_HARNESS_KEYS: '1',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
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
