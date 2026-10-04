import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { reconcileDeliveredRun } from '../../src/converge/delivery-reconciliation.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { loadConvergeRunState, writeState } from '../../src/converge/run-state.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { applyStaleReport, previewStaleReport } from '../../src/converge/stale-report.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { staleFixture } from './stale-report-fixtures.js';
import { mergedBlockingHealth } from '../../src/converge/legacy-launch-health.js';

const retryReason = 'Authenticated delivery completed; one bounded current-input review.';

async function makeBlockingHealthConclusive(f: Awaited<ReturnType<typeof staleFixture>>) {
  const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
  for (const seat of report.run.roster) seat.lane = 'blocking';
  await writeFile(f.reportPath, JSON.stringify(report));
  f.selection.reportSha256 = sha256(await readFile(f.reportPath));
  return {report,reviewerHealth:mergedBlockingHealth(report,2 / 3)};
}

async function reconcileFixture(f: Awaited<ReturnType<typeof staleFixture>>) {
  const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
  const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: {
    id: report.run.id,
    provenance: 'live', cycle_id: report.run.cycle_id,
    converge: report.run.converge,
    target: { kind: 'pull_request', head_sha: report.run.target.head_sha },
    artifacts: [{ kind: 'report_json', stored: true, declared_sha256: f.selection.reportSha256 }],
    findings: [], calls: [],
  } });
  await expect(reconcileDeliveredRun(report.run.id, {} as never, { gitCommonDir: f.dir, getRun }))
    .resolves.toBe('reconciled');
  return report;
}

