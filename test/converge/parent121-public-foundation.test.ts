import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { releasedCycleFixture } from '../evidence/recovery-validation/fixtures.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { deriveNativeRecovery, applyNativeRecovery } from '../../src/converge/recovery-state.js';
import { loadConvergeRunState, processRoundReport, writeStateIfUnchanged } from '../../src/converge/run-state.js';
import { withNativeTarget, withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { loadConvergeAttemptState, recordConvergeAttemptLaunch } from '../../src/converge/attempt-budget.js';
import { processSemanticRound } from '../../src/converge/semantic-state.js';

// Genuine unchanged public writer in each fixture's own canonical root. The
// external cycle issuer and reviewer callback are the public fixture's fakes.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl121-foundation-')));
  roots.push(root);
  await mkdir(join(root, 'rcl-converge-runs'), { mode: 0o700 });
  const f = await releasedCycleFixture(root), sourceJson = await readFile(f.runPath, 'utf8');
  const selection = f.selection, operationId = uuid(803);
  const event = prepareClaimSplit(selection).event;
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), attempt: null };
  const anchor = correctionAnchor(selection, receipt, uuid(7), operationId);
  const plan = deriveNativeRecovery({ sourceJson, target: selection.target, operationId, anchors: [anchor],
    reports: [selection.reportJson], sourceReceipts: selection.sourceReceipts });
  const apply = () => withRecoveryTarget(root, plan.target, ownership => applyNativeRecovery({ gitCommonDir: root, plan, ownership }));
  return { ...f, root, sourceJson, plan, apply };
}

type Fault = 'partner' | 'archive' | 'pending';
async function corrupt(f: Awaited<ReturnType<typeof fixture>>, fault: Fault) {
  if (fault === 'partner') {
    const ledger = JSON.parse(f.attemptsJson); ledger.cycle.id = uuid(999);
    await writeFile(f.attemptPath, JSON.stringify(ledger));
    return /fresh_review_state_pair_mismatch/;
  }
  if (fault === 'archive') {
    await writeFile(f.archivePath, f.archiveJson + ' ');
    return /fresh_review_archive_changed/;
  }
  const path = join(dirname(f.archivePath), `${f.native.cycle.operationId}.json`);
  const operation = JSON.parse(await readFile(path, 'utf8')); operation.phase = 'active';
  await writeFile(path, JSON.stringify(operation));
  return /fresh_review_pending/;
}

for (const stage of ['apply', 'replay', 'cas-replay'] as const) {
  it.each(['partner', 'archive', 'pending'] as const)(`refuses ${stage} when public %s authority no longer matches`, async fault => {
    const f = await fixture();
    expect(await loadConvergeRunState(f.root, f.plan.target)).toEqual(f.native);
    if (stage !== 'apply') expect((await f.apply()).status).toBe('applied');
    const current = await readFile(f.runPath, 'utf8');
    const expected = await corrupt(f, fault);
    const attempted = () => stage === 'cas-replay'
      ? withNativeTarget(f.root, f.plan.target, ownership => writeStateIfUnchanged(f.root, f.plan.sourceSha256, JSON.parse(current), ownership))
      : f.apply();
    await expect(attempted()).rejects.toThrow(expected);
    expect(await readFile(f.runPath, 'utf8')).toBe(current);
    expect(await readFile(f.attemptPath, 'utf8')).toBe(fault === 'partner' ? JSON.stringify({ ...JSON.parse(f.attemptsJson),
      cycle: { ...f.native.cycle, id: uuid(999) } }) : f.attemptsJson);
    expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson + (fault === 'archive' ? ' ' : ''));
  });
}

