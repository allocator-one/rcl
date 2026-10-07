import { expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileFlushedRun } from '../../src/converge/delivery-reconciliation.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { reviewCycleDirectory } from '../../src/converge/fresh-review.js';
import { previewStaleReport, verifyStaleReportReceipts } from '../../src/converge/stale-report.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { MAX_ARTIFACT_BYTES } from '../../src/telemetry/envelope-validation.js';
import type { HarnessSink } from '../../src/telemetry/sink.js';
import { reconciledHardFailureFixture } from './stale-report-fixtures.js';

const clean = { remaining: [], failed: [], dropped: [] };
const fixed = new Date('2026-10-07T10:00:00.000Z');

/** A pre-cycle producer omitted the native exit code; report ci_exit_code remains 1. */
async function legacyFixture(git = false, targetKind: 'patch' | 'pr' = 'patch') {
  const f = await reconciledHardFailureFixture(git, true);
  const state = (await loadConvergeRunState(f.dir, f.target))!;
  state.rounds = Array.from({ length: 3 }, (_, index) => ({ ...state.rounds[0]!, round: index + 1 }));
  state.lastAnnotations!.round = 3;
  for (const finding of Object.values(state.findings)) finding.verdictRound = 3;
  state.lastLaunch!.attempt = 4;
  state.lastLaunch!.round = 4;
  delete state.lastLaunch!.exitCode;
  delete state.lastLaunch!.deliveryReconciliation;
  const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
  report.run.converge = { target: f.target, attempt: 4, round: 4 };
  report.run.rcl_version = '4.1.10';
  report.run.target.kind = targetKind;
  await writeFile(f.reportPath, JSON.stringify(report));
  f.reportSha256 = sha256(await readFile(f.reportPath));
  f.selection.reportSha256 = f.reportSha256;
  f.hardFailureSelection.reportSha256 = f.reportSha256;
  state.lastLaunch!.reportJsonSha256 = f.reportSha256;
  await writeFile(f.statePath, JSON.stringify(state));
  const attempts = JSON.parse(await readFile(f.attemptsPath, 'utf8'));
  attempts.attemptsUsed = 4;
  attempts.attempts = Array.from({ length: 4 }, (_, index) => ({ ...attempts.attempts[0], attempt: index + 1 }));
  await writeFile(f.attemptsPath, JSON.stringify(attempts));
  const detail = {
    id: state.lastLaunch!.runId!, provenance: 'live', cycle_id: null,
    converge: { ...report.run.converge },
    target: { ...report.run.target },
    artifacts: [{ kind: 'report_json', stored: true, declared_sha256: f.reportSha256,
      declared_bytes: Buffer.byteLength(JSON.stringify(report)) }],
    findings: [], calls: [],
  };
  const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: detail });
  const getArtifact = vi.fn().mockResolvedValue({ kind: 'ok', value: {
    bytes: await readFile(f.reportPath), sha256: f.reportSha256,
  } });
  const sink = { getArtifact } as unknown as HarnessSink;
  const flush = () => reconcileFlushedRun(detail.id, clean, sink,
    { gitCommonDir: f.dir, getRun, now: () => fixed });
  return { ...f, state, report, detail, getRun, getArtifact, sink, flush };
}

