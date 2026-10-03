import { expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { applyStaleReport, previewStaleReport } from '../../src/converge/stale-report.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
import { reconcileDeliveredRun } from '../../src/converge/delivery-reconciliation.js';
import { reconciledHardFailureFixture, staleFixture } from './stale-report-fixtures.js';

async function applyRecovery(f: Awaited<ReturnType<typeof reconciledHardFailureFixture>>) {
  const manifest = await previewStaleReport(f.hardFailureSelection, f.dir);
  await writeFile(f.manifestPath, JSON.stringify(manifest));
  await applyStaleReport({ manifest: f.manifestPath, manifestSha256: sha256(await readFile(f.manifestPath)), mode: 'apply' }, f.dir);
  return manifest;
}

it('reproduces and resolves a reconciled delivered hard failure without admitting the stale report', async () => {
  const f = await reconciledHardFailureFixture();
  const { retryReason } = f;
  const beforeAttempts = await loadConvergeAttemptState(f.dir, f.target);
  const originalReport = JSON.parse(await readFile(f.reportPath, 'utf8'));
  expect(originalReport.run.roster).toHaveLength(16);
  expect(originalReport.run.roster.map((seat: {lane:string}) => seat.lane)).toEqual([
    ...Array(10).fill('blocking'), ...Array(4).fill('secondary'), 'async', 'verification',
  ]);
  expect(originalReport.reviews).toHaveLength(15);
  expect(originalReport.stats).toMatchObject({ successfulReviews: 8, totalReviews: 15 });
  expect((await loadConvergeRunState(f.dir, f.target))!.lastLaunch).toMatchObject({
    successfulReviews: 8,
    totalReviews: 15,
    hardFailure: true,
    deliveryPending: false,
    reviewerHealth: { policy: { seatCount: 10, minimumSuccessful: 7 }, successfulSeats: 7 },
    deliveryReconciliation: {
      version: 1,
      runId: expect.any(String),
      reportJsonSha256: f.reportSha256,
      round: 1,
      attempt: 1,
      headSha: f.options.headSha,
    },
  });

  await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason }))
    .rejects.toThrow('report_not_admitted');
  await expect(previewStaleReport(f.selection, f.dir))
    .rejects.toThrow('stale_report_outcome_ineligible');
  expect(await loadConvergeAttemptState(f.dir, f.target)).toEqual(beforeAttempts);
  expect(f.options.run).toHaveBeenCalledTimes(1);

  await applyRecovery(f);

  await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason }))
    .resolves.toMatchObject({ attempt: 2 });
  expect(f.options.run).toHaveBeenCalledTimes(2);
  expect(f.options.run.mock.calls.at(-1)?.[0]).toEqual({ target: f.target, round: 1, attempt: 2 });
  expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 2 });
  expect(await loadConvergeRunState(f.dir, f.target)).toMatchObject({
    rounds: [],
    lastLaunch: { attempt: 2, round: 1, retryReason },
    staleReportAuditCount: 1,
  });
});

it('requires the exact reviewed retry reason and replacement inputs before claiming', async () => {
  const f = await reconciledHardFailureFixture();
  await applyRecovery(f);
  const before = await loadConvergeAttemptState(f.dir, f.target);

  await expect(guardReviewLaunch({ ...f.options, ...f.selection }))
    .rejects.toThrow('stale_report_retry_reason_mismatch');
  await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason: 'A different bounded reason.' }))
    .rejects.toThrow('stale_report_retry_reason_mismatch');
  await expect(guardReviewLaunch({ ...f.options, ...f.selection, headSha: 'e'.repeat(40), retryReason: f.retryReason }))
    .rejects.toThrow('stale_report_input_mismatch');
  expect(await loadConvergeAttemptState(f.dir, f.target)).toEqual(before);
  expect(f.options.run).toHaveBeenCalledTimes(1);
});