async function applyContinuation(f: Awaited<ReturnType<typeof staleFixture>>) {
  const manifest = await previewStaleReport({ ...f.selection, retryReason }, f.dir);
  await writeFile(f.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await applyStaleReport({ manifest: f.manifestPath,
    manifestSha256: sha256(await readFile(f.manifestPath)), mode: 'apply' }, f.dir);
  return manifest;
}

async function reconciledSpecial(withHistory = false) {
  const f = await staleFixture(false, withHistory);
  const {reviewerHealth} = await makeBlockingHealthConclusive(f);
  const state = (await loadConvergeRunState(f.dir,f.target))!;
  state.lastLaunch = {...state.lastLaunch!,reportJsonSha256:f.selection.reportSha256,
    deliveryPending:false,hardFailure:true,exitCode:4,reviewerHealth};
  await writeFile(f.statePath,JSON.stringify(state));
  await reconcileFixture(f);
  return f;
}

describe('reconciled hard-failure stale continuation', () => {
  it('disposes exact reconciled stale evidence before claiming a bounded fresh review', async () => {
    const f = await staleFixture(false, true);
    const {report,reviewerHealth} = await makeBlockingHealthConclusive(f);
    const prior = (await loadConvergeRunState(f.dir, f.target))!;
    prior.lastLaunch = { ...prior.lastLaunch!, reportJsonSha256:f.selection.reportSha256,
      deliveryPending: false, hardFailure: true, exitCode: 4, reviewerHealth };
    await withNativeTarget(f.dir, f.target, owner => writeState(f.dir, prior, owner));

    await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason })).rejects.toThrow('report_not_admitted');
    await expect(previewStaleReport({ ...f.selection, retryReason }, f.dir)).rejects.toThrow('stale_report_outcome_ineligible');
    expect(f.options.run).toHaveBeenCalledOnce();
    expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 1 });

    await reconcileFixture(f);

    await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason }))
      .rejects.toThrow('report_not_admitted');
    expect(f.options.run).toHaveBeenCalledOnce();
    expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 1 });

    const manifest = await previewStaleReport({ ...f.selection, retryReason } as never, f.dir);
    expect(manifest).toMatchObject({
      version: 3,
      outcome: 'delivered-hard-failure',
      runId: report.run.id,
      reportSha256: f.selection.reportSha256,
      retryReason,
      reviewerHealth,
    });
    await writeFile(f.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(applyStaleReport({ manifest: f.manifestPath,
      manifestSha256: sha256(await readFile(f.manifestPath)), mode: 'apply' }, f.dir)).resolves.toBe('applied');

    await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason }))
      .resolves.toMatchObject({ attempt: 2 });
    expect(f.options.run).toHaveBeenCalledTimes(2);
    expect(f.options.run.mock.calls.at(-1)?.[0]).toEqual({ target: f.target, round: 2, attempt: 2 });
    expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 2 });
  });

  it('preserves 25/35 attempts and 13/30 admitted rounds, then derives A26/R14', async () => {
    const f = await staleFixture(false, true);
    for (const [head,input] of [['c','d'],['d','e'],['e','f'],['f','0'],['0','1']]) {
      const manifest = await previewStaleReport({...f.selection,headSha:head.repeat(40),inputSha256:input.repeat(64)},f.dir);
      await writeFile(f.manifestPath,JSON.stringify(manifest));
      await applyStaleReport({manifest:f.manifestPath,manifestSha256:sha256(await readFile(f.manifestPath)),mode:'apply'},f.dir);
    }
    const {report,reviewerHealth} = await makeBlockingHealthConclusive(f);
    const state = (await loadConvergeRunState(f.dir, f.target))!;
    state.rounds = Array.from({ length: 13 }, (_, index) => ({ ...state.rounds[0]!, round: index + 1,
      runId: `019921a0-0000-7000-8000-${String(index + 101).padStart(12, '0')}` }));
    state.roundCap = 30;
    state.lastAnnotations!.round = 13;
    for (const finding of Object.values(state.findings)) finding.verdictRound = 13;
    state.lastLaunch = { ...state.lastLaunch!, attempt: 25, round: 14, deliveryPending: false,
      runId:'01a10372-79b1-7b7f-9254-f8dcb4e0dd8b',hardFailure: true, exitCode: 4, reviewerHealth };
    report.run.id = '01a10372-79b1-7b7f-9254-f8dcb4e0dd8b';
    report.run.converge = { target: f.target, attempt: 25, round: 14 };
    await writeFile(f.reportPath, JSON.stringify(report));
    f.selection.reportSha256 = sha256(await readFile(f.reportPath));
    state.lastLaunch.reportJsonSha256 = f.selection.reportSha256;
    await writeFile(f.statePath, JSON.stringify(state));

    const attempts = JSON.parse(await readFile(f.attemptsPath, 'utf8'));
    attempts.cap = 35; attempts.attemptsUsed = 25;
    attempts.attempts = Array.from({ length: 25 }, (_, index) => ({ ...attempts.attempts[0], attempt: index + 1 }));
    await writeFile(f.attemptsPath, JSON.stringify(attempts));
    await reconcileFixture(f);

    const before = (await loadConvergeRunState(f.dir, f.target))!;
    const beforeAudit = before.staleReportAudit;
    await applyContinuation(f);
    const disposed = (await loadConvergeRunState(f.dir, f.target))!;
    expect(disposed).toMatchObject({ roundCap: 30, lastLaunch: { attempt: 25, round: 14 }, staleReportAuditCount: 6 });
    expect(disposed.rounds).toEqual(before.rounds);
    expect(disposed.findings).toEqual(before.findings);
    expect(disposed.staleReportAudit?.slice(0, beforeAudit?.length ?? 0)).toEqual(beforeAudit ?? []);
    expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 25, cap: 35 });

    await guardReviewLaunch({ ...f.options, ...f.selection, retryReason,
      run: vi.fn(async () => ({ runId: '019921a0-0000-7000-8000-000000000026',
        reportJsonSha256: 'f'.repeat(64), successfulReviews: 0, totalReviews: 2,
        deliveryPending: false, hardFailure: true })) });
    expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 26, cap: 35 });
    expect((await loadConvergeRunState(f.dir, f.target))!.lastLaunch).toMatchObject({ attempt: 26, round: 14 });
  },20000);

  it('requires exact reconciled health, reason, input, and receipt without spending a claim', async () => {
    const f = await staleFixture();
    const {report,reviewerHealth} = await makeBlockingHealthConclusive(f);
    const state = (await loadConvergeRunState(f.dir, f.target))!;
    state.lastLaunch = { ...state.lastLaunch!, deliveryPending: false, hardFailure: true, exitCode: 4,
      reportJsonSha256:f.selection.reportSha256, reviewerHealth };
    await writeFile(f.statePath, JSON.stringify(state));
    await expect(previewStaleReport({ ...f.selection, retryReason }, f.dir)).rejects.toThrow('stale_report_outcome_ineligible');
    await reconcileFixture(f);
    await expect(previewStaleReport(f.selection, f.dir)).rejects.toThrow('stale_report_outcome_ineligible');
    await expect(previewStaleReport({ ...f.selection, headSha: f.options.headSha,
      inputSha256: f.options.inputSha256, retryReason }, f.dir)).rejects.toThrow('inputs_unchanged');

    const manifest = await applyContinuation(f);
    const before = await loadConvergeAttemptState(f.dir, f.target);
    await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason: 'Different reason.' }))
      .rejects.toThrow('stale_report_continuation_mismatch');
    await rm(join(f.dir, 'rcl-stale-report-audits', manifest.operationId, 'complete.json'));
    await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason }))
      .rejects.toMatchObject({ code: 'stale_report_audit_invalid' });
    expect(await loadConvergeAttemptState(f.dir, f.target)).toEqual(before);
    expect(f.options.run).toHaveBeenCalledOnce();
  });

  it('does not relabel ordinary healthy stale work as a hard-failure continuation', async () => {
    const f = await staleFixture();
    await expect(previewStaleReport({ ...f.selection, retryReason }, f.dir))
      .rejects.toThrow('stale_report_continuation_ineligible');
    expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 1 });
    expect(f.options.run).toHaveBeenCalledOnce();
  });

  it('preserves ordinary v1 stale behavior when historical hardFailure is absent', async () => {
    const f = await staleFixture();
    const state = (await loadConvergeRunState(f.dir,f.target))!; delete state.lastLaunch!.hardFailure;
    await writeFile(f.statePath,JSON.stringify(state));
    const manifest = await previewStaleReport(f.selection,f.dir);
    expect(manifest.version).toBe(1);
    await writeFile(f.manifestPath,JSON.stringify(manifest));
    await expect(applyStaleReport({manifest:f.manifestPath,
      manifestSha256:sha256(await readFile(f.manifestPath)),mode:'apply'},f.dir)).resolves.toBe('applied');
  });

  it('keeps a published v2 receipt and applies a second-input v3 continuation after marker upgrade', async () => {
    const f = await staleFixture();
    const {report,reviewerHealth} = await makeBlockingHealthConclusive(f);
    const state = (await loadConvergeRunState(f.dir,f.target))!;
    state.lastLaunch = {...state.lastLaunch!,reportJsonSha256:f.selection.reportSha256,
      deliveryPending:false,hardFailure:true,exitCode:4,reviewerHealth,
      deliveryReconciliation:{version:1,runId:state.lastLaunch!.runId!,
        reportJsonSha256:f.selection.reportSha256,headSha:state.lastLaunch!.headSha,
        attempt:state.lastLaunch!.attempt,round:state.lastLaunch!.round}};
    await writeFile(f.statePath,JSON.stringify(state));
    const weak = state.lastLaunch.deliveryReconciliation;
    const legacy = {
      ...f.selection,kind:'rcl-stale-report',version:2,outcome:'delivered-hard-failure',retryReason,
      operationId:randomUUID(),createdAt:new Date().toISOString(),gitCommonDir:f.dir,
      stateSha256:sha256(await readFile(f.statePath)),attemptSha256:sha256(await readFile(f.attemptsPath)),
      runId:state.lastLaunch.runId,attempt:state.lastLaunch.attempt,round:state.lastLaunch.round,
      previousHeadSha:state.lastLaunch.headSha,previousInputSha256:state.lastLaunch.inputSha256,
      cycleId:state.cycle?.id ?? null,reviewerHealth,deliveryReconciliation:weak,
    };
    await writeFile(f.manifestPath,JSON.stringify(legacy));
    await expect(applyStaleReport({manifest:f.manifestPath,
      manifestSha256:sha256(await readFile(f.manifestPath)),mode:'apply'},f.dir)).resolves.toBe('applied');

    await reconcileFixture(f);
    expect((await loadConvergeRunState(f.dir,f.target))!.lastLaunch!.deliveryReconciliation)
      .toMatchObject({version:2,runId:report.run.id,inputSha256:state.lastLaunch.inputSha256,
        claimPid:state.lastLaunch.pid});

    const second={...f.selection,headSha:'e'.repeat(40),inputSha256:'f'.repeat(64),retryReason};
    const manifest=await previewStaleReport(second,f.dir);
    expect(manifest).toMatchObject({version:3,outcome:'delivered-hard-failure',
      deliveryReconciliation:{version:2}});
    await writeFile(f.manifestPath,JSON.stringify(manifest));
    await expect(applyStaleReport({manifest:f.manifestPath,
      manifestSha256:sha256(await readFile(f.manifestPath)),mode:'apply'},f.dir)).resolves.toBe('applied');
    expect((await loadConvergeRunState(f.dir,f.target))!.staleReportAudit?.map(entry => JSON.parse(entry.manifestJson).version))
      .toEqual([2,3]);
    await expect(guardReviewLaunch({...f.options,...second})).resolves.toMatchObject({attempt:2});
    expect(f.options.run).toHaveBeenCalledTimes(2);
  });

  it.each([
    [`  Reviewed sk-${'q'.repeat(40)} recovery.  `,'credential redaction'],
    [`  ${'x'.repeat(500)}  `,'trimmed 500-character bound'],
  ])('uses one canonical retry reason for preview and launch: %s', async (raw) => {
    const f = await reconciledSpecial();
    const manifest = await previewStaleReport({...f.selection,retryReason:raw},f.dir);
    expect(manifest.version).toBe(3);
    if (manifest.version !== 3) throw new Error('expected special manifest');
    if (raw.includes('sk-')) expect(manifest.retryReason).toContain('[redacted]');
    else expect(manifest.retryReason).toHaveLength(500);
    expect(manifest.retryReason).not.toContain('sk-');
    await writeFile(f.manifestPath,JSON.stringify(manifest));
    await applyStaleReport({manifest:f.manifestPath,manifestSha256:sha256(await readFile(f.manifestPath)),mode:'apply'},f.dir);
    await expect(guardReviewLaunch({...f.options,...f.selection,retryReason:raw})).resolves.toMatchObject({attempt:2});
  });

  it.each([
    ['local-invalid rejection', async (f: Awaited<ReturnType<typeof staleFixture>>) => {
      const state = (await loadConvergeRunState(f.dir,f.target))!; state.lastLaunch!.deliveryFailure = 'local-invalid';
      await writeFile(f.statePath,JSON.stringify(state));
    }],
    ['unknown blocking health', async (f: Awaited<ReturnType<typeof staleFixture>>) => {
      const state = (await loadConvergeRunState(f.dir,f.target))!; delete state.lastLaunch!.reviewerHealth;
      await writeFile(f.statePath,JSON.stringify(state));
    }],
    ['inconclusive blocking health', async (f: Awaited<ReturnType<typeof staleFixture>>) => {
      const state = (await loadConvergeRunState(f.dir,f.target))!; state.lastLaunch!.reviewerHealth!.successfulSeats = 1;
      await writeFile(f.statePath,JSON.stringify(state));
    }],
    ['claim PID mismatch', async (f: Awaited<ReturnType<typeof staleFixture>>) => {
      const attempts = JSON.parse(await readFile(f.attemptsPath,'utf8')); attempts.attempts[0].pid += 1;
      await writeFile(f.attemptsPath,JSON.stringify(attempts));
    }],
    ['reconciliation binding mismatch', async (f: Awaited<ReturnType<typeof staleFixture>>) => {
      const state = (await loadConvergeRunState(f.dir,f.target))!;
      state.lastLaunch!.deliveryReconciliation!.cycleId = '019921a0-0000-7000-8000-000000000099';
      await writeFile(f.statePath,JSON.stringify(state));
    }],
  ])('blocks %s before any claim or provider call', async (_label,mutate) => {
    const f = await reconciledSpecial(); await mutate(f);
    const before = await readFile(f.attemptsPath);
    await expect(previewStaleReport({...f.selection,retryReason},f.dir)).rejects.toThrow();
    expect(await readFile(f.attemptsPath)).toEqual(before);
    expect(f.options.run).toHaveBeenCalledOnce();
  });

  it('keeps unresolved rounds and the configured attempt cap authoritative', async () => {
    const unresolved = await reconciledSpecial(true);
    const state = (await loadConvergeRunState(unresolved.dir,unresolved.target))!;
    for (const finding of Object.values(state.findings)) { delete finding.verdict; delete finding.verdictRound; }
    await writeFile(unresolved.statePath,JSON.stringify(state));
    await expect(previewStaleReport({...unresolved.selection,retryReason},unresolved.dir)).rejects.toThrow('triage_required');

    const capped = await reconciledSpecial();
    const attempts = JSON.parse(await readFile(capped.attemptsPath,'utf8')); attempts.cap = 1;
    await writeFile(capped.attemptsPath,JSON.stringify(attempts));
    await applyContinuation(capped);
    await expect(guardReviewLaunch({...capped.options,...capped.selection,retryReason})).rejects.toThrow(/budget exhausted/i);
    expect(capped.options.run).toHaveBeenCalledOnce();
  });

  it('serializes concurrent valid continuations to one fresh claim', async () => {
    const f = await reconciledSpecial(); await applyContinuation(f);
    const results = await Promise.allSettled([
      guardReviewLaunch({...f.options,...f.selection,retryReason}),
      guardReviewLaunch({...f.options,...f.selection,retryReason}),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await loadConvergeAttemptState(f.dir,f.target)).toMatchObject({attemptsUsed:2});
    expect(f.options.run).toHaveBeenCalledTimes(2);
  });
});
