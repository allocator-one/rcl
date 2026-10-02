import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, hasHealthyGuardedLaunch } from '../../src/converge/launch-guard.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport } from '../../src/converge/run-state.js';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { previewTerminalRejection, applyTerminalRejection } from '../../src/converge/terminal-rejection.js';
import { rejectionManifest } from '../../src/converge/terminal-rejection-schema.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';
import { deliverRun, guardedDeliveryState, type TelemetryRuntime } from '../../src/telemetry/deliver.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { Quarantine } from '../../src/telemetry/quarantine.js';
import { sampleResult, sampleReview } from '../telemetry/fixtures.js';
import { serializeRecoveryDocument } from '../../src/evidence/original-run/journal.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import type { ReviewCycleReceipt } from '../../src/converge/review-cycle.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(legacy = true, cap = 20) {
  const common = await mkdtemp(join(tmpdir(), 'rcl-terminal-')); roots.push(common);
  const dataDir = join(common, 'data'); await mkdir(dataDir, { mode: 0o700 });
  const target = 'synthetic-9220', headSha = 'a'.repeat(40), inputSha256 = 'b'.repeat(64), reportPath = join(common, 'original-report.json');
  const rt: TelemetryRuntime = { level: 'full', repoManaged: true, parseFailures: false,
    dataDir, rclVersion: '4.4.18', outbox: new Outbox(join(dataDir, 'outbox')), quarantine: new Quarantine(join(dataDir, 'quarantine')), stderr: () => {} };
  let active: ReviewCycleReceipt | null = null;
  const cycleRemote = { repo: 'allocator-one/rcl', prNumber: 42, url: 'https://harness.example', current: vi.fn(async () => active),
    start: vi.fn(async (request: any) => { active = { ...request, id: randomUUID(), inserted_at: new Date().toISOString() }; return active!; }) };
  const result = sampleResult();
  result.run!.rcl_version = '4.4.18';
  result.run!.roster = Array.from({ length: 10 }, (_, i) => ({ model: `openai/seat${i}`, role: 'bug-hunter', provider: 'openai', lane: 'blocking' as const }));
  result.reviews = result.run!.roster.map((seat, i) => sampleReview({ ...seat, status: i < 7 ? 'success' : 'error', error: i < 7 ? undefined : 'synthetic failure' }));
  result.stats.totalReviews = 10; result.stats.successfulReviews = 7;
  delete result.findings[0]!.gating;
  const health = { version: 1 as const, policy: resolveQuorumPolicy(10), successfulSeats: 7 };
  const options = { gitCommonDir: common, target, headSha, inputSha256, cycleRemote, maxAttempts: cap, validate: vi.fn(async () => {}) };
  for (let attempt = 1; attempt <= 2; attempt++) {
    await expect(guardReviewLaunch({ ...options, startOver: attempt === 1, retryReason: attempt === 1 ? undefined : 'synthetic prior failure diagnosed',
      run: async () => { throw new Error('synthetic previous failed attempt'); } })).rejects.toThrow('synthetic previous failed attempt');
  }
  await guardReviewLaunch({ ...options, retryReason: 'synthetic prior failure diagnosed', run: async context => {
    result.run!.cycle_id = context.cycleId;
    result.run!.converge = { target, attempt: context.attempt, round: context.round };
    const bytes = JSON.stringify(result); await writeFile(reportPath, bytes, { mode: 0o600 });
    const outcome = await deliverRun(rt, { result, artifacts: { report_json: bytes }, evidenceRequired: true });
    expect(outcome).toMatchObject({ status: 'rejected', spooled: false, exitCode: 4, failureDisposition: 'local-invalid' });
    return { runId: result.run!.id, reportJsonSha256: sha256(bytes), successfulReviews: 7, totalReviews: 10,
      reviewerHealth: health, ...(legacy ? { deliveryPending: outcome.spooled || outcome.exitCode !== 0 } : guardedDeliveryState(outcome)),
      hardFailure: true, exitCode: 4, reportPath };
  } });
  // Model the now-exited coordinator without killing or consulting any real task.
  const nativePath = convergeRunStatePath(common, target), attemptsPath = convergeAttemptStatePath(common, target);
  const state = JSON.parse(await readFile(nativePath, 'utf8')), attempts = JSON.parse(await readFile(attemptsPath, 'utf8'));
  state.lastLaunch.pid = 99999999; attempts.attempts[2].pid = 99999999;
  await writeFile(nativePath, JSON.stringify(state)); await writeFile(attemptsPath, JSON.stringify(attempts));
  const selection = { target, runId: result.run!.id, reportPath, reportSha256: sha256(await readFile(reportPath)), reason: 'Original strict-fallback labels rejected locally; fix verified before bounded retry.' };
  const preview = () => previewTerminalRejection(selection, common, dataDir);
  const prepare = async () => {
    const manifest = await preview(), path = join(common, 'recovery.json'), bytes = serializeRecoveryDocument(manifest);
    await writeFile(path, bytes, { mode: 0o600 });
    return { manifest, input: { manifest: path, manifestSha256: sha256(bytes) } };
  };
  const nextRun = vi.fn(async () => ({ runId: randomUUID(), reportJsonSha256: 'e'.repeat(64), successfulReviews: 10, totalReviews: 10,
    reviewerHealth: { ...health, successfulSeats: 10 }, deliveryPending: false }));
  return { common, dataDir, options, state, selection, preview, prepare, nativePath, attemptsPath, result, rt, nextRun };
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  const q = join(f.dataDir, 'quarantine', f.selection.runId);
  return { native: await readFile(f.nativePath), attempts: await readFile(f.attemptsPath), report: await readFile(f.selection.reportPath),
    quarantine: await Promise.all((await readdir(q)).sort().map(async name => [name, await readFile(join(q, name))])) };
}