it.each([
  ['pending delivery', (state: any) => { state.lastLaunch.deliveryPending = true; }],
  ['local-invalid terminal rejection', (state: any) => { state.lastLaunch.deliveryFailure = 'local-invalid'; }],
  ['missing authenticated reconciliation', (state: any) => { delete state.lastLaunch.deliveryReconciliation; }],
  ['mismatched authenticated reconciliation', (state: any) => {
    state.lastLaunch.deliveryReconciliation.runId = '019921a0-0000-7000-8000-000000000002';
  }],
  ['unknown blocking health', (state: any) => { delete state.lastLaunch.reviewerHealth; }],
  ['inconclusive blocking health', (state: any) => {
    state.lastLaunch.reviewerHealth.successfulSeats = 1;
    state.lastLaunch.successfulReviews = 1;
  }],
  ['non-completed launch', (state: any) => {
    state.lastLaunch.status = 'failed';
    delete state.lastLaunch.reviewerHealth;
  }],
])('refuses %s without changing native or attempt evidence', async (_label, mutate) => {
  const f = await reconciledHardFailureFixture();
  const state = (await loadConvergeRunState(f.dir, f.target))!;
  mutate(state);
  await writeFile(f.statePath, JSON.stringify(state));
  const before = await f.bytes();
  await expect(previewStaleReport(f.hardFailureSelection, f.dir))
    .rejects.toThrow(/stale_report_(outcome_ineligible|health_binding_mismatch|reconciliation_binding_mismatch)/);
  expect(await f.bytes()).toEqual(before);
  expect(f.options.run).toHaveBeenCalledTimes(1);
});

it('refuses ordinary healthy stale work and unchanged effective inputs in the special path', async () => {
  const ordinary = await staleFixture();
  await expect(previewStaleReport({ ...ordinary.selection, retryReason: 'Cannot relabel ordinary work.' }, ordinary.dir))
    .rejects.toThrow('stale_report_outcome_ineligible');

  const f = await reconciledHardFailureFixture();
  await expect(previewStaleReport({ ...f.hardFailureSelection,
    headSha: f.options.headSha, inputSha256: f.options.inputSha256 }, f.dir))
    .rejects.toThrow('inputs_unchanged');
});

it('refuses tampered manifest bindings and a missing receipt without spending a claim', async () => {
  const f = await reconciledHardFailureFixture();
  const manifest = await previewStaleReport(f.hardFailureSelection, f.dir);
  await writeFile(f.manifestPath, JSON.stringify({ ...manifest, reviewerHealth: {
    ...manifest.reviewerHealth, successfulSeats: manifest.reviewerHealth.successfulSeats - 1 } }));
  const attempts = await loadConvergeAttemptState(f.dir, f.target);
  await expect(applyStaleReport({ manifest: f.manifestPath,
    manifestSha256: sha256(await readFile(f.manifestPath)), mode: 'apply' }, f.dir))
    .rejects.toThrow('stale_report_manifest_binding_mismatch');
  expect(await loadConvergeAttemptState(f.dir, f.target)).toEqual(attempts);

  await writeFile(f.manifestPath, JSON.stringify({ ...manifest, deliveryReconciliation: {
    ...manifest.deliveryReconciliation, attempt: manifest.deliveryReconciliation.attempt + 1 } }));
  await expect(applyStaleReport({ manifest: f.manifestPath,
    manifestSha256: sha256(await readFile(f.manifestPath)), mode: 'apply' }, f.dir))
    .rejects.toThrow('stale_report_manifest_binding_mismatch');
  expect(await loadConvergeAttemptState(f.dir, f.target)).toEqual(attempts);

  await writeFile(f.manifestPath, JSON.stringify(manifest));
  await applyStaleReport({ manifest: f.manifestPath,
    manifestSha256: sha256(await readFile(f.manifestPath)), mode: 'apply' }, f.dir);
  await rm(join(f.dir, 'rcl-stale-report-audits', manifest.operationId, 'complete.json'));
  await expect(guardReviewLaunch({ ...f.options, ...f.selection, retryReason: f.retryReason }))
    .rejects.toMatchObject({ code: 'stale_report_audit_invalid' });
  expect(await loadConvergeAttemptState(f.dir, f.target)).toEqual(attempts);
});

