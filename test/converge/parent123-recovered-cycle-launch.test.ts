import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { releasedCycleFixture } from '../evidence/recovery-validation/fixtures.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { deriveNativeRecovery, applyNativeRecovery, effectivePendingIdentities } from '../../src/converge/recovery-state.js';
import { loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import type { ConvergeContext } from '../../src/report/run-header.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl123-cycle-guard-')));
  roots.push(root);
  await mkdir(join(root, 'rcl-converge-runs'), { mode: 0o700 });
  // This helper invokes the unchanged public fresh-review producer and admission.
  // Only its remote cycle issuer and reviewer callback are synthetic.
  const f = await releasedCycleFixture(root), sourceJson = await readFile(f.runPath, 'utf8');
  // Recover the genuine minor/non-gating second report row. The major carrier
  // remains a real native finding that can receive its ordinary explicit triage.
  const classification = f.selection.sourceReceipts[0]!.payload.identities as Array<{ matched_identity: string }>;
  const selection = { ...f.selection, findingRef: 'f002', previousIdentity: classification[1]!.matched_identity };
  const operationId = uuid(810);
  const event = prepareClaimSplit(selection).event;
  const anchor = correctionAnchor(selection, { ...selection.scope, ...event, actor_user_id: uuid(7), attempt: null }, uuid(7), operationId);
  const plan = deriveNativeRecovery({ sourceJson, target: selection.target, operationId, anchors: [anchor],
    reports: [selection.reportJson], sourceReceipts: selection.sourceReceipts });
  await withRecoveryTarget(root, plan.target, ownership => applyNativeRecovery({ gitCommonDir: root, plan, ownership }));
  const recovered = (await loadConvergeRunState(root, plan.target))!;
  await recordVerdicts({ gitCommonDir: root, target: plan.target, round: 1,
    runId: JSON.parse(selection.reportJson).run.id,
    verdicts: effectivePendingIdentities(recovered).map(key => ({ key, verdict: 'dismissed' as const,
      reason: 'Synthetic fixture explicitly completes each independent retained obligation.' })) });
  const before = await readFile(f.runPath, 'utf8');
  const cycle = f.native.cycle;
  const remote = { repo: cycle.repo, prNumber: cycle.prNumber, url: cycle.url,
    current: vi.fn(async () => ({ id: cycle.id, operation_id: cycle.operationId, previous_cycle_id: cycle.previousCycleId,
      head_sha: '9'.repeat(40), inserted_at: '2026-09-27T00:00:00.000Z' })),
    start: vi.fn(async () => { throw new Error('Ordinary recovered continuation must not start another cycle.'); }) };
  const input: GuardedLaunchOptions & { recoverySource: NonNullable<ConvergeContext['recovery_source']> } = {
    gitCommonDir: root, target: plan.target, headSha: '9'.repeat(40), inputSha256: '8'.repeat(64),
    recoverySource: { version: 1, native_sha256: sha(before) }, cycleRemote: remote,
    validate: vi.fn(async () => {}), run: vi.fn(async () => ({ runId: uuid(811), reportJsonSha256: 'e'.repeat(64),
      successfulReviews: 2, totalReviews: 2, deliveryPending: false })) };
  return { ...f, root, plan, sourceJson, before, input, remote };
}