it.each([true, false])('preserves healthy 7/10 attempt3 and only the later guarded retry claims attempt4/round1 (legacy=%s)', async legacy => {
  const f = await fixture(legacy), before = await snapshot(f);
  await expect(guardReviewLaunch({ ...f.options, retryReason: 'A reason alone cannot dispose evidence', run: f.nextRun }))
    .rejects.toThrow(legacy ? 'delivery_pending' : 'terminal_rejection_proof_required');
  const { input, manifest } = await f.prepare();
  expect(await snapshot(f)).toEqual(before);
  expect(await applyTerminalRejection(input, f.common, f.dataDir)).toBe('applied');
  const applied = await snapshot(f);
  expect(applied.attempts).toEqual(before.attempts); expect(applied.report).toEqual(before.report); expect(applied.quarantine).toEqual(before.quarantine);
  const state = (await loadConvergeRunState(f.common, f.selection.target))!;
  expect(state).toMatchObject({ cycle: f.state.cycle, rounds: [], lastLaunch: { ...f.state.lastLaunch, deliveryPending: false } });
  expect(hasHealthyGuardedLaunch(state.lastLaunch!)).toBe(true);
  expect(rejectionManifest(state.terminalRejections![0]!)).toEqual(manifest);
  const dir = join(f.common, 'rcl-terminal-rejections', manifest.operationId);
  expect(await readFile(join(dir, 'native-before.json'))).toEqual(before.native);
  expect(await readFile(join(dir, 'attempts-before.json'))).toEqual(before.attempts);
  expect(await applyTerminalRejection(input, f.common, f.dataDir)).toBe('unchanged');
  expect(await snapshot(f)).toEqual(applied);
  await expect(guardReviewLaunch({ ...f.options, run: f.nextRun })).rejects.toThrow('terminal_rejection_retry_reason');
  const brokenPreflight = vi.fn(async () => { throw new Error('synthetic output preflight failed'); });
  await expect(guardReviewLaunch({ ...f.options, validate: brokenPreflight, retryReason: 'bounded retry', run: f.nextRun })).rejects.toThrow('synthetic output preflight failed');
  expect((await snapshot(f)).attempts).toEqual(before.attempts);
  await expect(processRoundReport({ gitCommonDir: f.common, target: f.selection.target, round: 1,
    runId: f.selection.runId, reportSha256: f.selection.reportSha256, findings: f.result.findings,
    cycleId: f.state.cycle.id })).rejects.toThrow('terminal_rejection_cannot_be_admitted');
  const claim = await guardReviewLaunch({ ...f.options, retryReason: 'Producer label fix verified; bounded new review', run: f.nextRun });
  expect(claim).toMatchObject({ attempt: 4, attemptsUsed: 4, cap: 20, cycle: f.state.cycle });
  expect(f.nextRun).toHaveBeenCalledTimes(1);
  expect(f.nextRun).toHaveBeenCalledWith({ target: f.selection.target, round: 1, attempt: 4, cycleId: f.state.cycle.id }, expect.anything());
  expect((await loadConvergeRunState(f.common, f.selection.target))!.rounds).toEqual([]);
  await expect(applyTerminalRejection(input, f.common, f.dataDir)).rejects.toThrow('state_changed');
});

