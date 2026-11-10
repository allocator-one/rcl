import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sampleFinding, sampleRunHeader } from '../telemetry/fixtures.js';
import type { WireEvent } from '../../src/telemetry/events.js';

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

/** Commits a guard line a gating dismissal can quote (RCL-201) and returns the cited reason. */
function commitCitedGuard(repo: string, why: string): string {
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/guard.ts'), 'if (!allowed) return deny();\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice } });
  git('add', 'src/guard.ts');
  git('commit', '-q', '--allow-empty', '-m', 'guard');
  return `${why}: src/guard.ts:1 \`if (!allowed) return deny();\``;
}

function runConvergeAttempt(args: string[], cwd = tempRepository()) {
  return spawnSync(
    process.execPath,
    ['--import', tsxImport, cliEntrypoint, 'converge-attempt', '--json', ...args],
    {
      cwd,
      encoding: 'utf8',
      // A machine-readable error test must never flush the developer's real
      // outbox or resolve a stored Harness login before validating its flags.
      env: { ...process.env, NODE_NO_WARNINGS: '1',
        RCL_DATA_DIR: join(cwd, 'private-data'), XDG_CONFIG_HOME: join(cwd, 'private-config'),
        HARNESS_API_TOKEN: '', HARNESS_API_URL: '',
      },
      timeout: 10_000,
    }
  );
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Two complete blocking seats: the smallest conclusive council converge-report admits.
const healthyReviews = ['m1', 'm2'].map((model) => ({
  model, role: 'general', provider: 'test', findings: [], durationMs: 1, status: 'success',
}));
const healthyRoster = healthyReviews.map(({ model, role, provider }) => ({ model, role, provider, lane: 'blocking' }));

describe('converge-report identity collision', () => {
  it('reports the collision as a structured native blocker without persisting a round', () => {
    const repo = tempRepository();
    const report = join(repo, 'report.json');
    writeFileSync(report, JSON.stringify({ reviews: healthyReviews, findings: [
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

describe('converge-verdict severity telemetry', () => {
  it.each([false, true])('emits a critical dismissal for a mixed-severity group (reversed: %s)', async (reversed) => {
    const repo = tempRepository();
    const events: WireEvent[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const received = (JSON.parse(body) as { events: WireEvent[] }).events;
      events.push(...received);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { inserted: received.length, duplicates: 0 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      mkdirSync(join(repo, '.harness-cli'));
      writeFileSync(join(repo, '.harness-cli/config.json'), '{}');
      const findings = [
        sampleFinding({ identity: 'critical', severity: 'critical', gating: { reason: 'critical' } }),
        sampleFinding({ identity: 'important', startLine: 11, endLine: 13 }),
      ];
      if (reversed) findings.reverse();
      const report = join(repo, 'report.json');
      const runId = sampleRunHeader().id;
      writeFileSync(report, JSON.stringify({ run: { id: runId, roster: healthyRoster, converge: { target: 'severity-test', round: 1 } }, reviews: healthyReviews, findings }));
      const env = { PATH: process.env['PATH'], HOME: repo, XDG_CONFIG_HOME: join(repo, 'config'),
        GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice, RCL_DATA_DIR: join(repo, 'account'),
        HARNESS_API_TOKEN: 'synthetic-test-token', HARNESS_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1' };
      const run = (args: string[], round = 1) => promisify(execFile)(process.execPath,
        ['--import', tsxImport, cliEntrypoint, ...args, '--target', 'severity-test', '--round', String(round), '--json'],
        { cwd: repo, env, timeout: 10_000 });
      const classified = JSON.parse((await run(['converge-report', '--report', report])).stdout);
      const key = classified.findings[0].identity as string;
      const reason = commitCitedGuard(repo, 'synthetic guard reviewed');
      const result = JSON.parse((await run(['converge-verdict', '--dismissed', `${key}=${reason}`])).stdout);
      expect(result.resolution.status).toBe('converged-dismissal-only');
      const verdict = events.find((event) => event.kind === 'verdicts_recorded');
      expect(verdict).toMatchObject({ run_id: runId, round: 1, payload: { verdicts: [
        { identity_key: key, verdict: 'dismissed', severity: 'critical', reason },
      ] } });
      expect(events.find((event) => event.kind === 'resolution')).toMatchObject({ run_id: runId,
        payload: { status: 'converged-dismissal-only', unresolved: 0 } });

      const laterReport = join(repo, 'later-report.json');
      writeFileSync(laterReport, JSON.stringify({ run: { id: '019921a0-0000-7000-8000-000000000002',
        roster: healthyRoster, converge: { target: 'severity-test', round: 2 } }, reviews: healthyReviews, findings: [sampleFinding()] }));
      await run(['converge-report', '--report', laterReport], 2);
      await run(['converge-verdict', '--dismissed', `${key}=${commitCitedGuard(repo, 'original critical evidence reviewed')}`]);
      expect(events.filter((event) => event.kind === 'verdicts_recorded').at(-1)).toMatchObject({ run_id: runId,
        payload: { verdicts: [{ identity_key: key, severity: 'critical' }] } });
      const outcomes = readFileSync(join(repo, 'account/outcomes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(outcomes).toHaveLength(2);
      expect(outcomes.map((outcome) => outcome.severity)).toEqual(['critical', 'critical']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 20_000);
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

describe('converge-verdict cited dismissals (RCL-201)', () => {
  function verdictCli(repo: string) {
    const env = { PATH: process.env['PATH'], HOME: repo, XDG_CONFIG_HOME: join(repo, 'config'),
      GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice, RCL_DATA_DIR: join(repo, 'account'),
      HARNESS_API_TOKEN: '', HARNESS_API_URL: '', RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1' };
    return (args: string[]) => spawnSync(process.execPath,
      ['--import', tsxImport, cliEntrypoint, ...args, '--target', 'cited', '--round', '1', '--json'],
      { cwd: repo, env, encoding: 'utf8', timeout: 10_000 });
  }
  function admit(repo: string, gating: 'verified' | 'none') {
    const report = join(repo, 'report.json');
    writeFileSync(report, JSON.stringify({ run: { id: sampleRunHeader().id, roster: healthyRoster, converge: { target: 'cited', round: 1 } },
      reviews: healthyReviews, findings: [sampleFinding({ identity: 'claim', gating: { reason: gating } })] }));
    const admitted = verdictCli(repo)(['converge-report', '--report', report]);
    expect(admitted.status).toBe(0);
    return JSON.parse(admitted.stdout).findings[0].identity as string;
  }

  it('refuses an uncited dismissal of a gating finding and records nothing', () => {
    const repo = tempRepository();
    const key = admit(repo, 'verified');
    const refused = verdictCli(repo)(['converge-verdict', '--dismissed', `${key}=The caller already guards this.`]);
    expect(refused.status).not.toBe(0);
    expect(JSON.parse(refused.stderr).error.message).toMatch(new RegExp(`${key}: cite at least one line`));
    const state = JSON.parse(readFileSync(join(repo, '.git/rcl-converge-runs', readdirSync(join(repo, '.git/rcl-converge-runs'))
      .find(name => name.startsWith('cited'))!), 'utf8'));
    expect(state.findings[key].verdict).toBeUndefined();
  });

  it('records a gating dismissal whose quote matches the reviewed code', () => {
    const repo = tempRepository();
    const key = admit(repo, 'verified');
    const recorded = verdictCli(repo)(['converge-verdict', '--dismissed', `${key}=${commitCitedGuard(repo, 'Guarded')}`]);
    expect(recorded.status).toBe(0);
    expect(JSON.parse(recorded.stdout).resolution.status).toBe('converged-dismissal-only');
  });

  it('still accepts an uncited dismissal of a non-gating finding', () => {
    const repo = tempRepository();
    const key = admit(repo, 'none');
    expect(verdictCli(repo)(['converge-verdict', '--dismissed', `${key}=Style preference only.`]).status).toBe(0);
  });
});
