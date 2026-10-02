import { mkdir, readFile } from 'node:fs/promises';
import { releasedCycleFixture, uuid } from '../evidence/recovery-validation/fixtures.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { deriveNativeRecovery, applyNativeRecovery } from '../../src/converge/recovery-state.js';
import { withNativeTarget, withRecoveryTarget } from '../../src/converge/target-ownership.js';
import * as attempts from '../../src/converge/attempt-budget.js';
import { loadConvergeRunStateEvidence } from '../../src/converge/run-state.js';
import type { GuardedLaunchState } from '../../src/converge/launch-record.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';
import { captureProcessIdentity } from '../../src/converge/process-identity.js';

export async function primitiveFixture(root: string) {
  await mkdir(`${root}/rcl-converge-runs`, { mode: 0o700 });
  const f = await releasedCycleFixture(root), sourceJson = await readFile(f.runPath, 'utf8');
  const event = prepareClaimSplit(f.selection).event, operationId = uuid(930);
  const anchor = correctionAnchor(f.selection, { ...f.selection.scope, ...event, actor_user_id: uuid(7), attempt: null }, uuid(7), operationId);
  const plan = deriveNativeRecovery({ sourceJson, target: f.selection.target, operationId, anchors: [anchor],
    reports: [f.selection.reportJson], sourceReceipts: f.selection.sourceReceipts });
  const applied = await withRecoveryTarget(root, plan.target, ownership => applyNativeRecovery({ gitCommonDir: root, plan, ownership }));
  return { ...f, root, target: plan.target, plan, sourceJson, nativeJson: await readFile(f.runPath, 'utf8'), snapshotPath: applied.snapshotPath };
}

export function terminal(launch: GuardedLaunchState): GuardedLaunchState {
  return { ...launch, status: 'completed', runId: launch.runId ?? uuid(931), reportJsonSha256: 'c'.repeat(64),
    successfulReviews: 2, totalReviews: 3, deliveryPending: true, hardFailure: false, exitCode: 0,
    reportPath: '/synthetic/retained-report.json',
    reviewerHealth: { version: 1, policy: resolveQuorumPolicy(3, 1), successfulSeats: 2 } };
}

export async function spendAndRecord(root: string, target: string, mode: 'pending' | 'completed' | 'legacy-completed', hold?: () => Promise<void>) {
  return withNativeTarget(root, target, async ownership => {
    const native = (await loadConvergeRunStateEvidence(root, target))!;
    const claim = await attempts.claimConvergeAttempt({ gitCommonDir: root, target, ownership });
    const original = native.state.rounds.at(-1)!;
    const processIdentity = await captureProcessIdentity();
    let launch: GuardedLaunchState = { status: 'pending', attempt: claim.attempt, round: original.round + 1,
      headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64), startedAt: new Date().toISOString(), pid: process.pid,
      processIdentity,
      runId: uuid(931), recovery: { operationId: uuid(932), sourceRunId: original.runId!,
        originalNativeClaim: { attempt: claim.attempt - 1, round: original.round },
        sourceNativeClaim: { attempt: claim.attempt - 1, round: original.round } } };
    if (mode === 'legacy-completed') delete launch.recovery;
    await attempts.recordConvergeAttemptLaunch(root, target, launch, ownership);
    if (mode !== 'pending') {
      launch = terminal(launch);
      if (mode === 'legacy-completed') delete launch.reviewerHealth;
      await attempts.recordConvergeAttemptLaunch(root, target, launch, ownership);
    }
    await hold?.();
    return launch;
  });
}

if (process.argv[2] === '--primitive-child') {
  const request = JSON.parse(await readFile(process.argv[3]!, 'utf8'));
  if (!process.send) throw new Error('synthetic_child_requires_ipc');
  const send = (phase: string, extra = {}) => process.send!({ phase, pid: process.pid, ...extra });
  const hold = async () => { send('durable-pending'); await new Promise<void>(() => { process.on('message', () => {}); }); };
  if (request.mode === 'resume-complete' || request.mode === 'resume-running' || request.mode === 'resume-running-released') {
    await withNativeTarget(request.root, request.target, async ownership => {
      const expected = (await attempts.loadConvergeAttemptState(request.root, request.target))!.lastLaunch!;
      const processIdentity = await captureProcessIdentity();
      const next = { ...expected, status: 'pending' as const, recovery: { ...expected.recovery!,
        resume: { pid: process.pid, processIdentity, phase: 'running' as const } } };
      const input = { expected, next, nativeSha256: request.nativeSha256, cycleId: request.cycleId };
      await attempts.recordConvergeAttemptRecoveryResume(request.root, request.target, input, ownership);
      if (request.mode === 'resume-running') await hold();
      if (request.mode === 'resume-running-released') return;
      const complete = { ...terminal(next), recovery: { ...next.recovery,
        resume: { pid: process.pid, processIdentity, phase: 'finished' as const } } };
      await attempts.recordConvergeAttemptRecoveryResume(request.root, request.target, { ...input, expected: next, next: complete }, ownership);
      const file = attempts.convergeAttemptStatePath(request.root, request.target), retained = await readFile(file, 'utf8');
      await attempts.recordConvergeAttemptRecoveryResume(request.root, request.target, { ...input, expected: next, next: complete }, ownership);
      if (await readFile(file, 'utf8') !== retained) throw new Error('synthetic_resume_replay_changed_bytes');
    });
    if (request.mode === 'resume-running-released') await hold();
    send('complete');
  } else {
    await spendAndRecord(request.root, request.target, request.mode === 'pending-released' ? 'pending' : request.mode, request.mode === 'pending' ? hold : undefined);
    if (request.mode === 'pending-released') await hold();
    send('complete');
  }
  process.disconnect();
}
