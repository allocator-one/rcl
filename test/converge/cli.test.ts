import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleFinding } from '../telemetry/fixtures.js';

const cliEntrypoint = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');
const tempDirs: string[] = [];
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

function tempRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rcl-cli-'));
  tempDirs.push(directory);
  execFileSync('git', ['init', '-q'], {
    cwd: directory,
    env: { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice },
  });
  return directory;
}

function runConvergeAttempt(args: string[], cwd = fileURLToPath(new URL('../..', import.meta.url))) {
  return spawnSync(
    process.execPath,
    ['--import', tsxImport, cliEntrypoint, 'converge-attempt', '--json', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      timeout: 10_000,
    }
  );
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('converge-report identity collision', () => {
  it('reports the collision as a structured native blocker without persisting a round', () => {
    const repo = tempRepository();
    const report = join(repo, 'report.json');
    writeFileSync(report, JSON.stringify({ findings: [
      sampleFinding({ identity: 'same-key', startLine: 11, endLine: 11 }),
      sampleFinding({ identity: 'same-key', startLine: 19, endLine: 19 }),
    ] }));
    const result = spawnSync(process.execPath,
      ['--import', tsxImport, cliEntrypoint, 'converge-report', '--target', 'test', '--round', '1', '--report', report, '--json'],
      { cwd: repo, encoding: 'utf8', timeout: 10_000, env: {
        ...process.env, HOME: repo, XDG_CONFIG_HOME: join(repo, 'config'), RCL_DATA_DIR: join(repo, 'account'),
        RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1',
      } });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: {
      code: 'RCL_CONVERGE_RUN_STATE', message: expect.stringMatching(/conflicting classifications/),
    } });
    expect(existsSync(join(repo, '.git', 'rcl-converge-runs'))).toBe(false);
  });
});

describe('converge-attempt CLI', () => {
  it('emits structured JSON and exit 3 for an invalid cap', () => {
    const result = runConvergeAttempt(['--target', 'rcl-test', '--max-attempts', '0']);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_STATE',
        message: 'maxAttempts (--max-attempts) must be a positive safe integer.',
      },
    });
  });

  it('emits structured JSON when the cap option has no value', () => {
    const result = runConvergeAttempt(['--target', 'rcl-test', '--max-attempts']);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: 'RCL_CONVERGE_ATTEMPT_STATE' },
    });
  });

  it('emits structured JSON and exit 3 when the target is missing', () => {
    const result = runConvergeAttempt([]);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_STATE',
        message: '--target is required.',
      },
    });
  });

  it('emits structured JSON when the target option has no value', () => {
    const result = runConvergeAttempt(['--target']);

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_STATE',
        message: '--target is required.',
      },
    });
  });

  it('emits exit 0 for a claim and exit 2 at the persisted consent boundary', () => {
    const repository = tempRepository();
    const claimed = runConvergeAttempt(
      ['--target', 'rcl-cli-test', '--max-attempts', '1'],
      repository
    );

    expect(claimed.status).toBe(0);
    expect(claimed.stderr).toBe('');
    expect(JSON.parse(claimed.stdout)).toMatchObject({
      target: 'rcl-cli-test',
      attempt: 1,
      attemptsUsed: 1,
      cap: 1,
    });

    const refused = runConvergeAttempt(['--target', 'rcl-cli-test'], repository);
    expect(refused.status).toBe(2);
    expect(refused.stdout).toBe('');
    expect(JSON.parse(refused.stderr)).toMatchObject({
      error: {
        code: 'RCL_CONVERGE_ATTEMPT_CAP',
        target: 'rcl-cli-test',
        attemptsUsed: 1,
        cap: 1,
      },
    });
  });
});