it.each(['patch', 'pr'] as const)('authenticates the completed legacy %s launch without fabricating its omitted terminal exit code', async kind => {
  const f = await legacyFixture(false, kind), before = await f.bytes();
  expect(f.state).toMatchObject({ version: 1, roundCap: 15, lastLaunch: {
    attempt: 4, round: 4, status: 'completed', hardFailure: true, deliveryPending: false,
    reviewerHealth: { policy: { seatCount: 10, minimumSuccessful: 7 }, successfulSeats: 7 },
  } });
  expect(f.state).not.toHaveProperty('cycle');
  expect(f.state.lastLaunch).not.toHaveProperty('exitCode');
  expect(f.state.lastLaunch).not.toHaveProperty('deliveryReconciliation');
  expect(f.report.run.ci_exit_code).toBe(1);
  expect(f.report.run.target).toMatchObject({ kind, repo: 'allocator-one/rcl', pr_number: 42 });
  await expect(previewStaleReport(f.hardFailureSelection, f.dir)).rejects.toThrow('stale_report_outcome_ineligible');
  await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason: f.retryReason }))
    .rejects.toThrow('report_not_admitted');
  expect(await f.bytes()).toEqual(before);

  await expect(f.flush()).resolves.toBe('reconciled');
  expect(f.getArtifact).toHaveBeenCalledWith(f.detail.id, 'report_json', MAX_ARTIFACT_BYTES);

  const after = (await loadConvergeRunState(f.dir, f.target))!;
  expect(after).toEqual({ ...f.state, updatedAt: fixed.toISOString(), lastLaunch: {
    ...f.state.lastLaunch, deliveryReconciliation: {
      version: 2, runId: f.detail.id, reportJsonSha256: f.reportSha256,
      headSha: f.state.lastLaunch!.headSha, inputSha256: f.state.lastLaunch!.inputSha256,
      attempt: 4, round: 4, claimPid: f.state.lastLaunch!.pid,
      cycleId: null, reconciledAt: fixed.toISOString(),
    },
  } });
  expect(after.lastLaunch).not.toHaveProperty('exitCode');
  expect((await f.bytes()).slice(1)).toEqual(before.slice(1));
  const reconciledBytes = await f.bytes();
  await expect(f.flush()).resolves.toBe('unchanged');
  expect(await f.bytes()).toEqual(reconciledBytes);
  expect(f.getArtifact).toHaveBeenCalledOnce();
  expect(f.options.run).toHaveBeenCalledOnce();
});

it.each([
  ['explicit success', (state: any) => { state.lastLaunch.exitCode = 0; }],
  ['explicit report failure', (state: any) => { state.lastLaunch.exitCode = 1; }],
  ['explicit unknown outcome', (state: any) => { state.lastLaunch.exitCode = 2; }],
  ['explicit infrastructure outcome', (state: any) => { state.lastLaunch.exitCode = 3; }],
  ['explicit unrecognized outcome', (state: any) => { state.lastLaunch.exitCode = 5; }],
  ['explicit null outcome', (state: any) => { state.lastLaunch.exitCode = null; }],
  ['explicit string outcome', (state: any) => { state.lastLaunch.exitCode = '4'; }],
  ['unknown delivery status', (state: any) => { delete state.lastLaunch.deliveryPending; }],
  ['non-completed launch', (state: any) => { state.lastLaunch.status = 'pending'; delete state.lastLaunch.reviewerHealth; }],
  ['failed launch', (state: any) => { state.lastLaunch.status = 'failed'; delete state.lastLaunch.reviewerHealth; }],
  ['ordinary successful launch', (state: any) => { state.lastLaunch.hardFailure = false; }],
  ['unknown failure status', (state: any) => { delete state.lastLaunch.hardFailure; }],
  ['refused delivery', (state: any) => { state.lastLaunch.deliveryFailure = 'local-invalid'; }],
  ['missing blocking health', (state: any) => { delete state.lastLaunch.reviewerHealth; }],
  ['insufficient blocking quorum', (state: any) => { state.lastLaunch.reviewerHealth.successfulSeats = 6; }],
  ['invalid quorum policy', (state: any) => { state.lastLaunch.reviewerHealth.policy.minimumSuccessful = 1; }],
  ['invalid aggregate counts', (state: any) => { state.lastLaunch.successfulReviews = 6; }],
  ['pending retained recovery', (state: any) => { state.lastLaunch.pendingResume = {}; }],
  ['modern ordinary input binding', (state: any) => { state.lastLaunch.ordinaryInputs = { version: 1, packetSha256: 'e'.repeat(64), baseSha: null }; }],
])('does not reinterpret %s as the supported legacy omission', async (_label, mutate) => {
  const f = await legacyFixture();
  mutate(f.state);
  await writeFile(f.statePath, JSON.stringify(f.state));
  const before = await f.bytes();
  await expect(f.flush()).resolves.toBe('unchanged');
  expect(await f.bytes()).toEqual(before);
  expect(f.options.run).toHaveBeenCalledOnce();
});

