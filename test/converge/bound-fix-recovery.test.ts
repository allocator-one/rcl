import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { createBoundFixRecovery } from '../../src/converge/bound-fix-recovery.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { loadConvergeRunState, processRoundReport, recordVerdicts, resolveRoundResolution, writeState } from '../../src/converge/run-state.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import type { GateStatus, RunDetail } from '../../src/evidence/types.js';
import { sha256Hex } from '../../src/report/run-header.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import { HarnessSink } from '../../src/telemetry/sink.js';

const directories: string[] = [];
const target = 'bound-recovery-fixture';
const repo = 'owner/repo';
const prNumber = 42;
const oldRunId = '019921a0-0000-7000-8000-000000000001';
const runId = '019921a0-0000-7000-8000-000000000002';
const recoveredRunId = '019921a0-0000-7000-8000-000000000003';
const headSha = 'd'.repeat(40);
const inputSha256 = 'e'.repeat(64);
const completion = { runId, reportJsonSha256: 'c'.repeat(64), successfulReviews: 3, totalReviews: 3, deliveryPending: false };

function serverEvidence(): { status: GateStatus; run: RunDetail } {
  const advisory: GateStatus['advisory'] = {
    status: 'fixes_pending', head_sha: headSha, conclusive: true, run_id: runId, run_url: null,
    actionable: [], rounds: [{ id: runId, url: null, tier: 'advisory', head_sha: headSha,
      converge_round: 2, ordering_at: null, received_at: null }],
  };
  return {
    status: {
      repo, pr_number: prNumber, head: { sha: headSha, base_sha: 'b'.repeat(40), source: 'github', updated_at: null,
        is_cross_repository: false, merged: false, reviewed_head_sha: null, merge_commit_sha: null, merged_at: null },
      advisory, enforced: { ...advisory, status: 'none', conclusive: null, run_id: null, rounds: [] }, decision: null,
    },
    run: { id: runId, command: 'review', tier: 'advisory', head_verified: 'current', repo_verified: true,
      target: { kind: 'patch', repo, pr_number: prNumber, head_sha: headSha },
      converge: { target, round: 2, attempt: 2 }, findings: [{
        ref: 'F1', identity_key: 'def456abc1237890', file: 'lib/other.ex', start_line: 10, end_line: 12,
        severity: 'important', title: 'Existing guard questioned', gating_reason: 'consensus',
        verdict: { identity_key: 'def456abc1237890', verdict: 'dismissed', round: 2,
          reason: 'Corrected the earlier fixed verdict: the existing guard already handles this case.' },
      }], calls: [] },
  };
}