it('loads, applies, reloads and replays genuine cycle recovery without spending or changing original evidence', async () => {
  const f = await fixture();
  expect(await loadConvergeRunState(f.root, f.plan.target)).toEqual(f.native);
  const first = await f.apply(); expect(first.status).toBe('applied');
  const loaded = await loadConvergeRunState(f.root, f.plan.target);
  expect(loaded).toEqual(JSON.parse(f.plan.resultJson));
  expect(loaded!.cycle).toEqual(f.native.cycle);
  expect(loaded!.rounds).toEqual(f.native.rounds);
  expect(loaded!.roundCap).toBe(f.native.roundCap);
  expect(loaded!.findings).toEqual(f.native.findings);
  expect(f.plan.actionableIdentities).toEqual(expect.arrayContaining([f.selection.previousIdentity, f.selection.identity]));
  const inode = (await stat(f.runPath)).ino;
  expect((await f.apply()).status).toBe('already_applied');
  expect((await stat(f.runPath)).ino).toBe(inode);
  expect(await withNativeTarget(f.root, f.plan.target, ownership =>
    writeStateIfUnchanged(f.root, f.plan.sourceSha256, loaded!, ownership))).toBe('already-written');
  expect((await stat(f.runPath)).ino).toBe(inode);
  expect(await readFile(first.snapshotPath, 'utf8')).toBe(f.sourceJson);
  expect(sha(await readFile(first.snapshotPath, 'utf8'))).toBe(f.plan.sourceSha256);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(f.attemptsJson);
  expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson);
});

it.each(['missing-cycle', 'cycle', 'repository', 'pull-request'] as const)
('refuses a recovered report with mismatched %s before changing native bytes', async mismatch => {
  const f = await fixture(); await f.apply();
  const runId = uuid(880); const report = JSON.parse(f.selection.reportJson);
  report.run.id = runId;
  report.run.converge = { target: f.plan.target, round: 2,
    recovery_source: { version: 1, native_sha256: sha(f.plan.resultJson) } };
  report.run.cycle_id = f.native.cycle.id;
  report.run.target.repo = f.native.cycle.repo;
  report.run.target.pr_number = f.native.cycle.prNumber;
  const finding = { ...report.findings[0], identity: `report:${runId}:cycle-binding`,
    claimDescriptor: f.selection.descriptor };
  report.findings = [finding]; report.belowThresholdFindings = [];
  if (mismatch === 'missing-cycle') delete report.run.cycle_id;
  if (mismatch === 'cycle') report.run.cycle_id = uuid(881);
  if (mismatch === 'repository') report.run.target.repo = 'other/repository';
  if (mismatch === 'pull-request') report.run.target.pr_number++;
  const reportJson = JSON.stringify(report), reportSha256 = sha(reportJson);
  const binding = { runId, target: f.plan.target, round: 2, reportSha256,
    sourcePath: `${f.runPath}.evidence/${reportSha256}.json` };
  const before = await readFile(f.runPath, 'utf8');
  await expect(withNativeTarget(f.root, f.plan.target, ownership => processSemanticRound({
    gitCommonDir: f.root, target: f.plan.target, round: 2, runId, findings: [finding], evidence: { reportJson },
  }, binding, ownership))).rejects.toThrow(/cycle, repository and pull request/);
  expect(await readFile(f.runPath, 'utf8')).toBe(before);
});

it('accepts a recovered report whose repository differs only by case', async () => {
  const f = await fixture(); await f.apply();
  const runId = uuid(882); const report = JSON.parse(f.selection.reportJson);
  report.run.id = runId;
  report.run.converge = { target: f.plan.target, round: 2,
    recovery_source: { version: 1, native_sha256: sha(f.plan.resultJson) } };
  report.run.cycle_id = f.native.cycle.id;
  report.run.target.repo = f.native.cycle.repo.toUpperCase();
  report.run.target.pr_number = f.native.cycle.prNumber;
  const finding = { ...report.findings[0], identity: `report:${runId}:cycle-binding-case`,
    claimDescriptor: f.selection.descriptor };
  report.findings = [finding]; report.belowThresholdFindings = [];
  const reportJson = JSON.stringify(report), reportSha256 = sha(reportJson);
  const binding = { runId, target: f.plan.target, round: 2, reportSha256,
    sourcePath: `${f.runPath}.evidence/${reportSha256}.json` };
  const admitted = await withNativeTarget(f.root, f.plan.target, ownership => processSemanticRound({
    gitCommonDir: f.root, target: f.plan.target, round: 2, runId, findings: [finding], evidence: { reportJson },
  }, binding, ownership));
  expect(admitted.reportBinding?.reportSha256).toBe(reportSha256);
  expect((await loadConvergeRunState(f.root, f.plan.target))!.cycle).toEqual(f.native.cycle);
});

