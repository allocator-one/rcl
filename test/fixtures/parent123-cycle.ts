// Same public producer fixture, with only its synthetic endpoint injected for the real CLI continuation.
import type { ClaimSplitInput } from '../../src/evidence/claim-split.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
export async function releasedLoopbackCycleFixture(gitCommonDir: string, baseUrl: string) {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { guardReviewLaunch } = await import('../../src/converge/launch-guard.js');
  const { convergeAttemptStatePath } = await import('../../src/converge/attempt-budget.js');
  const { convergeRunStatePath, processRoundReport } = await import('../../src/converge/run-state.js');
  const { sampleResult, sampleRunHeader } = await import('../telemetry/fixtures.js');
  const target = 'released-cycle-recovery';
  const runPath = convergeRunStatePath(gitCommonDir, target);
  const attemptPath = convergeAttemptStatePath(gitCommonDir, target);
  const at = '2026-09-26T12:00:00.000Z';
  const oldRun = JSON.stringify({ version: 1, target, roundCap: 15, findings: {}, updatedAt: at,
    rounds: [{ round: 1, runId: uuid(400), counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } }] });
  const oldAttempts = JSON.stringify({ version: 2, target, cap: 20, migratedAttempts: 0, attemptsUsed: 3,
    attempts: [1, 2, 3].map(attempt => ({ attempt, claimedAt: at, pid: 99999999, source: 'claim' })), updatedAt: at });
  for (const [path, raw] of [[runPath, oldRun], [attemptPath, oldAttempts]]) {
    await mkdir(dirname(path!), { recursive: true }); await writeFile(path!, raw!);
  }
  let active: import('../../src/converge/review-cycle.js').ReviewCycleReceipt | null = null;
  let reportJson = '';
  const report = sampleResult({ run: sampleRunHeader({ id: uuid(401), rcl_version: '4.1.11' }) });
  await guardReviewLaunch({ gitCommonDir, target, headSha: report.run!.target.head_sha!, inputSha256: 'b'.repeat(64),
    startOver: true, validate: async () => {},
    cycleRemote: { repo: 'allocator-one/rcl', prNumber: 42, url: baseUrl,
      current: async () => active,
      start: async request => (active = { ...request, id: uuid(402), inserted_at: at }) },
    run: async context => {
      report.run!.converge = { target, round: context.round, attempt: context.attempt };
      report.run!.cycle_id = context.cycleId;
      reportJson = JSON.stringify(report);
      return { runId: report.run!.id, reportJsonSha256: sha(reportJson), successfulReviews: 2,
        totalReviews: 2, deliveryPending: false };
    } });
  const processed = await processRoundReport({ gitCommonDir, target, round: 1, runId: report.run!.id,
    findings: [...report.findings, ...report.belowThresholdFindings!], reportSha256: sha(reportJson), cycleId: uuid(402) });
  const nativeJson = await readFile(runPath, 'utf8');
  const native = JSON.parse(nativeJson);
  const archiveJson = await readFile(native.cycle.archivePath, 'utf8');
  const attemptsJson = await readFile(attemptPath, 'utf8');
  const selection: ClaimSplitInput = {
    scope: { base_url: baseUrl, org_id: uuid(2), run_id: report.run!.id, repo: 'allocator-one/rcl', pr_number: 42 },
    target, eventId: uuid(403), occurredAt: '2026-09-26T12:00:00.123456Z', nativeJson, reportJson,
    findingRef: 'f001', previousIdentity: processed.findings[0]!.identity, identity: '2222222222222222',
    descriptor: { version: 1, operation: 'lib/foo.ex :: pagination', invariant: 'Ordering by inserted_at alone is unstable.',
      evidence: ['Add id as a tiebreak.'] }, reason: 'Independent pagination ordering claim.', expectedEventSequence: 1,
    classificationId: uuid(404), sourceReceipts: [{ id: uuid(404), org_id: uuid(2), run_id: report.run!.id,
      repo: 'allocator-one/rcl', pr_number: 42, actor_user_id: uuid(5), kind: 'round_processed', converge_target: target,
      round: 1, attempt: 1, occurred_at: at, payload: { identities: processed.findings.map(row => ({
        identity_key: row.finding.identity, matched_identity: row.identity, status: row.status })) } }],
  };
  return { selection, native, runPath, attemptPath, archivePath: native.cycle.archivePath as string,
    archiveJson, attemptsJson, oldRun, oldAttempts };
}