it.each([
  ['missing live provenance', (detail: any) => { delete detail.provenance; }],
  ['backfilled provenance', (detail: any) => { detail.provenance = 'backfill'; }],
  ['different run', (detail: any) => { detail.id = '019921a0-0000-7000-8000-000000000002'; }],
  ['unrelated target', (detail: any) => { detail.converge.target = 'unrelated'; }],
  ['different head', (detail: any) => { detail.target.head_sha = 'e'.repeat(40); }],
  ['different repository', (detail: any) => { detail.target.repo = 'other/repo'; }],
  ['different pull request', (detail: any) => { detail.target.pr_number = 43; }],
  ['different round', (detail: any) => { detail.converge.round = 5; }],
  ['different attempt', (detail: any) => { detail.converge.attempt = 5; }],
  ['server cycle on legacy native state', (detail: any) => { detail.cycle_id = '019921a0-0000-7000-8000-000000000099'; }],
  ['unstored report', (detail: any) => { detail.artifacts[0].stored = false; }],
  ['missing stored digest', (detail: any) => { delete detail.artifacts[0].declared_sha256; }],
  ['different stored digest', (detail: any) => { detail.artifacts[0].declared_sha256 = 'e'.repeat(64); }],
  ['ambiguous report artifacts', (detail: any) => { detail.artifacts.push({ ...detail.artifacts[0] }); }],
])('refuses legacy reconciliation with %s without touching history', async (_label, mutate) => {
  const f = await legacyFixture();
  const detail = structuredClone(f.detail);
  mutate(detail);
  f.getRun.mockResolvedValue({ kind: 'ok', value: detail });
  const before = await f.bytes();
  await expect(f.flush()).resolves.toBe('unchanged');
  expect(await f.bytes()).toEqual(before);
});

