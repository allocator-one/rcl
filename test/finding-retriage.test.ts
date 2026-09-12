import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareFindingRecovery } from '../src/evidence/finding-recovery.js';
import { prepareFindingRetriage } from '../src/evidence/finding-retriage.js';
import { runFindingRetriage } from '../src/evidence/retriage-finding.js';
import type { RunDetail } from '../src/evidence/types.js';
import { fakeFetch } from './telemetry/fixtures.js';
import { convergeRunStatePath, type ConvergeRunState } from '../src/converge/run-state.js';
import { convergeAttemptStatePath } from '../src/converge/attempt-budget.js';
import { Outbox } from '../src/telemetry/outbox.js';
import { buildEvent } from '../src/telemetry/events.js';

const runId = '00000000-0000-4000-8000-000000000001';
const reportKey = `report:${runId}:aaaaaaaaaaaaaaaa`;
const canonical = 'bbbbbbbbbbbbbbbb';
const digest = 'd'.repeat(64);
const reason = 'Reviewed the critical claim against the exact code: the guard already enforces this invariant.';
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('retriage evidence guards', () => {
  it.each(['critical', 'important', 'minor', 'nitpick'])('uses recorded %s severity, without mutating or inheriting older verdicts', (severity) => {
    const input = fixture();
    input.run.findings[1]!.severity = severity;
    input.run.findings[1]!.verdict = { verdict: 'dismissed', reason: 'old reason', round: 1 };
    const original = JSON.stringify(input);
    const event = prepareFindingRetriage(input);
    expect(event.payload.verdicts).toEqual([{ identity_key: reportKey, verdict: 'dismissed', severity, reason }]);
    expect(event).not.toHaveProperty('attempt');
    expect(event.payload).not.toHaveProperty('matched_identity');
    expect(JSON.stringify(input)).toBe(original);
  });

  const invalid: Array<[string, (input: ReturnType<typeof fixture>) => void]> = [
    ['run ID', (i) => { i.runId = '00000000-0000-4000-8000-000000000002'; }],
    ['malformed run ID', (i) => { i.runId = 'not-a-uuid'; }],
    ['unbound run', (i) => { i.run.target.kind = 'working-tree'; }],
    ['repository', (i) => { i.repository = 'other/project'; }],
    ['PR', (i) => { i.prNumber = 43; }],
    ['head', (i) => { i.run.target.head_sha = null; }],
    ['target', (i) => { i.target = 'another-42'; }],
    ['missing round', (i) => { i.run.converge!.round = null; }],
    ['fractional round', (i) => { i.run.converge!.round = 1.5; }],
    ['zero round', (i) => { i.run.converge!.round = 0; }],
    ['digest mismatch', (i) => { i.reportSha256 = 'f'.repeat(64); }],
    ['malformed digest', (i) => { i.reportSha256 = 'digest'; }],
    ['missing report', (i) => { i.run.artifacts = []; }],
    ['unstored report', (i) => { i.run.artifacts![0]!.stored = false; }],
    ['ambiguous reports', (i) => { i.run.artifacts!.push(i.run.artifacts![0]!); }],
    ['unknown ref', (i) => { i.findingRef = 'f999'; }],
    ['duplicate refs', (i) => { i.run.findings.push({ ...i.run.findings[1]!, identity_key: `report:${runId}:dddddddddddddddd` }); }],
    ['colliding key', (i) => { i.run.findings[0]!.identity_key = reportKey; }],
    ['legacy key', (i) => { i.run.findings[1]!.identity_key = 'aaaaaaaaaaaaaaaa'; }],
    ['another run key', (i) => { i.run.findings[1]!.identity_key = 'report:00000000-0000-4000-8000-000000000002:aaaaaaaaaaaaaaaa'; }],
    ['missing key', (i) => { i.run.findings[1]!.identity_key = null; }],
    ['invalid severity', (i) => { i.run.findings[1]!.severity = 'info'; }],
    ['empty reason', (i) => { i.reason = ' \n '; }],
    ['oversize reason', (i) => { i.reason = 'x'.repeat(2001); }],
    ['scrubbed reason', (i) => { i.reason = 'sk-' + 'a'.repeat(32); }],
    ['scrubbed target', (i) => { i.target = 'sk-' + 'a'.repeat(32); i.run.converge!.target = i.target; }],
  ];
  it.each(invalid)('refuses %s without changing the evidence', (_label, mutate) => {
    const input = fixture();
    mutate(input);
    const before = JSON.stringify(input);
    expect(() => prepareFindingRetriage(input)).toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });
});