it('keeps unresolved obligations and configured caps authoritative', async () => {
  const unresolved = await reconciledHardFailureFixture(false, true);
  const unresolvedState = (await loadConvergeRunState(unresolved.dir, unresolved.target))!;
  for (const finding of Object.values(unresolvedState.findings)) {
    delete finding.verdict;
    delete finding.verdictRound;
  }
  await writeFile(unresolved.statePath, JSON.stringify(unresolvedState));
  await expect(previewStaleReport(unresolved.hardFailureSelection, unresolved.dir)).rejects.toThrow('triage_required');

  const capped = await reconciledHardFailureFixture();
  const attempts = JSON.parse(await readFile(capped.attemptsPath, 'utf8'));
  attempts.cap = 1;
  await writeFile(capped.attemptsPath, JSON.stringify(attempts));
  await applyRecovery(capped);
  await expect(guardReviewLaunch({ ...capped.options, ...capped.selection, retryReason: capped.retryReason }))
    .rejects.toThrow(/budget exhausted/i);
  expect(capped.options.run).toHaveBeenCalledTimes(1);
});

it('serializes concurrent continuations so exactly one next attempt is claimed', async () => {
  const f = await reconciledHardFailureFixture();
  await applyRecovery(f);
  const results = await Promise.allSettled([
    guardReviewLaunch({ ...f.options, ...f.selection, retryReason: f.retryReason }),
    guardReviewLaunch({ ...f.options, ...f.selection, retryReason: f.retryReason }),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 2 });
  expect(f.options.run).toHaveBeenCalledTimes(2);
});

it('continues the incident ordinal at round 14 and attempt 26 without changing 13 admitted rounds', async () => {
  const f = await reconciledHardFailureFixture(false, true);
  const state = (await loadConvergeRunState(f.dir, f.target))!;
  state.rounds = Array.from({ length: 13 }, (_, index) => ({ ...state.rounds[0]!, round: index + 1 }));
  state.roundCap = 30;
  state.lastAnnotations!.round = 13;
  for (const finding of Object.values(state.findings)) finding.verdictRound = 13;
  state.lastLaunch!.attempt = 25;
  state.lastLaunch!.round = 14;
  state.lastLaunch!.deliveryPending = true;
  delete state.lastLaunch!.deliveryReconciliation;

  const report = JSON.parse(await readFile(f.reportPath, 'utf8'));
  report.run.converge = { target: f.target, attempt: 25, round: 14 };
  await writeFile(f.reportPath, JSON.stringify(report));
  f.selection.reportSha256 = sha256(await readFile(f.reportPath));
  f.hardFailureSelection.reportSha256 = f.selection.reportSha256;
  state.lastLaunch!.reportJsonSha256 = f.selection.reportSha256;
  await writeFile(f.statePath, JSON.stringify(state));

  const attempts = JSON.parse(await readFile(f.attemptsPath, 'utf8'));
  attempts.cap = 35;
  attempts.attemptsUsed = 25;
  attempts.attempts = Array.from({ length: 25 }, (_, index) => ({ ...attempts.attempts[0], attempt: index + 1 }));
  await writeFile(f.attemptsPath, JSON.stringify(attempts));
  const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: {
    id: state.lastLaunch!.runId, converge: { target: f.target, round: 14, attempt: 25 },
    target: { kind: 'pull_request', head_sha: state.lastLaunch!.headSha },
    artifacts: [{ kind: 'report_json', stored: true, declared_sha256: f.selection.reportSha256 }], findings: [], calls: [],
  } });
  await expect(reconcileDeliveredRun(state.lastLaunch!.runId!, {} as never, { gitCommonDir: f.dir, getRun }))
    .resolves.toBe('reconciled');

  const before = (await loadConvergeRunState(f.dir, f.target))!;
  await applyRecovery(f);
  await guardReviewLaunch({ ...f.options, ...f.selection, retryReason: f.retryReason });
  const after = (await loadConvergeRunState(f.dir, f.target))!;
  expect(f.options.run.mock.calls.at(-1)?.[0]).toEqual({ target: f.target, round: 14, attempt: 26 });
  expect(await loadConvergeAttemptState(f.dir, f.target)).toMatchObject({ attemptsUsed: 26, cap: 35 });
  expect(after.rounds).toEqual(before.rounds);
  expect(after.findings).toEqual(before.findings);
});
