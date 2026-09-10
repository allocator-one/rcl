import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Outbox } from '../src/telemetry/outbox.js';
import { buildEvent } from '../src/telemetry/events.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFindingRecovery } from '../src/evidence/recover-finding.js';
import { convergeRunStatePath, loadConvergeRunStateEvidence } from '../src/converge/run-state.js';
import { convergeAttemptStatePath } from '../src/converge/attempt-budget.js';
import { fakeFetch } from './telemetry/fixtures.js';
import { prepareFindingRecovery } from '../src/evidence/finding-recovery.js';
import type { ConvergeRunState } from '../src/converge/run-state.js';
import type { RunDetail } from '../src/evidence/types.js';

const runId = '00000000-0000-4000-8000-000000000001';
const canonical = 'bbbbbbbbbbbbbbbb';
const reportKey = 'aaaaaaaaaaaaaaaa';
const digest = 'd'.repeat(64);

function fixture() {
  const state: ConvergeRunState = {
    version: 1, target: 'project-42', roundCap: 15,
    rounds: [{ round: 1, counts: { new: 2, repeat: 0, suppressed: 0, regating: 0 }, runId }],
    findings: {
      [canonical]: {
        key: canonical, file: 'src/sample.ts', category: 'correctness', startLine: 109, endLine: 120,
        title: 'Synthetic observer', severity: 'important', models: [], firstRound: 1, lastRound: 1,
        verdict: 'dismissed', verdictRound: 1, verdictSeverity: 'important', verdictReason: 'PRIVATE REASON NOT FOR TRANSPORT',
      },
      [reportKey]: {
        key: reportKey, file: 'src/sample.ts', category: 'correctness', startLine: 101, endLine: 102,
        title: 'Synthetic sibling', severity: 'important', models: [], firstRound: 1, lastRound: 1,
        verdict: 'dismissed', verdictRound: 1, verdictSeverity: 'important',
      },
    },
    updatedAt: '2026-09-01T12:00:00.000Z',
  };
  const run: RunDetail = {
    id: runId, target: { kind: 'patch', repo: 'example/project', pr_number: 42, head_sha: 'a'.repeat(40) },
    converge: { target: 'project-42', round: 1, attempt: 1 },
    artifacts: [{ kind: 'report_json', declared_sha256: digest, stored: false }],
    findings: [
      { ref: 'f001', identity_key: reportKey, file: 'src/sample.ts', category: 'correctness', start_line: 101, end_line: 102, severity: 'important', title: 'Sibling', gating_reason: 'none' },
      { ref: 'f002', identity_key: reportKey, file: 'src/sample.ts', category: 'correctness', start_line: 109, end_line: 120, severity: 'important', title: 'Observer', gating_reason: 'consensus' },
    ], calls: [],
  };
  return { state, stateSha256: 'e'.repeat(64), run, target: 'project-42', runId, reportSha256: digest,
    findingRef: 'f002', identity: canonical, repository: 'example/project', prNumber: 42 };
}

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function command(submit = false, status = 201, mutate?: (input: ReturnType<typeof fixture>) => void) {
  const input = fixture();
  mutate?.(input);
  const cwd = await mkdtemp(join(tmpdir(), 'rcl-finding-recovery-'));
  directories.push(cwd);
  execFileSync('git', ['init', '-q', cwd]);
  const path = convergeRunStatePath(join(cwd, '.git'), input.target);
  await mkdir(dirname(path), { recursive: true });
  const bytes = JSON.stringify(input.state, null, 2) + '\n';
  await writeFile(path, bytes);
  const { fetch, requests } = fakeFetch((request) => request.method === 'GET'
    ? { status: 200, body: { data: input.run } }
    : { status, body: status === 201 ? { data: { inserted: 1, duplicates: 0 } } : { error: 'conflict', message: 'Conflicting correction' } });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFindingRecovery({ target: input.target, run: input.runId, reportSha256: input.reportSha256,
    findingRef: input.findingRef, identity: input.identity, forPr: 'example/project#42', submit }, {
    rclVersion: '3.2.0', cwd, fetchImpl: fetch, env: { HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN', HARNESS_API_URL: 'https://harness.example.test' },
    credentialsPath: join(cwd, 'no-credentials'), stdout: (s) => out.push(s), stderr: (s) => err.push(s),
  });
  expect(await readFile(path, 'utf8')).toBe(bytes);
  return { code, requests, out, err, bytes };
}

describe('unpaid recovery command', () => {
  it('digests the original bytes, not decoded and re-encoded native text', async () => {
    const input = fixture();
    const dir = await mkdtemp(join(tmpdir(), 'rcl-recovery-bytes-'));
    directories.push(dir);
    const path = convergeRunStatePath(dir, input.target);
    await mkdir(dirname(path), { recursive: true });
    // The existing reader accepts replacement characters in unused title text.
    const json = JSON.stringify(input.state).replace('Synthetic observer', 'INVALID_BYTE');
    const [before, after] = json.split('INVALID_BYTE');
    const bytes = Buffer.concat([Buffer.from(before!), Buffer.from([0xff]), Buffer.from(after!)]);
    await writeFile(path, bytes);
    const evidence = await loadConvergeRunStateEvidence(dir, input.target);
    expect(evidence!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(path)).toEqual(bytes);
  });

  it('previews by default with only a run read and no state mutation', async () => {
    const result = await command();
    expect(result.code).toBe(0);
    expect(result.requests.map((r) => r.method)).toEqual(['GET']);
    expect(result.out.join('\n')).toContain('Preview');
    expect(result.out.join('\n')).toContain('--submit');
  });

  it('submits only the correction event, hashing the exact native bytes', async () => {
    const result = await command(true);
    expect(result.code).toBe(0);
    expect(result.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(result.requests[1]!.url).toBe('https://harness.example.test/api/v1/reviews/converge/events');
    const payload = JSON.parse(result.requests[1]!.body!);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].kind).toBe('finding_identity_corrected');
    expect(payload.events[0].payload.native_evidence.state_sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'));
    expect(result.out.join('\n')).toContain('not a convergence verdict');
  });

  it('preserves a qualified report key without inferring its native identity', async () => {
    const qualified = `report:${runId}:${reportKey}`;
    const result = await command(true, 201, (input) => {
      input.run.findings[0]!.identity_key = `report:${runId}:cccccccccccccccc`;
      input.run.findings[1]!.identity_key = qualified;
    });
    expect(result.code).toBe(0);
    expect(result.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    const event = JSON.parse(result.requests[1]!.body!).events[0];
    expect(event.payload.identity_key).toBe(qualified);
    expect(event.payload.matched_identity).toBe(canonical);
  });

  it.each([false, true])('refuses secret-shaped bindings without exposing or posting them, submit=%s', async (submit) => {
    const secret = 'sk-' + 'a'.repeat(32);
    const result = await command(submit, 201, (input) => {
      const file = `src/${secret}.ts`;
      input.state.findings[canonical]!.file = file;
      input.run.findings[1]!.file = file;
    });
    expect.soft(result.code).not.toBe(0);
    expect.soft(result.requests.map((r) => r.method)).toEqual(['GET']);
    expect.soft(result.out.join('\n') + result.err.join('\n')).not.toContain(secret);
    expect(result.err.join('\n')).toMatch(/scrubbing/);
  });

  it('does not advise flushing unrelated evidence when a correction credential is refused', async () => {
    const result = await command(true, 401);
    expect(result.code).not.toBe(0);
    expect(result.err.join('\n')).toContain('log in again');
    expect(result.err.join('\n')).not.toContain('telemetry flush');
  });

  it('reports a conflict without retrying or recording any verdict', async () => {
    const result = await command(true, 409);
    expect(result.code).not.toBe(0);
    expect(result.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(result.err.join('\n')).toContain('Conflicting correction');
  });
});

async function snapshot(path: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(name));
    else files[name] = (await readFile(name)).toString('base64');
  }
  return files;
}

describe('recovery CLI isolation', () => {
  it('never flushes an existing outbox or changes native accounting, in preview or submission', async () => {
    const input = fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'rcl-recovery-cli-'));
    directories.push(cwd);
    execFileSync('git', ['init', '-q', cwd]);
    const statePath = convergeRunStatePath(join(cwd, '.git'), input.target);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(input.state));
    const attemptsPath = convergeAttemptStatePath(join(cwd, '.git'), input.target);
    await mkdir(dirname(attemptsPath), { recursive: true });
    await writeFile(attemptsPath, JSON.stringify({ version: 1, target: input.target, attemptsUsed: 1, cap: 20, updatedAt: input.state.updatedAt }));
    await mkdir(join(cwd, '.harness-cli'));
    await writeFile(join(cwd, '.harness-cli', 'config.json'), JSON.stringify({ team: 'RCL' }));
    const dataDir = join(cwd, 'data');
    const outbox = new Outbox(join(dataDir, 'outbox'));
    await outbox.spoolEvents([buildEvent({ kind: 'attempt_claimed', convergeTarget: 'unrelated', attempt: 1, payload: { cap: 20 } })]);
    await writeFile(join(dataDir, 'outcomes.jsonl'), '{"synthetic":true}\n');
    const before = { ...await snapshot(join(cwd, '.git')), ...await snapshot(dataDir) };
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method!, url: req.url!, body });
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = req.method === 'GET' ? 200 : 201;
      res.end(JSON.stringify({ data: req.method === 'GET' ? input.run : { inserted: 1, duplicates: 0 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local server address');
      for (const submit of [false, true]) {
        requests.length = 0;
        const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'),
          fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'evidence', 'recover-finding',
          '--target', input.target, '--run', runId, '--report-sha256', digest,
          '--finding-ref', 'f002', '--identity', canonical, '--for-pr', 'example/project#42',
          ...(submit ? ['--submit'] : [])], {
          cwd, env: { PATH: process.env.PATH, HOME: cwd, RCL_DATA_DIR: dataDir,
            HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN', HARNESS_API_URL: `http://127.0.0.1:${address.port}`,
            TSX_DISABLE_CACHE: '1', NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.stdout.resume();
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        expect(code, stderr).toBe(0);
        expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
          `GET /api/v1/reviews/runs/${runId}`, ...(submit ? ['POST /api/v1/reviews/converge/events'] : []),
        ]);
        if (submit) expect(JSON.parse(requests[1]!.body).events.map((e: { kind: string }) => e.kind)).toEqual(['finding_identity_corrected']);
        expect({ ...await snapshot(join(cwd, '.git')), ...await snapshot(dataDir) }).toEqual(before);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);
});

describe('finding identity recovery assertion', () => {
  it('binds one ref to retained native evidence without changing state or copying reasons', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const event = prepareFindingRecovery(input);
    expect(event.kind).toBe('finding_identity_corrected');
    expect(event.run_id).toBe(runId);
    expect(event.round).toBe(1);
    expect(event.payload).toMatchObject({
      finding_ref: 'f002', identity_key: reportKey, matched_identity: canonical, report_json_sha256: digest,
      native_evidence: { identity_key: canonical, state_sha256: 'e'.repeat(64), start_line: 109, verdict: 'dismissed' },
    });
    expect(JSON.stringify(event)).not.toContain('PRIVATE REASON');
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each(['target', 'file'])('refuses a %s binding that transport scrubbing would change', (field) => {
    const input = fixture();
    const secret = 'sk-' + 'a'.repeat(32);
    if (field === 'target') {
      input.target = secret;
      input.state.target = secret;
      input.run.converge!.target = secret;
    } else {
      input.state.findings[canonical]!.file = `src/${secret}.ts`;
      input.run.findings[1]!.file = `src/${secret}.ts`;
    }
    expect(() => prepareFindingRecovery(input)).toThrow(/scrubbing/);
  });

  it('does not require retrieved artifact bytes or claim they were verified', () => {
    const event = prepareFindingRecovery(fixture());
    expect(event.payload.native_evidence).toMatchObject({ source: 'rcl_converge_state' });
    expect(event.payload).not.toHaveProperty('report_bytes_verified');
  });

  it('refuses the colliding sibling identity even when it has a native verdict', () => {
    expect(() => prepareFindingRecovery({ ...fixture(), identity: reportKey })).toThrow(/location/);
  });

  it.each([
    ['run ID', { runId: '00000000-0000-4000-8000-000000000002' }],
    ['digest', { reportSha256: 'f'.repeat(64) }],
    ['ref', { findingRef: 'f999' }],
    ['repository', { repository: 'another/project' }],
    ['PR', { prNumber: 43 }],
    ['target', { target: 'another-42' }],
  ])('refuses a mismatched %s', (_label, override) => {
    expect(() => prepareFindingRecovery({ ...fixture(), ...override })).toThrow();
  });

  it('refuses state whose recorded round belongs to another run', () => {
    const input = fixture();
    input.state.rounds[0]!.runId = '00000000-0000-4000-8000-000000000002';
    expect(() => prepareFindingRecovery(input)).toThrow(/round/);
  });

  it('refuses a native identity whose latest sighting moved to another round', () => {
    const input = fixture();
    input.state.findings[canonical]!.lastRound = 2;
    expect(() => prepareFindingRecovery(input)).toThrow(/round/);
  });

  it('refuses a missing native verdict instead of recording one', () => {
    const input = fixture();
    delete input.state.findings[canonical]!.verdict;
    expect(() => prepareFindingRecovery(input)).toThrow(/verdict/);
  });

  it('refuses a different verdict round', () => {
    const input = fixture();
    input.state.findings[canonical]!.verdictRound = 2;
    expect(() => prepareFindingRecovery(input)).toThrow(/verdict/);
  });

  it('refuses duplicate refs in malformed server evidence', () => {
    const input = fixture();
    input.run.findings.push(input.run.findings[1]!);
    expect(() => prepareFindingRecovery(input)).toThrow(/ref/);
  });
});