it('records immutable pending/completed metadata on an actual cycle3 already-spent attempt', async () => {
  const f = await fixture(), before = (await loadConvergeAttemptState(f.root, f.plan.target))!;
  const pending = { ...f.native.lastLaunch, status: 'pending' as const };
  for (const key of ['runId','reportJsonSha256','successfulReviews','totalReviews','deliveryPending']) delete pending[key];
  const completed = { ...f.native.lastLaunch, exitCode: 0, reportPath: join(f.root, 'retained-report.json') };
  const record = (value: typeof pending) => withNativeTarget(f.root, f.plan.target, ownership =>
    recordConvergeAttemptLaunch(f.root, f.plan.target, value, ownership));
  await record(pending); await record(completed);
  const retained = await readFile(f.attemptPath, 'utf8'), inode = (await stat(f.attemptPath)).ino;
  await record(completed);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(retained);
  expect((await stat(f.attemptPath)).ino).toBe(inode);
  const after = (await loadConvergeAttemptState(f.root, f.plan.target))!;
  expect(after).toEqual({ ...before, lastLaunch: completed, updatedAt: after.updatedAt });
  expect(after).toMatchObject({ version: 3, attemptsUsed: 1, cycle: f.native.cycle });
  await expect(record({ ...completed, reportJsonSha256: 'f'.repeat(64) })).rejects.toThrow(/completion/);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(retained);
  expect(await readFile(f.runPath, 'utf8')).toBe(f.sourceJson);
  expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson);
});

it('refuses recovered admission from an authoritative locally invalid attempt launch', async () => {
  const f = await fixture(); await f.apply();
  const attempt = JSON.parse(await readFile(f.attemptPath, 'utf8'));
  attempt.lastLaunch = { ...f.native.lastLaunch, deliveryFailure: 'local-invalid' };
  await writeFile(f.attemptPath, JSON.stringify(attempt));
  const nativeBefore = await readFile(f.runPath, 'utf8');
  const attemptBefore = await readFile(f.attemptPath, 'utf8');
  expect(JSON.parse(nativeBefore).lastLaunch.deliveryFailure).toBeUndefined();
  const report = JSON.parse(f.selection.reportJson);
  await expect(processRoundReport({ gitCommonDir: f.root, target: f.plan.target, round: 1,
    runId: report.run.id, cycleId: f.native.cycle.id, reportSha256: sha(f.selection.reportJson),
    findings: [...report.findings, ...report.belowThresholdFindings] }))
    .rejects.toThrow('terminal_rejection_cannot_be_admitted');
  expect(await readFile(f.runPath, 'utf8')).toBe(nativeBefore);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(attemptBefore);
});

it('recursively applies a second distinct retained finding correction without rewriting original cycle ancestry', async () => {
  const f = await fixture(); const first = await f.apply();
  const selection = { ...f.selection, nativeJson: f.plan.resultJson, nativeSourceJsons: [f.sourceJson],
    findingRef: 'f002', identity: '3333333333333333', eventId: uuid(806) };
  const event = prepareClaimSplit(selection).event, operationId = uuid(807);
  const anchor = correctionAnchor(selection, { ...selection.scope, ...event, actor_user_id: uuid(7), attempt: null }, uuid(7), operationId);
  const plan = deriveNativeRecovery({ sourceJson: f.plan.resultJson, nativeSourceJsons: [f.sourceJson], target: f.plan.target,
    operationId, anchors: [anchor], reports: [selection.reportJson], sourceReceipts: selection.sourceReceipts });
  const apply = () => withRecoveryTarget(f.root, plan.target, ownership => applyNativeRecovery({ gitCommonDir: f.root, plan, ownership }));
  expect((await apply()).status).toBe('applied');
  const state = (await loadConvergeRunState(f.root, plan.target))!;
  expect(state).toEqual(JSON.parse(plan.resultJson));
  expect(state.recovery!.operations).toHaveLength(2);
  expect(state.cycle).toEqual(f.native.cycle); expect(state.rounds).toEqual(f.native.rounds);
  expect(state.findings).toEqual(f.native.findings); expect(state.roundCap).toBe(f.native.roundCap);
  expect(plan.actionableIdentities).toEqual(expect.arrayContaining([f.selection.previousIdentity, f.selection.identity]));
  // The genuine second report row is minor and gating-none: correction must not promote it.
  expect(plan.actionableIdentities).not.toContain(selection.identity);
  expect((await apply()).status).toBe('already_applied');
  expect(await readFile(first.snapshotPath, 'utf8')).toBe(f.sourceJson);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(f.attemptsJson);
  expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson);
});