it.each(['quarantine-missing', 'quarantine-tampered', 'outbox', 'reviewer-outbox', 'live-owner', 'uncertain-owner', 'admitted', 'changed-attempt', 'wrong-report', 'acknowledged', 'valid-report'] as const)
  ('refuses %s proof without native mutation', async kind => {
    const f = await fixture(), { input } = await f.prepare();
    if (kind === 'quarantine-missing') await rm(join(f.dataDir, 'quarantine', f.selection.runId, 'manifest.json'));
    if (kind === 'quarantine-tampered') await writeFile(join(f.dataDir, 'quarantine', f.selection.runId, 'report.json'), '{}');
    if (kind === 'outbox' || kind === 'reviewer-outbox') await mkdir(join(f.dataDir, kind, f.selection.runId), { recursive: true });
    if (kind === 'live-owner') vi.spyOn(process, 'kill').mockImplementation(() => true);
    if (kind === 'uncertain-owner') vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('uncertain'), { code: 'EPERM' }); });
    if (kind === 'admitted') {
      f.state.rounds = [{ round: 1, runId: f.selection.runId, counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } }];
      await writeFile(f.nativePath, JSON.stringify(f.state));
    }
    if (kind === 'changed-attempt') {
      const attempts = JSON.parse(await readFile(f.attemptsPath, 'utf8')); attempts.attemptsUsed++;
      await writeFile(f.attemptsPath, JSON.stringify(attempts));
    }
    if (kind === 'wrong-report') f.selection.reportSha256 = 'f'.repeat(64);
    if (kind === 'acknowledged') {
      const q = join(f.dataDir, 'quarantine', f.selection.runId), m = JSON.parse(await readFile(join(q, 'manifest.json'), 'utf8'));
      m.acknowledged = true; const bytes = JSON.stringify(m);
      await writeFile(join(q, 'manifest.json'), bytes); await writeFile(join(q, 'pending.json'), bytes);
    }
    if (kind === 'valid-report') {
      f.result.findings[0]!.gating = { reason: 'consensus' };
      const bytes = JSON.stringify(f.result); await writeFile(f.selection.reportPath, bytes);
      f.selection.reportSha256 = sha256(bytes); f.state.lastLaunch.reportJsonSha256 = sha256(bytes);
      await writeFile(f.nativePath, JSON.stringify(f.state));
    }
    const native = await readFile(f.nativePath), attempts = await readFile(f.attemptsPath);
    await expect(f.preview()).rejects.toThrow();
    if (kind !== 'wrong-report') await expect(applyTerminalRejection(input, f.common, f.dataDir)).rejects.toThrow();
    expect(await readFile(f.nativePath)).toEqual(native); expect(await readFile(f.attemptsPath)).toEqual(attempts);
    expect(f.nextRun).not.toHaveBeenCalled();
  });