it('continues a recovered public cycle with exact predecessor bytes and admits only its same-cycle completion', async () => {
  const f = await fixture();
  let context: ConvergeContext | undefined, reportJson = '';
  f.input.run = vi.fn(async converge => {
    expect(await readFile(f.runPath, 'utf8')).toBe(f.before);
    context = converge;
    const { cycleId, ...reportContext } = converge;
    reportJson = JSON.stringify({ run: { id: uuid(811), cycle_id: cycleId, converge: reportContext,
      target: { repo: f.native.cycle.repo, pr_number: f.native.cycle.prNumber },
      gating: { bound_classification_protocol: 1 } }, findings: [] });
    return { runId: uuid(811), reportJsonSha256: sha(reportJson), successfulReviews: 2, totalReviews: 2, deliveryPending: false };
  });
  const claimed = await guardReviewLaunch(f.input);
  expect(context).toEqual({ target: f.plan.target, round: 2, attempt: 2,
    cycleId: f.native.cycle.id, recovery_source: f.input.recoverySource });
  expect(claimed).toMatchObject({ attempt: 2, cap: 20, cycle: f.native.cycle });
  expect(await readFile(f.runPath, 'utf8')).toBe(f.before);
  const ledger = (await loadConvergeAttemptState(f.root, f.plan.target))!;
  expect(ledger.attempts.slice(0, 1)).toEqual(JSON.parse(f.attemptsJson).attempts);
  expect(ledger).toMatchObject({ attemptsUsed: 2, cycle: f.native.cycle,
    lastLaunch: { attempt: 2, round: 2, status: 'completed', runId: uuid(811), reportJsonSha256: sha(reportJson) } });
  const admission = { gitCommonDir: f.root, target: f.plan.target, round: 2, runId: uuid(811),
    findings: [], reportSha256: sha(reportJson), cycleId: f.native.cycle.id, evidence: { reportJson } };
  await expect(processRoundReport({ ...admission, cycleId: uuid(899) })).rejects.toThrow(/review_cycle_mismatch/);
  await expect(processRoundReport({ ...admission, reportSha256: 'f'.repeat(64) })).rejects.toThrow(/report.*digest|launch_mismatch|report.*sha/i);
  expect(await readFile(f.runPath, 'utf8')).toBe(f.before);
  await processRoundReport(admission);
  const state = (await loadConvergeRunState(f.root, f.plan.target))!;
  expect(state.rounds).toHaveLength(2);
  expect(state.rounds[0]).toEqual(JSON.parse(f.before).rounds[0]);
  expect(state.rounds[1]?.reportBinding?.reportSha256).toBe(sha(reportJson));
  expect(state.cycle).toEqual(f.native.cycle);
  expect(state.recovery).toEqual(JSON.parse(f.before).recovery);
  expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson);
  expect(f.remote.start).not.toHaveBeenCalled();
});

it.each(['partner', 'remote', 'round-cap'] as const)('refuses recovered cycle %s changes before spending or dispatching', async fault => {
  const f = await fixture();
  if (fault === 'partner') {
    const ledger = JSON.parse(f.attemptsJson); ledger.cycle.id = uuid(898);
    await writeFile(f.attemptPath, JSON.stringify(ledger));
  } else if (fault === 'remote') f.remote.current.mockResolvedValue({ ...(await f.remote.current())!, id: uuid(898) });
  else f.input.maxRounds = 16;
  const ledgerBefore = await readFile(f.attemptPath, 'utf8');
  await expect(guardReviewLaunch(f.input)).rejects.toThrow(fault === 'partner' ? /state_pair_mismatch/
    : fault === 'remote' ? /superseded/ : /recovery_round_cap/);
  expect(f.input.run).not.toHaveBeenCalled();
  expect(f.remote.start).not.toHaveBeenCalled();
  expect(await readFile(f.runPath, 'utf8')).toBe(f.before);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(ledgerBefore);
  expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson);
});

it('refuses a retained predecessor on a fresh-review request before contacting the cycle issuer', async () => {
  const f = await fixture();
  f.remote.current.mockClear();
  await expect(guardReviewLaunch({ ...f.input, startOver: true })).rejects.toThrow(/recovery_fresh_review/);
  expect(f.input.validate).not.toHaveBeenCalled();
  expect(f.input.run).not.toHaveBeenCalled();
  expect(f.remote.current).not.toHaveBeenCalled();
  expect(f.remote.start).not.toHaveBeenCalled();
  expect(await readFile(f.runPath, 'utf8')).toBe(f.before);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(f.attemptsJson);
  expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson);
});