it.each(['cycle', 'run', 'digest', 'health'] as const)('keeps the public %s admission refusal before recovered semantic delegation', async fault => {
  const f = await fixture(); await f.apply();
  const { processRoundReport } = await import('../../src/converge/run-state.js');
  const report = JSON.parse(f.selection.reportJson);
  const options = { gitCommonDir: f.root, target: f.plan.target, round: 1, runId: report.run.id,
    cycleId: f.native.cycle.id, reportSha256: sha(f.selection.reportJson),
    findings: [...report.findings, ...report.belowThresholdFindings] };
  if (fault === 'cycle') options.cycleId = uuid(900);
  if (fault === 'run') options.runId = uuid(900);
  if (fault === 'digest') options.reportSha256 = 'e'.repeat(64);
  if (fault === 'health') {
    const state = JSON.parse(await readFile(f.runPath, 'utf8')); state.lastLaunch.successfulReviews = 0;
    await writeFile(f.runPath, JSON.stringify(state));
  }
  const before = await readFile(f.runPath, 'utf8');
  await expect(processRoundReport(options)).rejects.toThrow(fault === 'cycle' ? /review_cycle_mismatch/ : /review_cycle_launch_mismatch/);
  expect(await readFile(f.runPath, 'utf8')).toBe(before);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(f.attemptsJson);
});

it('preserves current-public exact-run verdicts for ordinary cycle2 and refuses wrong recovered run attribution', async () => {
  const { recordVerdicts } = await import('../../src/converge/run-state.js');
  const ordinary = await fixture(), runId = JSON.parse(ordinary.selection.reportJson).run.id;
  const verdicts = [{ key: ordinary.selection.previousIdentity, verdict: 'dismissed' as const, reason: 'Synthetic ordinary triage.' }];
  const result = await recordVerdicts({ gitCommonDir: ordinary.root, target: ordinary.plan.target, round: 1, runId, verdicts });
  expect(result.runId).toBe(runId); expect(result.entries[0]!.verdict).toBe('dismissed');
  expect((await loadConvergeRunState(ordinary.root, ordinary.plan.target))!.cycle).toEqual(ordinary.native.cycle);
  expect(await readFile(ordinary.attemptPath, 'utf8')).toBe(ordinary.attemptsJson);
  expect(await readFile(ordinary.archivePath, 'utf8')).toBe(ordinary.archiveJson);
  const f = await fixture(); await f.apply(); const before = await readFile(f.runPath, 'utf8');
  for (const wrong of [undefined, uuid(900)]) await expect(recordVerdicts({ gitCommonDir: f.root,
    target: f.plan.target, round: 1, runId: wrong, verdicts })).rejects.toThrow(/review_cycle_verdict_run_mismatch/);
  expect(await readFile(f.runPath, 'utf8')).toBe(before);
});

