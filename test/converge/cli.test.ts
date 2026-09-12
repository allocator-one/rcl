import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      writeFileSync(report, JSON.stringify({ run: { id: runId, converge: { target: 'severity-test', round: 1 } }, findings }));
      const env = { PATH: process.env['PATH'], HOME: repo, XDG_CONFIG_HOME: join(repo, 'config'),
        GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice, RCL_DATA_DIR: join(repo, 'account'),
        HARNESS_API_TOKEN: 'synthetic-test-token', HARNESS_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        RCL_NO_HARNESS_KEYS: '1', NODE_NO_WARNINGS: '1' };
      const run = (args: string[], round = 1) => promisify(execFile)(process.execPath,
        ['--import', tsxImport, cliEntrypoint, ...args, '--target', 'severity-test', '--round', String(round), '--json'],
        { cwd: repo, env, timeout: 10_000 });
      const classified = JSON.parse((await run(['converge-report', '--report', report])).stdout);
      const key = classified.findings[0].identity as string;
      const result = JSON.parse((await run(['converge-verdict', '--dismissed', `${key}=synthetic guard reviewed`])).stdout);
      expect(result.resolution.status).toBe('converged-dismissal-only');
      const verdict = events.find((event) => event.kind === 'verdicts_recorded');
      expect(verdict).toMatchObject({ run_id: runId, round: 1, payload: { verdicts: [
        { identity_key: key, verdict: 'dismissed', severity: 'critical', reason: 'synthetic guard reviewed' },
      ] } });
      expect(events.find((event) => event.kind === 'resolution')).toMatchObject({ run_id: runId,
        payload: { status: 'converged-dismissal-only', unresolved: 0 } });

      const laterReport = join(repo, 'later-report.json');
      writeFileSync(laterReport, JSON.stringify({ run: { id: '019921a0-0000-7000-8000-000000000002',
        converge: { target: 'severity-test', round: 2 } }, findings: [sampleFinding()] }));
      await run(['converge-report', '--report', laterReport], 2);
      await run(['converge-verdict', '--dismissed', `${key}=original critical evidence reviewed`]);
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