async function fixture(currentVerdict: 'dismissed' | 'fixed' | 'unresolved' = 'dismissed', caps: { maxAttempts?: number; maxRounds?: number } = {}) {
  const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-bound-fix-recovery-'));
  directories.push(gitCommonDir);
  const options: GuardedLaunchOptions = {
    gitCommonDir, target, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64), ...caps,
    validate: vi.fn().mockResolvedValue(undefined), run: vi.fn().mockResolvedValue({ ...completion, runId: oldRunId }),
  };
  await guardReviewLaunch(options);
  await processRoundReport({ gitCommonDir, target, round: 1, findings: [],
    runId: oldRunId, reportSha256: completion.reportJsonSha256 });
  options.headSha = headSha;
  options.inputSha256 = inputSha256;
  options.run = vi.fn().mockResolvedValue(completion);
  await guardReviewLaunch(options);
  const latest = await processRoundReport({ gitCommonDir, target, round: 2,
    findings: [sampleFinding({ identity: 'def456abc1237890', file: 'lib/other.ex', title: 'Existing guard questioned' })],
    runId, reportSha256: completion.reportJsonSha256 });
  if (currentVerdict !== 'unresolved') {
    const fixed = await recordVerdicts({ gitCommonDir, target, round: 2,
      verdicts: [{ key: latest.findings[0]!.identity, verdict: 'fixed', reason: 'Initially classified as fixed.' }] });
    expect(fixed.resolution).toMatchObject({ status: 'fixes-pending-fresh-round', fixedThisRound: 1 });
    if (currentVerdict === 'dismissed') {
      // A corrected native verdict does not erase the server's already-created
      // bound fix obligation; there has been no later confirming round yet.
      await recordVerdicts({ gitCommonDir, target, round: 2,
        verdicts: [{ key: latest.findings[0]!.identity, verdict: 'dismissed',
          reason: 'Corrected the earlier fixed verdict: the existing guard already handles this case.' }] });
    }
  }
  const evidence = serverEvidence();
  const read = vi.fn(async () => evidence);
  const run = vi.fn().mockResolvedValue({ ...completion, runId: recoveredRunId });
  const recovery = { runId, repo, prNumber, read };
  return { options: { ...options, maxAttempts: undefined, maxRounds: undefined, run }, evidence, read, run, recovery };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('bound fix-obligation recovery (RCL-148)', () => {
  function transportRecovery(evidence: ReturnType<typeof serverEvidence>, overrides: {
    statusBody?: string; runBody?: string; statusCode?: number; runCode?: number;
  } = {}) {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith(`/api/v1/reviews/prs/${repo}/${prNumber}`)) {
        return new Response(overrides.statusBody ?? JSON.stringify({ data: evidence.status }),
          { status: overrides.statusCode ?? 200 });
      }
      if (url.endsWith(`/api/v1/reviews/runs/${runId}`)) {
        return new Response(overrides.runBody ?? JSON.stringify({
          data: evidence.run, meta: { bound_classification_protocol: 1 },
        }), { status: overrides.runCode ?? 200 });
      }
      throw new Error(`Unexpected recovery request: ${url}`);
    });
    const sink = new HarnessSink({
      credential: { url: 'https://harness.example.test', token: 'aone_TESTTOKEN0123456789', source: 'login' },
      rclVersion: 'test', fetchImpl,
    });
    return { recovery: createBoundFixRecovery(sink, repo, prNumber, runId), fetchImpl };
  }

  it('admits recovery through the production data-only PR status and data/meta run envelopes', async () => {
    const f = await fixture();
    const { recovery, fetchImpl } = transportRecovery(f.evidence);

    await guardReviewLaunch({ ...f.options, boundFixRecovery: recovery });

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `https://harness.example.test/api/v1/reviews/prs/${repo}/${prNumber}`,
      `https://harness.example.test/api/v1/reviews/runs/${runId}`,
    ]);
    expect(f.run).toHaveBeenCalledExactlyOnceWith({ target, round: 3, attempt: 3 });
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 3 });
  });

  it.each([
    ['missing status data', (_e: ReturnType<typeof serverEvidence>) => ({ statusBody: JSON.stringify({ meta: {} }) })],
    ['status error envelope', (e: ReturnType<typeof serverEvidence>) => ({ statusBody: JSON.stringify({ data: e.status, error: 'partial' }) })],
    ['extra status envelope key', (e: ReturnType<typeof serverEvidence>) => ({ statusBody: JSON.stringify({ data: e.status, partial: true }) })],
    ['duplicate status data', (e: ReturnType<typeof serverEvidence>) => ({ statusBody: `{"data":null,"data":${JSON.stringify(e.status)}}` })],
    ['partial status HTTP response', (_e: ReturnType<typeof serverEvidence>) => ({ statusCode: 206 })],
    ['missing run metadata', (e: ReturnType<typeof serverEvidence>) => ({ runBody: JSON.stringify({ data: e.run }) })],
    ['run error envelope', (e: ReturnType<typeof serverEvidence>) => ({ runBody: JSON.stringify({ data: e.run, meta: {}, error: 'partial' }) })],
    ['duplicate run metadata', (e: ReturnType<typeof serverEvidence>) => ({ runBody: `{"data":${JSON.stringify(e.run)},"meta":{},"meta":{}}` })],
    ['partial run HTTP response', (_e: ReturnType<typeof serverEvidence>) => ({ runCode: 206 })],
  ] as const)('rejects %s over transport without spending or changing native history', async (_label, override) => {
    const f = await fixture();
    const { recovery } = transportRecovery(f.evidence, override(f.evidence));
    const before = await loadConvergeRunState(f.options.gitCommonDir, target);
    const attempts = await loadConvergeAttemptState(f.options.gitCommonDir, target);

    await expect(guardReviewLaunch({ ...f.options, boundFixRecovery: recovery }))
      .rejects.toMatchObject({ code: 'bound_fix_recovery_invalid' });

    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeRunState(f.options.gitCommonDir, target)).toEqual(before);
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toEqual(attempts);
  });

  it('recovers a fixed verdict corrected to dismissed in the latest round while preserving history and caps', async () => {
    const f = await fixture('dismissed', { maxAttempts: 7, maxRounds: 5 });
    const before = (await loadConvergeRunState(f.options.gitCommonDir, target))!;
    const attempts = (await loadConvergeAttemptState(f.options.gitCommonDir, target))!;
    expect(resolveRoundResolution(before, 2)).toMatchObject({ status: 'converged-dismissal-only', fixedThisRound: 0 });
    f.read.mockImplementation(async () => {
      expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toEqual(attempts);
      expect(f.run).not.toHaveBeenCalled();
      return f.evidence;
    });

    await guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery });

    expect(f.read).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledExactlyOnceWith({ target, round: 3, attempt: 3 });
    const launched = (await loadConvergeRunState(f.options.gitCommonDir, target))!;
    expect(launched.rounds).toEqual(before.rounds);
    expect(launched.findings).toEqual(before.findings);
    expect(launched.roundCap).toBe(5);
    const spent = (await loadConvergeAttemptState(f.options.gitCommonDir, target))!;
    expect(spent).toMatchObject({ cap: 7, attemptsUsed: 3, migratedAttempts: 0 });
    expect(spent.attempts.slice(0, 2)).toEqual(attempts.attempts);
    await processRoundReport({ gitCommonDir: f.options.gitCommonDir, target, round: 3, findings: [],
      runId: recoveredRunId, reportSha256: completion.reportJsonSha256 });
    expect((await loadConvergeRunState(f.options.gitCommonDir, target))!.rounds.map(r => [r.round, r.runId]))
      .toEqual([[1, oldRunId], [2, runId], [3, recoveredRunId]]);

    await expect(guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery })).rejects.toThrow();
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('keeps ordinary unchanged reviews refused after correcting a fixed verdict to dismissed', async () => {
    const f = await fixture();
    await expect(guardReviewLaunch(f.options)).rejects.toThrow('inputs_unchanged');
    expect(f.read).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });

  it('enforces one-shot recovery even when a later admitted run still reports the same obligation', async () => {
    const f = await fixture();
    await guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery });
    await processRoundReport({ gitCommonDir: f.options.gitCommonDir, target, round: 3, findings: [],
      runId: recoveredRunId, reportSha256: completion.reportJsonSha256 });
    // Selecting the newly admitted run must not turn a persistent server
    // obligation into an unlimited sequence of unchanged-input councils.
    f.evidence.status.advisory.run_id = recoveredRunId;
    f.evidence.status.advisory.rounds[0]!.id = recoveredRunId;
    f.evidence.status.advisory.rounds[0]!.converge_round = 3;
    f.evidence.run.id = recoveredRunId;
    f.evidence.run.converge = { target, round: 3, attempt: 3 };
    f.evidence.run.findings = [];
    f.read.mockClear();
    f.run.mockClear();
    const state = await loadConvergeRunState(f.options.gitCommonDir, target);
    const attempts = await loadConvergeAttemptState(f.options.gitCommonDir, target);

    await expect(guardReviewLaunch({ ...f.options,
      boundFixRecovery: { ...f.recovery, runId: recoveredRunId, repo: repo.toUpperCase() },
    })).rejects.toMatchObject({ code: 'bound_fix_recovery_already_claimed' });

    expect(f.read).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeRunState(f.options.gitCommonDir, target)).toEqual(state);
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toEqual(attempts);
  });

  it('retains structured recovery proof in the spent attempt after a later launch replaces lastLaunch', async () => {
    const f = await fixture();
    await guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery });
    const recovered = (await loadConvergeAttemptState(f.options.gitCommonDir, target))!.attempts[2]!;
    expect(recovered).toMatchObject({
      attempt: 3,
      boundFixRecoverySource: {
        version: 1, runId, target, repo, prNumber, headSha, inputSha256, round: 2, attempt: 2,
        verifiedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        serverProof: {
          status: 'fixes_pending', conclusive: true, actionableCount: 0,
          classificationPending: null, legacyPendingCount: null,
          statusSha256: sha256Hex(JSON.stringify(f.evidence.status)),
          runSha256: sha256Hex(JSON.stringify(f.evidence.run)),
        },
      },
    });
    await processRoundReport({ gitCommonDir: f.options.gitCommonDir, target, round: 3, findings: [],
      runId: recoveredRunId, reportSha256: completion.reportJsonSha256 });

    const laterRunId = '019921a0-0000-7000-8000-000000000004';
    await guardReviewLaunch({ ...f.options, headSha: 'f'.repeat(40), inputSha256: 'a'.repeat(64),
      run: vi.fn().mockResolvedValue({ ...completion, runId: laterRunId }) });

    const spent = (await loadConvergeAttemptState(f.options.gitCommonDir, target))!;
    expect(spent.attempts[2]).toEqual(recovered);
    expect(spent.attempts[3]).not.toHaveProperty('boundFixRecoverySource');
    expect(spent.attemptsUsed).toBe(4);
    expect((await loadConvergeRunState(f.options.gitCommonDir, target))!.lastLaunch)
      .toMatchObject({ runId: laterRunId, round: 4, attempt: 4 });
  });

  it.each([
    ['unknown projection', (e: ReturnType<typeof serverEvidence>) => { e.status.advisory.status = 'unknown'; }],
    ['already converged', (e: ReturnType<typeof serverEvidence>) => { e.status.advisory.status = 'converged'; }],
    ['inconclusive evidence', (e: ReturnType<typeof serverEvidence>) => { e.status.advisory.conclusive = false; }],
    ['unknown conclusiveness', (e: ReturnType<typeof serverEvidence>) => { e.status.advisory.conclusive = null; }],
    ['merged PR', (e: ReturnType<typeof serverEvidence>) => { e.status.head!.merged = true; }],
    ['missing PR head', (e: ReturnType<typeof serverEvidence>) => { e.status.head = null; }],
    ['moved PR head', (e: ReturnType<typeof serverEvidence>) => { e.status.head!.sha = 'f'.repeat(40); }],
    ['wrong projection head', (e: ReturnType<typeof serverEvidence>) => { e.status.advisory.head_sha = 'f'.repeat(40); }],
    ['wrong projection run', (e: ReturnType<typeof serverEvidence>) => { e.status.advisory.run_id = oldRunId; }],
    ['wrong server repository', (e: ReturnType<typeof serverEvidence>) => { e.status.repo = 'other/repo'; }],
    ['wrong server PR', (e: ReturnType<typeof serverEvidence>) => { e.status.pr_number = 99; }],
    ['unbound run', (e: ReturnType<typeof serverEvidence>) => { e.run.converge = null; }],
    ['wrong native target', (e: ReturnType<typeof serverEvidence>) => { e.run.converge!.target = 'another-target'; }],
    ['wrong native round', (e: ReturnType<typeof serverEvidence>) => { e.run.converge!.round = 1; }],
    ['wrong recorded run', (e: ReturnType<typeof serverEvidence>) => { e.run.id = oldRunId; }],
    ['wrong run head', (e: ReturnType<typeof serverEvidence>) => { e.run.target.head_sha = 'f'.repeat(40); }],
    ['run bound to another PR', (e: ReturnType<typeof serverEvidence>) => { e.run.target.pr_number = 99; }],
    ['run bound to another repository', (e: ReturnType<typeof serverEvidence>) => { e.run.target.repo = 'other/repo'; }],
    ['run without PR binding', (e: ReturnType<typeof serverEvidence>) => { delete e.run.target.pr_number; }],
    ['server actionable findings', (e: ReturnType<typeof serverEvidence>) => {
      e.status.advisory.actionable.push({ ref: 'F1', identity_key: 'remaining', severity: 'important', gating_reason: 'consensus',
        file: 'a.ts', start_line: 1, end_line: 1, title: 'Still unresolved' });
    }],
  ] as const)('refuses %s without spending or changing native history', async (_label, mutate) => {
    const f = await fixture();
    mutate(f.evidence);
    const before = await loadConvergeRunState(f.options.gitCommonDir, target);
    const attempts = await loadConvergeAttemptState(f.options.gitCommonDir, target);
    await expect(guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery })).rejects.toThrow();
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeRunState(f.options.gitCommonDir, target)).toEqual(before);
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toEqual(attempts);
  });

  it('fails closed when the server read fails', async () => {
    const f = await fixture();
    f.read.mockRejectedValue(new Error('Evidence unavailable'));
    await expect(guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery })).rejects.toThrow();
    expect(f.read).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });

  it.each(['fixed', 'unresolved'] as const)('refuses current native %s findings even if the server reports no actionable findings', async verdict => {
    const f = await fixture(verdict);
    await expect(guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });

  it('refuses an admitted native round whose run binding was lost', async () => {
    const f = await fixture();
    await withNativeTarget(f.options.gitCommonDir, target, async ownership => {
      const state = (await loadConvergeRunState(f.options.gitCommonDir, target))!;
      delete state.rounds[1]!.runId;
      await writeState(f.options.gitCommonDir, state, ownership);
    });
    await expect(guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });

  it.each([{ maxAttempts: 2 }, { maxRounds: 2 }])('preserves an exhausted cap: %j', async caps => {
    const f = await fixture('dismissed', caps);
    const before = await loadConvergeAttemptState(f.options.gitCommonDir, target);
    await expect(guardReviewLaunch({ ...f.options, boundFixRecovery: f.recovery })).rejects.toThrow(/cap|budget/i);
    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toEqual(before);
  });

  it.each([
    { startOver: true }, { retryReason: 'Provider retry' },
    { intent: 'stop-upstream' as const }, { intent: 'stop-review' as const }, { intent: 'retry-delivery' as const },
  ])('refuses incompatible launch modes before spending: %j', async mode => {
    const f = await fixture();
    await expect(guardReviewLaunch({ ...f.options, ...mode, boundFixRecovery: f.recovery })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(f.options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });
});