it('does not reconstruct a missing attempt ledger to recover the legacy launch', async () => {
  const f = await legacyFixture(), before = await f.bytes();
  await rm(f.attemptsPath);
  await expect(f.flush()).resolves.toBe('unchanged');
  expect(await readFile(f.statePath)).toEqual(before[0]);
  expect(await readFile(f.reportPath)).toEqual(before[2]);
  await expect(readFile(f.attemptsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.getArtifact).not.toHaveBeenCalled();
});

it('refuses a prepared fresh-review transition before reading an artifact or changing native state', async () => {
  const f = await legacyFixture(), before = await f.bytes();
  const directory = reviewCycleDirectory(f.dir, f.target);
  const operationId = '019921a0-0000-7000-8000-000000000099';
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const currentPath = join(directory, 'current.json'), operationPath = join(directory, `${operationId}.json`);
  await writeFile(currentPath, JSON.stringify({ operationId }));
  await writeFile(operationPath, JSON.stringify({ version: 1, target: f.target, operationId,
    repo: 'allocator-one/rcl', prNumber: 42, url: 'https://harness.example', headSha: f.selection.headSha,
    previousCycleId: null, attemptCap: 20, roundCap: 15, archiveSha256: 'e'.repeat(64), phase: 'prepared' }));
  const journalBefore = await Promise.all([currentPath, operationPath].map(path => readFile(path)));
  await expect(f.flush()).resolves.toBe('unchanged');
  expect(await f.bytes()).toEqual(before);
  expect(await Promise.all([currentPath, operationPath].map(path => readFile(path)))).toEqual(journalBefore);
  expect(f.getArtifact).not.toHaveBeenCalled();
});

it.each([
  ['different original claim PID', (attempts: any) => { attempts.attempts[3].pid += 1; delete attempts.attempts[3].processIdentity; }],
  ['different latest attempt', (attempts: any) => { attempts.attempts.push({ ...attempts.attempts[3], attempt: 5 }); attempts.attemptsUsed = 5; }],
  ['non-claim source', (attempts: any) => { attempts.attempts[3].source = 'unknown'; }],
  ['cycle-backed attempt ledger', (attempts: any) => { attempts.version = 2; attempts.cycle = {}; }],
  ['handed-off claim', (attempts: any) => { attempts.attempts[3].handoff = {}; }],
])('refuses a legacy launch with %s before creating a receipt', async (_label, mutate) => {
  const f = await legacyFixture();
  const attempts = JSON.parse(await readFile(f.attemptsPath, 'utf8'));
  mutate(attempts);
  await writeFile(f.attemptsPath, JSON.stringify(attempts));
  const before = await f.bytes();
  await expect(f.flush()).resolves.toBe('unchanged');
  expect(await f.bytes()).toEqual(before);
});

it.each([
  ['wrong artifact digest', () => ({ kind: 'ok', value: { bytes: Buffer.from('{}'), sha256: 'e'.repeat(64) } })],
  ['dishonest raw bytes receipt', (f: any) => ({ kind: 'ok', value: { bytes: Buffer.from('{}'), sha256: f.reportSha256 } })],
  ['unavailable artifact', () => ({ kind: 'unavailable', reason: 'timeout' })],
  ['refused artifact', () => ({ kind: 'rejected', httpStatus: 403, error: 'forbidden', message: 'Refused' })],
])('refuses %s without changing the legacy launch', async (_label, outcome) => {
  const f = await legacyFixture(), before = await f.bytes();
  f.getArtifact.mockResolvedValue(outcome(f));
  await expect(f.flush()).resolves.toBe('unchanged');
  expect(await f.bytes()).toEqual(before);
});

it.each([
  ['run ID', (report: any) => { report.run.id = '019921a0-0000-7000-8000-000000000002'; }],
  ['head', (report: any) => { report.run.target.head_sha = 'e'.repeat(40); }],
  ['target', (report: any) => { report.run.converge.target = 'unrelated'; }],
  ['round', (report: any) => { report.run.converge.round = 5; }],
  ['attempt', (report: any) => { report.run.converge.attempt = 5; }],
  ['cycle', (report: any) => { report.run.cycle_id = '019921a0-0000-7000-8000-000000000099'; }],
  ['backfill', (report: any) => { report.run.provenance = 'backfill'; }],
  ['gating mode', (report: any) => { report.run.gating.mode = 'all-findings'; }],
  ['unsupported report outcome', (report: any) => { report.run.ci_exit_code = 4; }],
  ['aggregate counts', (report: any) => { report.stats.successfulReviews = 9; }],
  ['blocking health', (report: any) => { report.reviews[7].status = 'success'; report.reviews[10].status = 'error'; }],
  ['recorded blocking health', (report: any) => {
    report.stats.blockingHealth = { version: 1, fraction: 2 / 3, seats: 10, required: 7, successful: 8,
      conclusive: true, excludedSuccesses: { secondary: 1, async: 0, verification: 0 } };
  }],
])('refuses authenticated report bytes with conflicting %s', async (_label, mutate) => {
  const f = await legacyFixture();
  mutate(f.report);
  const bytes = Buffer.from(JSON.stringify(f.report)), digest = sha256(bytes);
  f.state.lastLaunch!.reportJsonSha256 = digest;
  f.detail.artifacts[0]!.declared_sha256 = digest;
  f.detail.artifacts[0]!.declared_bytes = bytes.length;
  f.getArtifact.mockResolvedValue({ kind: 'ok', value: { bytes, sha256: digest } });
  await writeFile(f.statePath, JSON.stringify(f.state));
  const before = await f.bytes();
  await expect(f.flush()).resolves.toBe('unchanged');
  expect(await f.bytes()).toEqual(before);
});

it.each(['remaining', 'failed', 'dropped'] as const)('does not reconcile an unresolved %s flush', async field => {
  const f = await legacyFixture(), before = await f.bytes();
  const summary = { ...clean, [field]: field === 'remaining' ? [f.detail.id] : [{ id: f.detail.id }] };
  await expect(reconcileFlushedRun(f.detail.id, summary, {} as never,
    { gitCommonDir: f.dir, getRun: f.getRun })).resolves.toBe('unchanged');
  expect(f.getRun).not.toHaveBeenCalled();
  expect(await f.bytes()).toEqual(before);
});

it.each([
  ['claim PID', (_f: any, attempts: any) => { attempts.attempts[3].pid += 1; delete attempts.attempts[3].processIdentity; }, 'stale_report_attempt_mismatch'],
  ['report health', (f: any) => { f.state.lastLaunch.reviewerHealth.successfulSeats = 8; }, 'stale_report_health_binding_mismatch'],
])('retains the existing stale refusal for mismatched %s', async (_label, mutate, error) => {
  const f = await legacyFixture();
  await expect(f.flush()).resolves.toBe('reconciled');
  f.state = (await loadConvergeRunState(f.dir, f.target))!;
  const attempts = JSON.parse(await readFile(f.attemptsPath, 'utf8'));
  mutate(f, attempts);
  await writeFile(f.statePath, JSON.stringify(f.state));
  await writeFile(f.attemptsPath, JSON.stringify(attempts));
  const before = await f.bytes();
  await expect(previewStaleReport(f.hardFailureSelection, f.dir)).rejects.toThrow(error);
  expect(await f.bytes()).toEqual(before);
  expect(f.options.run).toHaveBeenCalledOnce();
});

const packed = process.env.RCL_STALE_PACKED_CLI;
const cli = packed ?? fileURLToPath(new URL('../../src/index.ts', import.meta.url));
async function command(cwd: string, args: string[], transport: string) {
  const inherited = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const child = spawn(process.execPath, [...(packed ? [] : ['--import', import.meta.resolve('tsx')]), '--import', transport, cli, ...args], {
    cwd, timeout: 20000, killSignal: 'SIGKILL', env: { ...inherited,
      NODE_NO_WARNINGS: '1', NO_COLOR: '1', RCL_TELEMETRY: 'full', RCL_DATA_DIR: join(cwd, 'data'),
      XDG_CONFIG_HOME: join(cwd, 'config'), HARNESS_API_TOKEN: 'synthetic-local-only',
      HARNESS_API_URL: 'http://127.0.0.1:1', RCL_NO_HARNESS_KEYS: '1',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, TSX_DISABLE_CACHE: '1',
    },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject); child.on('close', resolve);
  });
  return { code, stdout, stderr };
}