it('refuses missing retained proof after apply and does not spend the next claim', async () => {
  const f = await fixture(), { input, manifest } = await f.prepare();
  await applyTerminalRejection(input, f.common, f.dataDir);
  await rm(join(f.common, 'rcl-terminal-rejections', manifest.operationId, 'native-before.json'));
  const before = await readFile(f.attemptsPath);
  await expect(guardReviewLaunch({ ...f.options, retryReason: 'Cannot bypass missing proof', run: f.nextRun })).rejects.toThrow();
  expect(await readFile(f.attemptsPath)).toEqual(before); expect(f.nextRun).not.toHaveBeenCalled();
});

it('does not refund or override an exhausted attempt budget', async () => {
  const f = await fixture(true, 3), { input } = await f.prepare();
  await applyTerminalRejection(input, f.common, f.dataDir);
  const before = await readFile(f.attemptsPath);
  await expect(guardReviewLaunch({ ...f.options, retryReason: 'No extra budget granted', run: f.nextRun })).rejects.toThrow('budget exhausted');
  expect(await readFile(f.attemptsPath)).toEqual(before); expect(f.nextRun).not.toHaveBeenCalled();
});

it('serializes competing apply calls to one audit and no new claim', async () => {
  const f = await fixture(), { input } = await f.prepare(), before = await readFile(f.attemptsPath);
  const results = await Promise.allSettled([applyTerminalRejection(input, f.common, f.dataDir), applyTerminalRejection(input, f.common, f.dataDir)]);
  expect(results.some(r => r.status === 'fulfilled' && r.value === 'applied')).toBe(true);
  expect((await loadConvergeRunState(f.common, f.selection.target))!.terminalRejections).toHaveLength(1);
  expect(await readFile(f.attemptsPath)).toEqual(before);
});

it('uses retained originals after source cleanup and admits the later normal report', async () => {
  const f = await fixture(), { input } = await f.prepare();
  await applyTerminalRejection(input, f.common, f.dataDir);
  await rm(f.selection.reportPath); await rm(join(f.dataDir, 'quarantine'), { recursive: true });
  await guardReviewLaunch({ ...f.options, retryReason: 'bounded retry after supported recovery', run: f.nextRun });
  const launch = (await loadConvergeRunState(f.common, f.selection.target))!.lastLaunch!;
  await processRoundReport({ gitCommonDir: f.common, target: f.selection.target, round: 1, runId: launch.runId!,
    reportSha256: launch.reportJsonSha256!, findings: [], cycleId: f.state.cycle.id });
  expect((await loadConvergeRunState(f.common, f.selection.target))!.rounds).toHaveLength(1);
});

it('verifies retained history before retrying a subsequently failed launch', async () => {
  const f = await fixture(), { input, manifest } = await f.prepare();
  await applyTerminalRejection(input, f.common, f.dataDir);
  await expect(guardReviewLaunch({ ...f.options, retryReason: 'bounded retry', run: async () => { throw new Error('synthetic attempt4 failed'); } })).rejects.toThrow('synthetic attempt4 failed');
  await rm(join(f.common, 'rcl-terminal-rejections', manifest.operationId, 'report.json'));
  const before = await readFile(f.attemptsPath);
  await expect(guardReviewLaunch({ ...f.options, retryReason: 'cannot bypass audit', run: f.nextRun })).rejects.toThrow();
  expect(await readFile(f.attemptsPath)).toEqual(before); expect(f.nextRun).not.toHaveBeenCalled();
});


it.each(['forged-label-diagnostic', 'transport-refusal'])('refuses self-consistent valid evidence with %s', async kind => {
  const f = await fixture();
  f.result.findings[0]!.gating = { reason: 'consensus' };
  const bytes = JSON.stringify(f.result), artifacts = { report_json: bytes };
  await writeFile(f.selection.reportPath, bytes);
  f.selection.reportSha256 = sha256(bytes); f.state.lastLaunch.reportJsonSha256 = sha256(bytes);
  await writeFile(f.nativePath, JSON.stringify(f.state));
  await rm(join(f.dataDir, 'quarantine'), { recursive: true });
  expect(await f.rt.quarantine!.retain({ runId: f.selection.runId, artifacts,
    envelope: buildRunEnvelope(f.result, artifacts, { level: 'full', delivery: { mode: 'direct' }, parseFailures: false }),
    events: [], requestedMode: 'asserted', acknowledged: false,
    diagnostics: kind === 'transport-refusal' ? [{ path: 'delivery', message: 'HTTP 422 rejected' }]
      : [{ path: 'findings.0.gating.reason', message: 'Verified-consensus finding is missing a valid gating label' }] })).toMatchObject({ status: 'complete' });
  const before = await snapshot(f);
  await expect(f.preview()).rejects.toThrow('unsupported_local_rejection');
  expect(await snapshot(f)).toEqual(before);
});

