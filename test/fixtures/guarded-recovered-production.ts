import { expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deriveNativeRecovery, effectivePendingIdentities } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { claimConvergeAttempt, recordConvergeAttemptLaunch } from '../../src/converge/attempt-budget.js';
import { correctionAnchor } from '../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { recoveredFixture, sha, uuid } from '../evidence/recovery-validation/fixtures.js';

/** Seed the same durable, healthy launch binding that admission requires.
 * Run-state tests use this lower-level helper when they intentionally retain
 * unresolved findings between synthetic rounds and therefore cannot ask the
 * high-level launch guard to authorize another provider call. */
export async function recordHealthyRecoveredLaunch(options: {
  gitCommonDir: string;
  target: string;
  round: number;
  runId: string;
  reportJson: string;
}) {
  const startedAt = new Date().toISOString();
  await claimConvergeAttempt({
    gitCommonDir: options.gitCommonDir,
    target: options.target,
    afterClaim: async (claim, ownership) => {
      const pending = {
        status: 'pending' as const,
        attempt: claim.attempt,
        round: options.round,
        headSha: '0'.repeat(40),
        inputSha256: '1'.repeat(64),
        startedAt,
        pid: process.pid,
        ...(claim.processIdentity ? { processIdentity: claim.processIdentity } : {}),
      };
      await recordConvergeAttemptLaunch(options.gitCommonDir, options.target, pending, ownership);
      await recordConvergeAttemptLaunch(options.gitCommonDir, options.target, {
        ...pending,
        status: 'completed',
        runId: options.runId,
        reportJsonSha256: sha(options.reportJson),
        successfulReviews: 2,
        totalReviews: 2,
        deliveryPending: false,
      }, ownership);
    },
  });
}

/** Build validated recovery evidence, then complete a real gated round's triage. */
export async function installTriagedRecoveredProduction(gitCommonDir: string) {
  const original = recoveredFixture();
  const source = JSON.parse(original.sourceJson);
  const report = JSON.parse(original.reportJson);
  report.findings[0].gating.reason = 'none';
  source.lastAnnotations.identities[0].gating = 'none';
  const path = convergeRunStatePath(gitCommonDir, original.selection.target);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(source), { mode: 0o600 });
  await recordVerdicts({ gitCommonDir, target: original.selection.target, round: 1,
    verdicts: [{ key: original.key, verdict: 'dismissed', reason: 'The original retained carrier has completed explicit triage.' }] });
  const selection = { ...original.selection, nativeJson: await readFile(path, 'utf8'), reportJson: JSON.stringify(report) };
  const event = prepareClaimSplit(selection).event;
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), converge_target: selection.target, round: 1, attempt: null };
  const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(8));
  const plan = deriveNativeRecovery({ sourceJson: selection.nativeJson, target: selection.target, operationId: uuid(8),
    anchors: [anchor], reports: [selection.reportJson], sourceReceipts: selection.sourceReceipts });
  await writeFile(path, plan.resultJson, { mode: 0o600 });
  await mkdir(`${path}.recovery-sources`, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.recovery-sources/${plan.sourceSha256}.json`, plan.sourceJson, { mode: 0o600 });
  await mkdir(`${path}.evidence`, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.evidence/${sha(selection.reportJson)}.json`, selection.reportJson, { mode: 0o600 });
  expect(effectivePendingIdentities((await loadConvergeRunState(gitCommonDir, plan.target))!)).toEqual([]);

  const runId = uuid(802);
  const finding = { ...report.findings[0], identity: `report:${runId}:1111111111111111`, file: 'authorization.ts',
    category: 'security', title: 'Foreign account authorization', gating: { reason: 'consensus' },
    claimDescriptor: { version: 1, operation: 'authorization.ts :: authorize',
      invariant: 'Foreign account identifiers bypass tenant ownership checks.', evidence: ['Require tenant ownership before authorization.'] } };
  const recoverySource = { version: 1 as const, native_sha256: sha(plan.resultJson) };
  const reportJson = JSON.stringify({ run: { id: runId, converge: {
    target: plan.target, round: 2, attempt: 1, recovery_source: recoverySource,
  }, gating: { bound_classification_protocol: 1 } }, findings: [finding] });
  await guardReviewLaunch({ gitCommonDir, target: plan.target, headSha: '0'.repeat(40), inputSha256: '1'.repeat(64),
    recoverySource, validate: async () => {}, run: async context => {
      expect(context).toEqual({ target: plan.target, round: 2, attempt: 1, recovery_source: recoverySource });
      return { runId, reportJsonSha256: sha(reportJson), successfulReviews: 2, totalReviews: 2, deliveryPending: false };
    } });
  const admitted = await processRoundReport({ gitCommonDir, target: plan.target, round: 2, runId,
    findings: [finding], reportSha256: sha(reportJson), evidence: { reportJson } });
  const key = admitted.findings[0]!.identity;
  expect(admitted.actionableIdentities).toContain(key);
  const triaged = await recordVerdicts({ gitCommonDir, target: plan.target, round: 2,
    verdicts: [{ key, verdict: 'dismissed', reason: 'The retained fixture proves tenant ownership is checked.' }] });
  expect(triaged.resolution).toMatchObject({ status: 'converged-dismissal-only', unresolved: [] });
  const state = (await loadConvergeRunState(gitCommonDir, plan.target))!;
  expect(state.version).toBe(3);
  expect(effectivePendingIdentities(state)).toEqual([]);
  return { gitCommonDir, path, target: plan.target, state, before: await readFile(path, 'utf8') };
}