it('recovers through public flush and stale CLI, then permits exactly one successor within the original caps', async () => {
  const f = await legacyFixture(true), before = await f.bytes();
  const transport = join(f.cwd, 'synthetic-harness.mjs');
  const callsPath = join(f.cwd, 'requests.jsonl');
  await mkdir(join(f.cwd, 'config'));
  await writeFile(transport, `import net from 'node:net';
import { appendFileSync } from 'node:fs';
net.Socket.prototype.connect = function(){ throw Error('network forbidden'); };
globalThis.fetch = async (input, init) => {
  const url = String(input), method = init?.method ?? 'GET';
  appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({url, method}) + ${JSON.stringify('\n')});
  if (method !== 'GET') throw Error('unexpected network request');
  if (url === ${JSON.stringify(`http://127.0.0.1:1/api/v1/reviews/runs/${f.detail.id}`)}) {
    return new Response(JSON.stringify({data: ${JSON.stringify(f.detail)}}), {status:200, headers:{'content-type':'application/json'}});
  }
  if (url === ${JSON.stringify(`http://127.0.0.1:1/api/v1/reviews/runs/${f.detail.id}/artifacts/report_json`)}) {
    return new Response(${JSON.stringify(JSON.stringify(f.report))}, {status:200, headers:{'content-type':'application/json','x-artifact-sha256':${JSON.stringify(f.reportSha256)}}});
  }
  throw Error('unexpected network request');
};
`);
  const flush = await command(f.cwd, ['telemetry', 'flush', '--run', f.detail.id, '--json'], transport);
  expect(flush.code, flush.stderr).toBe(0);
  expect(flush.stderr).toContain('Reconciled delivered run');
  expect(JSON.parse(flush.stdout)).toMatchObject({ remaining: [], failed: [], dropped: [] });
  const reconciled = (await loadConvergeRunState(f.dir, f.target))!;
  expect(reconciled.lastLaunch).not.toHaveProperty('exitCode');
  expect(reconciled.lastLaunch!.deliveryReconciliation).toMatchObject({ version: 2, cycleId: null, attempt: 4, round: 4 });
  expect((await f.bytes()).slice(1)).toEqual(before.slice(1));

  const preview = await command(f.cwd, ['converge-stale', '--preview', '--manifest', f.manifestPath, '--target', f.target,
    '--head', f.selection.headSha, '--input-sha256', f.selection.inputSha256, '--report', f.reportPath,
    '--report-sha256', f.reportSha256, '--reason', f.selection.reason, '--retry-reason', f.retryReason], transport);
  expect(preview.code, preview.stderr).toBe(0);
  const manifest = JSON.parse(preview.stdout).manifest;
  expect(manifest).toMatchObject({ version: 3, outcome: 'delivered-hard-failure',
    attempt: 4, round: 4, deliveryReconciliation: reconciled.lastLaunch!.deliveryReconciliation });
  const manifestSha256 = sha256(await readFile(f.manifestPath));
  for (const mode of ['apply', 'resume']) {
    const result = await command(f.cwd, ['converge-stale', `--${mode}`, '--manifest', f.manifestPath,
      '--manifest-sha256', manifestSha256], transport);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe(mode === 'apply' ? 'applied' : 'resumed');
  }
  const disposed = (await loadConvergeRunState(f.dir, f.target))!;
  expect(disposed.rounds).toEqual(f.state.rounds);
  expect(disposed.findings).toEqual(f.state.findings);
  expect(disposed.lastAnnotations).toEqual(f.state.lastAnnotations);
  expect(disposed.lastLaunch).toEqual(reconciled.lastLaunch);
  expect((await f.bytes()).slice(1)).toEqual(before.slice(1));
  expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ cap: 20, attemptsUsed: 4 });
  await expect(verifyStaleReportReceipts(f.dir, disposed.staleReportAudit!)).resolves.toBeUndefined();
  const receipt = join(f.dir, 'rcl-stale-report-audits', manifest.operationId, 'complete.json');
  const receiptBefore = await readFile(receipt);
  const results = await Promise.allSettled([
    guardReviewLaunch({ ...f.options, ...f.selection, retryReason: f.retryReason }),
    guardReviewLaunch({ ...f.options, ...f.selection, retryReason: f.retryReason }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(f.options.run).toHaveBeenCalledTimes(2);
  expect(f.options.run.mock.calls.at(-1)?.[0]).toEqual({ target: f.target, round: 4, attempt: 5 });
  expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ cap: 20, attemptsUsed: 5 });
  const successor = (await loadConvergeRunState(f.dir, f.target))!;
  expect(successor.roundCap).toBe(15);
  expect(successor.rounds).toEqual(f.state.rounds);
  expect(successor.findings).toEqual(f.state.findings);
  expect(successor.staleReportAudit).toEqual(disposed.staleReportAudit);
  expect(await readFile(receipt)).toEqual(receiptBefore);
  expect(await readFile(f.reportPath)).toEqual(before[2]);
  expect((await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { url: `http://127.0.0.1:1/api/v1/reviews/runs/${f.detail.id}`, method: 'GET' },
    { url: `http://127.0.0.1:1/api/v1/reviews/runs/${f.detail.id}/artifacts/report_json`, method: 'GET' },
  ]);
}, 30000);