it.each(['outbox', 'reviewer-outbox'])('rechecks late %s before the next guarded claim', async queue => {
  const f = await fixture(), { input } = await f.prepare();
  await applyTerminalRejection(input, f.common, f.dataDir);
  await mkdir(join(f.dataDir, queue, f.selection.runId), { recursive: true, mode: 0o700 });
  const before = await readFile(f.attemptsPath);
  await expect(guardReviewLaunch({ ...f.options, retryReason: 'Cannot bypass late queued evidence', run: f.nextRun })).rejects.toThrow('pending_delivery');
  expect(await readFile(f.attemptsPath)).toEqual(before); expect(f.nextRun).not.toHaveBeenCalled();
});

it('the supported CLI previews, pins and idempotently applies synthetic recovery without claiming', async () => {
  const f = await fixture(), exec = promisify(execFile);
  await exec('git', ['init', '--bare', f.common]);
  const cli = resolve('src/index.ts'), loader = resolve('node_modules/tsx/dist/cli.mjs');
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, RCL_DATA_DIR: f.dataDir,
    XDG_CONFIG_HOME: join(f.common, 'config'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (...args: string[]) => exec(process.execPath, [loader, cli, 'converge-rejected', ...args], { cwd: f.common, env });
  const path = join(f.common, 'cli-preview.json'), before = await snapshot(f);
  const preview = JSON.parse((await run('--preview', '--manifest', path, '--target', f.selection.target,
    '--run', f.selection.runId, '--report', f.selection.reportPath, '--report-sha256', f.selection.reportSha256, '--reason', f.selection.reason, '--json')).stdout);
  expect(preview.accounting).toBe('unchanged'); expect(await snapshot(f)).toEqual(before);
  await expect(run('--apply', '--manifest', path, '--manifest-sha256', 'f'.repeat(64))).rejects.toMatchObject({ code: 3 });
  expect(await snapshot(f)).toEqual(before);
  expect(JSON.parse((await run('--apply', '--manifest', path, '--manifest-sha256', preview.manifestSha256)).stdout).result).toBe('applied');
  expect(JSON.parse((await run('--apply', '--manifest', path, '--manifest-sha256', preview.manifestSha256)).stdout).result).toBe('unchanged');
  expect(await readFile(f.attemptsPath)).toEqual(before.attempts);
  expect(await readFile(f.selection.reportPath)).toEqual(before.report);
}, 15000);


it.each(['missing', 'truncated'])('detects %s terminal audit before admission or another claim', async kind => {
  const f = await fixture(), { input } = await f.prepare();
  await applyTerminalRejection(input, f.common, f.dataDir);
  const state = JSON.parse(await readFile(f.nativePath, 'utf8'));
  if (kind === 'missing') delete state.terminalRejections; else state.terminalRejections = [];
  await writeFile(f.nativePath, JSON.stringify(state));
  const before = await readFile(f.attemptsPath);
  await expect(processRoundReport({ gitCommonDir: f.common, target: f.selection.target, round: 1,
    runId: f.selection.runId, reportSha256: f.selection.reportSha256, findings: f.result.findings,
    cycleId: f.state.cycle.id })).rejects.toThrow('terminal_rejection_audit_invalid');
  await expect(guardReviewLaunch({ ...f.options, retryReason: 'cannot bypass truncated audit', run: f.nextRun })).rejects.toThrow('terminal_rejection_audit_invalid');
  expect(await readFile(f.attemptsPath)).toEqual(before);
});