it.each(['stale', 'gap'] as const)('preserves the %s refusal on recovered state before semantic delegation', async kind => {
  const f = await fixture(); await f.apply();
  const { processRoundReport } = await import('../../src/converge/run-state.js');
  // Synthetic refused-request metadata, not producer evidence or a positive
  // receipt: valid structural audit fields ensure the intended public guard
  // refuses before any unavailable receipt could become authority.
  const state = JSON.parse(await readFile(f.runPath, 'utf8'));
  const runId = uuid(920), digest = 'd'.repeat(64), at = '2026-09-26T14:00:00.000Z';
  state.lastLaunch = { ...state.lastLaunch, round: 2, runId, reportJsonSha256: digest };
  const base = { version: 1, operationId: uuid(921), createdAt: at, gitCommonDir: f.root, target: f.plan.target,
    runId, reportSha256: digest, stateSha256: sha(f.plan.resultJson), attemptSha256: sha(f.attemptsJson) };
  if (kind === 'stale') {
    const m = { ...base, kind: 'rcl-stale-report', headSha: 'c'.repeat(40), inputSha256: 'e'.repeat(64),
      previousHeadSha: state.lastLaunch.headSha, previousInputSha256: state.lastLaunch.inputSha256,
      reportPath: join(f.root, 'refused-report.json'), reason: 'Synthetic refused request.', attempt: 1, round: 2 };
    const manifestJson = JSON.stringify(m); state.staleReportAudit = [{ manifestJson, manifestSha256: sha(manifestJson) }]; state.staleReportAuditCount = 1;
  } else {
    const incomplete = 'e'.repeat(64), file = (name: string, hash: string) => ({ path: join(f.root, name), sha256: hash, bytes: 1 });
    const m = { ...base, kind: 'rcl-round-gap-audit', gapRound: 2, admittingRound: 3, attempt: 2, incompleteSha256: incomplete,
      gapAttempt: { attempt: 2, claimedAt: at, pid: process.pid, source: 'claim' },
      admittingAttempt: { attempt: 3, claimedAt: at, pid: process.pid, source: 'claim' },
      report: file('refused-report.json', digest), incomplete: file('incomplete.md', incomplete), evidence: [],
      disposition: { kind: 'missing-terminal-report', controllerExit: 'unknown', scope: 'supplied-evidence-only' } };
    const manifestJson = JSON.stringify(m); state.roundGapAudit = { version: 1, entries: [{ manifestJson, manifestSha256: sha(manifestJson) }] };
  }
  const raw = JSON.stringify(state); await writeFile(f.runPath, raw);
  expect(await loadConvergeRunState(f.root, f.plan.target)).toEqual(state);
  await expect(processRoundReport({ gitCommonDir: f.root, target: f.plan.target, round: 2, runId,
    cycleId: f.native.cycle.id, reportSha256: digest, findings: [] })).rejects.toThrow(kind === 'stale'
    ? /stale_report_cannot_be_admitted/ : /round_gap_requires_explicit_original_evidence_recovery/);
  expect(await readFile(f.runPath, 'utf8')).toBe(raw);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(f.attemptsJson);
});

for (const stage of ['record', 'replay'] as const) {
  it.each(['partner', 'archive'] as const)(`refuses cycle3 launch metadata ${stage} with altered %s authority`, async fault => {
    const f = await fixture();
    const launch = { ...f.native.lastLaunch, status: 'pending' as const };
    for (const key of ['runId','reportJsonSha256','successfulReviews','totalReviews','deliveryPending']) delete launch[key];
    const record = () => withNativeTarget(f.root, f.plan.target, ownership =>
      recordConvergeAttemptLaunch(f.root, f.plan.target, launch, ownership));
    if (stage === 'replay') await record();
    if (fault === 'partner') {
      const ledger = JSON.parse(await readFile(f.attemptPath, 'utf8')); ledger.cycle.id = uuid(999);
      await writeFile(f.attemptPath, JSON.stringify(ledger));
    } else await writeFile(f.archivePath, f.archiveJson + ' ');
    const before = await readFile(f.attemptPath, 'utf8');
    await expect(record()).rejects.toThrow(fault === 'partner' ? /fresh_review_state_pair_mismatch/ : /fresh_review_archive_changed/);
    expect(await readFile(f.attemptPath, 'utf8')).toBe(before);
    expect(await readFile(f.runPath, 'utf8')).toBe(f.sourceJson);
  });
}