async function command(options: { submit?: boolean; postStatus?: number; readStatus?: number;
  reason?: string | Uint8Array; missingFile?: boolean; receipt?: { inserted: number; duplicates: number };
  mutate?: (input: ReturnType<typeof fixture>) => void } = {}) {
  const input = fixture();
  options.mutate?.(input);
  const cwd = await mkdtemp(join(tmpdir(), 'rcl-retriage-command-'));
  directories.push(cwd);
  if (!options.missingFile) await writeFile(join(cwd, 'reason.txt'), options.reason ?? reason);
  const { fetch, requests } = fakeFetch((request) => {
    if (request.method === 'GET') return { status: options.readStatus ?? 200, body: { data: input.run } };
    const status = options.postStatus ?? 201;
    return { status, body: status === 201 ? { data: options.receipt ?? { inserted: 1, duplicates: 0 } } : { error: 'conflict', message: 'Synthetic refusal' } };
  });
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFindingRetriage({ target: input.target, run: input.runId, reportSha256: input.reportSha256,
    findingRef: input.findingRef, forPr: 'example/project#42', reasonFile: 'reason.txt', submit: options.submit }, {
    rclVersion: '3.4.0', cwd, fetchImpl: fetch,
    env: { HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN', HARNESS_API_URL: 'https://harness.example.test' },
    credentialsPath: join(cwd, 'no-credentials'), stdout: (s) => out.push(s), stderr: (s) => err.push(s),
  });
  return { code, requests, out: out.join('\n'), err: err.join('\n') };
}

describe('retriage command failures', () => {
  it.each([[0xff], [0xc3, 0x28], [0xe2, 0x82], [0xed, 0xa0, 0x80]])('refuses malformed UTF-8 bytes %j before network access', async (...bytes) => {
    const result = await command({ submit: true, reason: Uint8Array.from(bytes) });
    expect(result.code).toBe(2);
    expect(result.requests).toEqual([]);
  });

  it('preserves a valid Unicode reason in a newly inserted verdict', async () => {
    const unicodeReason = 'Prüfung: accès autorisé — 確認済み';
    const result = await command({ submit: true, reason: unicodeReason });
    expect(result.code).toBe(0);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[1]!.body).toContain(unicodeReason);
  });

  it.each([{ inserted: 0, duplicates: 1 }, { inserted: 0, duplicates: 0 },
    { inserted: 2, duplicates: 0 }, { inserted: 1, duplicates: 1 }])('refuses an unexpected receipt %j without retrying', async (receipt) => {
    const result = await command({ submit: true, receipt });
    expect(result.code).toBe(3);
    expect(result.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(result.out).not.toContain('Verdict acknowledged');
    expect(result.err).toContain('Inspect server evidence before retrying');
  });

  it('needs no native state for a fresh judgment, and does not claim original bytes were retrieved', async () => {
    const result = await command();
    expect(result.code).toBe(0);
    expect(result.requests.map((r) => r.method)).toEqual(['GET']);
    expect(result.out).toContain('original report bytes were not retrieved or verified');
  });

  it.each([401, 403, 409, 503])('reports submission status %s without retries, spooling or a convergence claim', async (postStatus) => {
    const result = await command({ submit: true, postStatus });
    expect(result.code).toBe(3);
    expect(result.requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(result.err).toContain('not acknowledged');
    expect(result.err).not.toContain('telemetry flush');
    expect(result.out).not.toContain('acknowledged');
  });

  it.each([401, 403, 404, 503])('never submits when reading the evidence returns %s', async (readStatus) => {
    const result = await command({ submit: true, readStatus });
    expect(result.code).toBe(3);
    expect(result.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it.each([false, true])('refuses a secret-shaped reason without exposing or posting it, submit=%s', async (submit) => {
    const secret = 'sk-' + 'a'.repeat(32);
    const result = await command({ submit, reason: secret });
    expect(result.code).toBe(2);
    expect(result.requests.map((r) => r.method)).toEqual(['GET']);
    expect(result.out + result.err).not.toContain(secret);
  });

  it.each([{ missingFile: true }, { reason: '  ' }, { reason: 'x'.repeat(2001) }])('refuses missing or invalid reason files before network access (%j)', async (options) => {
    const result = await command({ ...options, submit: true });
    expect(result.code).toBe(2);
    expect(result.requests).toEqual([]);
  });

  it('refuses mismatched recorded evidence without posting', async () => {
    const result = await command({ submit: true, mutate: (i) => { i.run.artifacts![0]!.declared_sha256 = 'f'.repeat(64); } });
    expect(result.code).toBe(2);
    expect(result.requests.map((r) => r.method)).toEqual(['GET']);
  });
});

function fixture() {
  const run: RunDetail = {
    id: runId, target: { kind: 'pr', repo: 'example/project', pr_number: 42, head_sha: 'c'.repeat(40) },
    converge: { target: 'project-42', round: 3, attempt: 4 },
    artifacts: [{ kind: 'report_json', declared_sha256: digest, stored: true }],
    findings: [
      { ref: 'f001', identity_key: `report:${runId}:cccccccccccccccc`, file: 'src/sample.ts',
        category: 'correctness', start_line: 110, end_line: 115, severity: 'important', title: 'Sibling', gating_reason: 'consensus' },
      { ref: 'f002', identity_key: reportKey, file: 'src/sample.ts', category: 'correctness',
        start_line: 109, end_line: 120, severity: 'critical', title: 'Critical observer', gating_reason: 'critical' },
    ], calls: [],
  };
  return { run, target: 'project-42', runId, reportSha256: digest, findingRef: 'f002',
    repository: 'example/project', prNumber: 42, reason };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(file));
    else files[file] = (await readFile(file)).toString('base64');
  }
  return files;
}

describe('RCL-56 retained grouped-severity recovery', () => {
  it('previews and submits a fresh critical verdict without rematching drifted native identities or flushing evidence', async () => {
    const input = fixture();
    const cwd = await mkdtemp(join(tmpdir(), 'rcl-retriage-cli-'));
    directories.push(cwd);
    execFileSync('git', ['init', '-q', cwd]);
    const state: ConvergeRunState = {
      version: 1, target: input.target, roundCap: 15,
      rounds: [{ round: 3, counts: { new: 2, repeat: 0, suppressed: 0, regating: 0 }, runId }],
      findings: { [canonical]: {
        key: canonical, file: 'src/sample.ts', category: 'correctness', startLine: 110, endLine: 115,
        title: 'Last grouped sighting', severity: 'important', models: [], firstRound: 3, lastRound: 3,
        verdict: 'dismissed', verdictRound: 3, verdictSeverity: 'important', verdictReason: 'Older important-only verdict',
      } }, updatedAt: '2026-09-01T12:00:00.000Z',
    };
    // RCL-56 must not weaken the existing correction's exact-span guard.
    expect(() => prepareFindingRecovery({ ...input, state, stateSha256: 'e'.repeat(64), identity: canonical })).toThrow(/location/);
    const statePath = convergeRunStatePath(join(cwd, '.git'), input.target);
    const attemptsPath = convergeAttemptStatePath(join(cwd, '.git'), input.target);
    await mkdir(dirname(statePath), { recursive: true });
    await mkdir(dirname(attemptsPath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(attemptsPath, JSON.stringify({ version: 1, target: input.target, attemptsUsed: 4, cap: 20, updatedAt: state.updatedAt }));
    const dataDir = join(cwd, 'data');
    await new Outbox(join(dataDir, 'outbox')).spoolEvents([
      buildEvent({ kind: 'attempt_claimed', convergeTarget: 'unrelated', attempt: 1, payload: { cap: 20 } }),
    ]);
    await writeFile(join(dataDir, 'outcomes.jsonl'), '{"synthetic":true}\n');
    await mkdir(join(cwd, '.harness-cli'));
    await writeFile(join(cwd, '.harness-cli', 'config.json'), JSON.stringify({ team: 'RCL' }));
    const reasonFile = join(cwd, 'reason.txt');
    await writeFile(reasonFile, reason);
    const before = { ...await snapshot(join(cwd, '.git')), ...await snapshot(dataDir) };
    const originalRun = JSON.stringify(input.run);
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const server = createServer(async (req, res) => {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        requests.push({ method: req.method!, url: req.url!, body });
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = req.method === 'GET' ? 200 : 201;
        res.end(JSON.stringify({ data: req.method === 'GET' ? input.run : { inserted: 1, duplicates: 0 } }));
      } catch {
        res.statusCode = 400;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected local server');
      for (const submit of [false, true]) {
        requests.length = 0;
        const started = Date.now();
        const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'),
          fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'evidence', 'retriage-finding',
          '--target', input.target, '--run', runId, '--report-sha256', digest,
          '--finding-ref', 'f002', '--for-pr', 'example/project#42', '--reason-file', reasonFile,
          ...(submit ? ['--submit'] : [])], {
          cwd, env: { PATH: process.env.PATH, HOME: cwd, RCL_DATA_DIR: dataDir,
            HARNESS_API_TOKEN: 'aone_SYNTHETIC_TEST_TOKEN', HARNESS_API_URL: `http://127.0.0.1:${address.port}`,
            TSX_DISABLE_CACHE: '1', NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
        });
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        expect(code, stderr).toBe(0);
        expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
          `GET /api/v1/reviews/runs/${runId}`, ...(submit ? ['POST /api/v1/reviews/converge/events'] : []),
        ]);
        if (submit) {
          const events = JSON.parse(requests[1]!.body).events;
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({ kind: 'verdicts_recorded', run_id: runId, round: 3,
            converge_target: input.target, payload: { finding_ref: 'f002', report_json_sha256: digest,
              verdicts: [{ identity_key: reportKey, verdict: 'dismissed', severity: 'critical', reason }] } });
          expect(events[0]).not.toHaveProperty('attempt');
          expect(Date.parse(events[0].occurred_at)).toBeGreaterThanOrEqual(started);
          expect(stdout).toContain('not a convergence verdict');
        } else {
          expect(stdout).toContain('Preview');
          expect(stdout).toContain('critical');
          expect(stdout).toContain('--submit');
        }
        expect({ ...await snapshot(join(cwd, '.git')), ...await snapshot(dataDir) }).toEqual(before);
        expect(JSON.stringify(input.run)).toBe(originalRun);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  }, 30_000);
});
