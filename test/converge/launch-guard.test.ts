import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, hasHealthyGuardedLaunch, launchSchema, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { claimConvergeAttempt, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import { assertNativeTargetOwnership, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { decodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';
import type { ConvergeContext } from '../../src/report/run-header.js';

const directories: string[] = [];
const target = 'fixture-launch';
const completion = {
  runId: '019921a0-0000-7000-8000-000000000001',
  reportJsonSha256: 'c'.repeat(64),
  successfulReviews: 3,
  totalReviews: 3,
  deliveryPending: false,
};

async function fixture(): Promise<GuardedLaunchOptions> {
  const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-launch-guard-'));
  directories.push(gitCommonDir);
  return {
    gitCommonDir, target, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
    validate: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(completion),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('native guarded review launch', () => {

  it('rejects completion whose blocking failures exceed aggregate failures while retaining the spent claim', async () => {
    const options = await fixture();
    options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 17, totalReviews: 18,
      reviewerHealth: { version: 1, policy: resolveQuorumPolicy(17), successfulSeats: 0 } });
    await expect(guardReviewLaunch({ ...options, maxAttempts: 2, maxRounds: 4 }))
      .rejects.toThrow('Blocking reviewer health must be a subset of aggregate review counts');
    expect(options.run).toHaveBeenCalledTimes(1);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1, cap: 2 });
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({ roundCap: 4, rounds: [], lastLaunch: { status: 'failed' } });
  });

  it('rejects persisted excess blocking failures before validation or another claim', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    const path = convergeRunStatePath(options.gitCommonDir, target);
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.lastLaunch = { ...state.lastLaunch, successfulReviews: 17, totalReviews: 18,
      reviewerHealth: { version: 1, policy: resolveQuorumPolicy(17), successfulSeats: 0 } };
    await writeFile(path, JSON.stringify(state));
    const before = await readFile(path), claims = await loadConvergeAttemptState(options.gitCommonDir, target);
    await expect(guardReviewLaunch({ ...options, retryReason: 'A reason cannot authorize contradictory health.' }))
      .rejects.toMatchObject({ name: 'ZodError', issues: [{ code: 'custom', path: [] }] });
    expect(await readFile(path)).toEqual(before);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toEqual(claims);
    expect(options.validate).toHaveBeenCalledTimes(1);
    expect(options.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'ordinary mixed lanes', successful: 6, aggregateSuccessful: 11, aggregateTotal: 15, marker: {} },
    { label: 'retained original', successful: 7, aggregateSuccessful: 7, aggregateTotal: 10,
      marker: { retainedOriginal: { version: 1, runId: completion.runId,
        planDigest: 'd'.repeat(64), capturedInputsSha256: 'e'.repeat(64) } } },
    { label: 'retained successor', successful: 7, aggregateSuccessful: 7, aggregateTotal: 10,
      marker: { recovery: { operationId: '019921a0-0000-7000-8000-000000000002', sourceRunId: completion.runId,
        originalNativeClaim: { attempt: 1, round: 1 }, sourceNativeClaim: { attempt: 1, round: 1 } } } },
  ])('preserves truthful failure counts and launch bindings for $label', ({ successful, aggregateSuccessful, aggregateTotal, marker }) => {
    const value = { status: 'completed', attempt: 2, round: 1, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
      startedAt: '2026-09-28T02:00:00.000Z', pid: 123, ...completion,
      successfulReviews: aggregateSuccessful, totalReviews: aggregateTotal,
      reviewerHealth: { version: 1, policy: resolveQuorumPolicy(10), successfulSeats: successful }, ...marker };
    expect(launchSchema.parse(value)).toEqual(value);
    expect(hasHealthyGuardedLaunch(launchSchema.parse(value))).toBe(successful >= 7);
  });

  it('requires infrastructure recovery when two of three seats fail a frozen all-seat policy', async () => {
    const options = await fixture(), reviewerHealth = { version: 1, policy: resolveQuorumPolicy(3, 1), successfulSeats: 2 };
    options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 2, reviewerHealth });
    await guardReviewLaunch({ ...options, maxAttempts: 2, maxRounds: 4 });
    const priorState = await readFile(convergeRunStatePath(options.gitCommonDir, target));

    await expect(guardReviewLaunch(options)).rejects.toThrow('infrastructure_failure');
    expect(await readFile(convergeRunStatePath(options.gitCommonDir, target))).toEqual(priorState);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1, cap: 2 });
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({ roundCap: 4, rounds: [], lastLaunch: { reviewerHealth } });

    await guardReviewLaunch({ ...options, retryReason: 'Original reviewer outage diagnosed; bounded infrastructure recovery.' });
    expect(options.run).toHaveBeenLastCalledWith({ target, round: 1, attempt: 2 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2, cap: 2 });
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({ roundCap: 4, rounds: [] });
  });

  it('retains a two-thirds health summary and requires original report admission instead of another review', async () => {
    const options = await fixture(), reviewerHealth = { version: 1, policy: resolveQuorumPolicy(3, 2 / 3), successfulSeats: 2 };
    options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 2, reviewerHealth });
    await guardReviewLaunch(options);
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({ rounds: [], lastLaunch: { reviewerHealth } });
    await expect(guardReviewLaunch(options)).rejects.toThrow('report_not_admitted');
    await expect(guardReviewLaunch({ ...options, retryReason: 'A reason cannot replace original admission.' })).rejects.toThrow('report_not_admitted');
    expect(options.run).toHaveBeenCalledTimes(1); expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  it('keeps the legacy two-thirds health rule when no versioned summary was recorded', async () => {
    const options = await fixture(); options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 2 });
    await guardReviewLaunch(options);
    await expect(guardReviewLaunch(options)).rejects.toThrow('report_not_admitted');
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  const corruptHealth = (kind: string): any => {
    const summary: any = { version: 1, policy: resolveQuorumPolicy(3, 2 / 3), successfulSeats: 2 };
    if (kind === 'summary version') summary.version = 2;
    else if (kind === 'policy version') summary.policy.version = 2;
    else if (kind === 'fraction below floor') summary.policy.fraction = 0.5;
    else if (kind === 'fraction above one') summary.policy.fraction = 1.1;
    else if (kind === 'non-finite fraction') summary.policy.fraction = Number.NaN;
    else if (kind === 'forged minimum') summary.policy.minimumSuccessful = 1;
    else if (kind === 'fractional seat count') summary.policy.seatCount = 3.5;
    else if (kind === 'denominator mismatch') summary.policy = resolveQuorumPolicy(4, 2 / 3);
    else if (kind === 'success mismatch') summary.successfulSeats = 3;
    else if (kind === 'fractional successes') summary.successfulSeats = 2.5;
    else if (kind === 'unknown policy key') summary.policy.authority = 'attested';
    else summary.authority = 'attested';
    return summary;
  };
  const corruptions = ['summary version', 'policy version', 'fraction below floor', 'fraction above one', 'non-finite fraction',
    'forged minimum', 'fractional seat count', 'denominator mismatch', 'success mismatch', 'fractional successes', 'unknown policy key', 'unknown summary key'];

  it.each(corruptions)('rejects completion with %s without refunding the actual attempt or admitting a round', async kind => {
    const options = await fixture();
    options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 2, reviewerHealth: corruptHealth(kind) });
    await expect(guardReviewLaunch({ ...options, maxAttempts: 2, maxRounds: 4 })).rejects.toThrow();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1, cap: 2 });
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({ roundCap: 4, rounds: [], lastLaunch: { status: 'failed' } });
  });

  it.each(corruptions)('rejects persisted %s before validation or another attempt claim', async kind => {
    const options = await fixture(); await guardReviewLaunch(options);
    const path = convergeRunStatePath(options.gitCommonDir, target), state = JSON.parse(await readFile(path, 'utf8'));
    state.lastLaunch.successfulReviews = 2; state.lastLaunch.reviewerHealth = corruptHealth(kind);
    await writeFile(path, JSON.stringify(state)); const original = await readFile(path);
    await expect(guardReviewLaunch({ ...options, retryReason: 'Cannot bypass invalid persisted metadata.' })).rejects.toThrow();
    expect(await readFile(path)).toEqual(original); expect(options.validate).toHaveBeenCalledTimes(1); expect(options.run).toHaveBeenCalledTimes(1);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  it('passes existing target ownership to checkpoint work and expires it after launch', async () => {
    const options = await fixture();
    let retainedOwnership!: NativeTargetOwnership;
    options.run = async (context, ownership) => {
      expect(context.attempt).toBe(1);
      await assertNativeTargetOwnership(ownership, options.gitCommonDir, target);
      retainedOwnership = ownership;
      return completion;
    };

    await guardReviewLaunch(options);

    await expect(assertNativeTargetOwnership(retainedOwnership, options.gitCommonDir, target))
      .rejects.toThrow('native_target_not_owned');
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  it('validates before claiming and derives the first round without admitting it', async () => {
    const options = await fixture();
    options.validate = vi.fn(async () => {
      expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    });

    await guardReviewLaunch(options);

    expect(options.run).toHaveBeenCalledWith({ target, round: 1, attempt: 1 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({
      rounds: [], lastLaunch: { status: 'completed', attempt: 1, round: 1, runId: completion.runId },
    });
  });

  it('rejects a syntactically valid wrong ordinal before claiming or dispatching', async () => {
    const options = await fixture();

    await expect(guardReviewLaunch({ ...options, round: 27 })).rejects.toThrow(/round.*1/i);

    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
  });

  it('spends nothing when preflight refuses an input or output', async () => {
    const options = await fixture();
    options.validate = vi.fn().mockRejectedValue(new Error('invalid output destination'));

    await expect(guardReviewLaunch(options)).rejects.toThrow('invalid output destination');

    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
  });

  it('does not rerun a completed council to retry evidence delivery', async () => {
    const options = await fixture();
    options.run = vi.fn().mockResolvedValue({ ...completion, deliveryPending: true });
    await guardReviewLaunch(options);

    await expect(guardReviewLaunch(options)).rejects.toThrow(/delivery.*flush|flush.*delivery/i);

    expect(options.run).toHaveBeenCalledTimes(1);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  it('does not let old delivery metadata block a materially changed input after native admission', async () => {
    const options = await fixture();
    options.run = vi.fn().mockResolvedValue({ ...completion, deliveryPending: true });
    await guardReviewLaunch(options);
    await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [], runId: completion.runId, reportSha256: completion.reportJsonSha256 });

    await guardReviewLaunch({ ...options, inputSha256: 'd'.repeat(64) });

    expect(options.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 2 }, expect.objectContaining({ target }));
  });

  it('refuses a round-cap override beyond the existing hard maximum before claiming', async () => {
    const options = await fixture();

    await expect(guardReviewLaunch({ ...options, maxRounds: 100 })).rejects.toThrow(/between 2 and 99/);

    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
  });

  it('keeps unknown dispatch spent and refuses blind retry even with a new head', async () => {
    const options = await fixture();
    options.run = vi.fn().mockRejectedValue(new Error('fixture process failed'));
    await expect(guardReviewLaunch(options)).rejects.toThrow('fixture process failed');

    await expect(guardReviewLaunch({ ...options, headSha: 'd'.repeat(40) })).rejects.toThrow(/retry.*reason|unknown/i);

    expect(options.run).toHaveBeenCalledTimes(1);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  it('retains a legacy claim when an explicit bounded recovery starts the same unadmitted round', async () => {
    const options = await fixture();
    await claimConvergeAttempt({ gitCommonDir: options.gitCommonDir, target });

    await expect(guardReviewLaunch(options)).rejects.toThrow(/legacy|unknown|retry/i);
    await guardReviewLaunch({ ...options, retryReason: 'Original process is terminal; corrected launcher fixture passed.' });

    expect(options.run).toHaveBeenCalledWith({ target, round: 1, attempt: 2 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });

  it('projects legacy ledger claims without mistaking their count for the next round', async () => {
    const options = await fixture();
    await writeFile(join(options.gitCommonDir, `rcl-converge-${target}-ledger.md`), '## Round 7\n');

    await expect(guardReviewLaunch(options)).rejects.toThrow('legacy_dispatch_unknown');
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    await guardReviewLaunch({ ...options, retryReason: 'Legacy launch audited; no native round was admitted.' });

    expect(options.run).toHaveBeenCalledWith({ target, round: 1, attempt: 8 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target))
      .toMatchObject({ attemptsUsed: 8, migratedAttempts: 7 });
  });

  it('requires a recovery decision for unhealthy dispatch even when the head changes', async () => {
    const options = await fixture();
    options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 1, hardFailure: true,
      reviewerHealth: { version: 1, policy: { version: 1, fraction: 2 / 3, seatCount: 3, minimumSuccessful: 2 }, successfulSeats: 1 } });
    await guardReviewLaunch(options);
    const changed = { ...options, headSha: 'd'.repeat(40) };

    await expect(guardReviewLaunch(changed)).rejects.toThrow('infrastructure_failure');
    await guardReviewLaunch({ ...changed, retryReason: 'Credentials repaired and independently checked.' });

    expect(options.run).toHaveBeenLastCalledWith({ target, round: 1, attempt: 2 }, expect.objectContaining({ target }));
  });

  it('allows explicit cap consent without an extra preclaim or reset', async () => {
    const options = await fixture();
    options.run = vi.fn().mockRejectedValue(new Error('lost dispatch'));
    await expect(guardReviewLaunch({ ...options, maxAttempts: 1 })).rejects.toThrow('lost dispatch');
    options.run = vi.fn().mockResolvedValue(completion);
    await expect(guardReviewLaunch({ ...options, retryReason: 'Launcher repaired.' })).rejects.toThrow(/budget exhausted/i);
    await guardReviewLaunch({ ...options, retryReason: 'Launcher repaired.', maxAttempts: 2 });

    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ cap: 2, attemptsUsed: 2 });
    expect(options.run).toHaveBeenCalledWith({ target, round: 1, attempt: 2 }, expect.objectContaining({ target }));
  });

  it('does not turn stop-upstream into stop-review, while explicit stop-review prevents launch', async () => {
    const options = await fixture();

    await expect(guardReviewLaunch({ ...options, intent: 'stop-review' })).rejects.toThrow(/stop/i);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    await guardReviewLaunch({ ...options, intent: 'stop-upstream' });

    expect(options.run).toHaveBeenCalledTimes(1);
  });

  it('refuses unchanged reviewed inputs rather than scheduling an optional confirmation round', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [], runId: completion.runId, reportSha256: completion.reportJsonSha256 });

    await expect(guardReviewLaunch(options)).rejects.toThrow(/unchanged|already.*review/i);

    expect(options.run).toHaveBeenCalledTimes(1);
  });

  it('requires changed inputs after a real fix and derives the next admitted ordinal', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    const report = await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: completion.runId, reportSha256: completion.reportJsonSha256 });
    await recordVerdicts({ gitCommonDir: options.gitCommonDir, target, round: 1,
      verdicts: [{ key: report.findings[0]!.identity, verdict: 'fixed', reason: 'Fixture fix validated.' }] });

    await expect(guardReviewLaunch(options)).rejects.toThrow(/fix|unchanged/i);
    await expect(guardReviewLaunch({ ...options, inputSha256: 'f'.repeat(64) })).rejects.toThrow(/fix.*head|head.*fix/i);
    await guardReviewLaunch({ ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64) });

    expect(options.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 2 }, expect.objectContaining({ target }));
  });

  it('permits a bounded same-head retry when the review after a real fix is inconclusive', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    const report = await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: completion.runId, reportSha256: completion.reportJsonSha256 });
    await recordVerdicts({ gitCommonDir: options.gitCommonDir, target, round: 1,
      verdicts: [{ key: report.findings[0]!.identity, verdict: 'fixed', reason: 'Fixture fix validated.' }] });

    const fixedHead = { ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64),
      run: vi.fn().mockResolvedValue({ ...completion, runId: '019921a0-0000-7000-8000-000000000002', successfulReviews: 1,
        reviewerHealth: { version: 1, policy: { version: 1, fraction: 2 / 3, seatCount: 3, minimumSuccessful: 2 }, successfulSeats: 1 } }) };
    await guardReviewLaunch(fixedHead);
    await expect(guardReviewLaunch(fixedHead)).rejects.toThrow(/infrastructure.failure|retry.reason/i);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });

    await guardReviewLaunch({ ...fixedHead, retryReason: 'Inconclusive reviewer quorum; provider health checked.' });
    expect(fixedHead.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 3 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 3 });
  });

  it('does not let an infrastructure retry defer admitted in-scope blockers', async () => {
    const options = await fixture();
    options.run = vi.fn().mockResolvedValue({ ...completion, hardFailure: true });
    await guardReviewLaunch(options);
    await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: completion.runId, reportSha256: completion.reportJsonSha256 });

    await expect(guardReviewLaunch({ ...options, headSha: 'd'.repeat(40),
      retryReason: 'Fixture credential recovery.' })).rejects.toThrow(/triage|gating/i);

    expect(options.run).toHaveBeenCalledTimes(1);
  });

  it('refuses a conflicting active launch without claiming or canceling the original', async () => {
    const options = await fixture();
    let release: () => void = () => {};
    let started: () => void = () => {};
    const running = new Promise<void>(resolve => { started = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    options.run = vi.fn(async () => { started(); await finish; return completion; });
    const first = guardReviewLaunch(options);
    await Promise.race([running, first]);
    try {
      await expect(guardReviewLaunch({ ...options, intent: 'stop-upstream' })).rejects.toThrow();
      expect(options.run).toHaveBeenCalledTimes(1);
      expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
    } finally {
      release();
      await first;
    }
  }, 15_000);

  it('uses recorded blocking health, not aggregate counters, for an inconclusive completed launch (RCL-136)', async () => {
    const options = await fixture();
    // 11/17 blocking seats plus one async success: aggregate 12/18 looks healthy.
    const blocking = { version: 1 as const, policy: resolveQuorumPolicy(17), successfulSeats: 11 };
    options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 12, totalReviews: 18, reviewerHealth: blocking });
    await guardReviewLaunch(options);
    const recorded = launchSchema.parse((await loadConvergeRunState(options.gitCommonDir, target))!.lastLaunch);
    expect(recorded).toMatchObject({ successfulReviews: 12, totalReviews: 18, reviewerHealth: blocking });
    expect(hasHealthyGuardedLaunch(recorded)).toBe(false);
    expect(hasHealthyGuardedLaunch({ ...recorded, reviewerHealth: undefined })).toBe(true); // legacy aggregate-only rule

    // The report cannot be admitted, and the same inputs need an explicit bounded retry.
    await expect(processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1, findings: [sampleFinding()],
      runId: completion.runId, reportSha256: completion.reportJsonSha256 })).rejects.toThrow('report_health_inconclusive');
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({ rounds: [], findings: {} });
    // Other bytes or another round for the same run are a launch mismatch, not a health verdict.
    await expect(processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1, findings: [],
      runId: completion.runId, reportSha256: 'd'.repeat(64) })).rejects.toThrow('report_launch_mismatch');
    await expect(processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 2, findings: [],
      runId: completion.runId, reportSha256: completion.reportJsonSha256 })).rejects.toThrow('report_launch_mismatch');
    const fresh = options;
    await expect(guardReviewLaunch(fresh)).rejects.toThrow('infrastructure_failure');
    fresh.run = vi.fn().mockResolvedValue({ ...completion, runId: '019921a0-0000-7000-8000-000000000003',
      successfulReviews: 13, totalReviews: 18, reviewerHealth: { ...blocking, successfulSeats: 12 } });
    await guardReviewLaunch({ ...fresh, retryReason: 'Blocking quorum 11/17 < 12; same roster, bounded retry.' });
    expect(fresh.run).toHaveBeenLastCalledWith({ target, round: 1, attempt: 2 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(fresh.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
    expect(hasHealthyGuardedLaunch(launchSchema.parse((await loadConvergeRunState(fresh.gitCommonDir, target))!.lastLaunch))).toBe(true);
  });

  it('honors a stricter recorded policy and refuses a forged blocking policy', async () => {
    const strict = { version: 1 as const, policy: resolveQuorumPolicy(10, 1), successfulSeats: 9 };
    const base = { status: 'completed' as const, attempt: 1, round: 1, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
      startedAt: new Date().toISOString(), pid: 1, ...completion, successfulReviews: 13, totalReviews: 14 };
    expect(hasHealthyGuardedLaunch(launchSchema.parse({ ...base, reviewerHealth: strict }))).toBe(false);
    expect(hasHealthyGuardedLaunch(launchSchema.parse({ ...base, reviewerHealth: { ...strict, successfulSeats: 10 } }))).toBe(true);
    for (const forged of [
      { ...strict, policy: { ...strict.policy, minimumSuccessful: 5 } },
      { ...strict, policy: { ...strict.policy, fraction: 0.5, minimumSuccessful: 5 } },
      { ...strict, successfulSeats: 11 },
    ]) expect(launchSchema.safeParse({ ...base, reviewerHealth: forged }).success).toBe(false);
    expect(launchSchema.safeParse({ ...base, status: 'pending', reviewerHealth: strict }).success).toBe(false);
  });

  it('cannot use an explicit retry decision to raise or reset the existing cap', async () => {
    const options = await fixture();
    await claimConvergeAttempt({ gitCommonDir: options.gitCommonDir, target, maxAttempts: 1 });

    await expect(guardReviewLaunch({ ...options, retryReason: 'Fixture recovery.' })).rejects.toThrow(/budget exhausted/i);

    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ cap: 1, attemptsUsed: 1 });
  });
});

function retainedOriginal() {
  const digest = 'd'.repeat(64);
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: digest, configSha256: digest, specSha256: digest, contextSha256: digest, toolsSha256: digest,
    parser: { name: 'findings-json', version: 1 },
    roster: [{ seat: 's0', model: 'm0', role: 'general', route: 'fake' }],
    chunks: [{ index: 0, total: 1, digest }],
    prompts: [{ seat: 's0', chunk: 0, systemSha256: digest, userSha256: digest }] });
  return { plan, input: { runId: completion.runId, capturedInputsSha256: digest, planDigest: plan.digest,
    startedAtMs: 1000, expiresAtMs: 6000, maxPhysicalCalls: 2, maxAttemptsPerCell: 2 } };
}

describe('ordinary launch retention before claim', () => {
  it.each(['e'.repeat(40), null])('binds retained input bytes and base %s before dispatch and preserves the binding at completion', async baseSha => {
    const options = await fixture();
    const ordinaryInputs = { version: 1 as const, packetSha256: 'd'.repeat(64), baseSha };
    const originalBinding = { ...ordinaryInputs };
    options.run = vi.fn(async () => {
      expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({
        lastLaunch: { status: 'pending', ordinaryInputs: originalBinding },
      });
      // The guard owns a validated snapshot, not the caller's mutable marker.
      ordinaryInputs.packetSha256 = 'f'.repeat(64);
      return completion;
    });

    await guardReviewLaunch({ ...options, beforeClaim: async () => ({ ordinaryInputs }) });

    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({
      lastLaunch: { status: 'completed', ordinaryInputs: originalBinding },
    });
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  it('keeps the retained input binding when provider dispatch fails after the claim', async () => {
    const options = await fixture();
    const ordinaryInputs = { version: 1 as const, packetSha256: 'd'.repeat(64), baseSha: 'e'.repeat(40) };
    options.run = vi.fn().mockRejectedValue(new Error('provider disconnected'));

    await expect(guardReviewLaunch({ ...options, beforeClaim: async () => ({ ordinaryInputs }) }))
      .rejects.toThrow('provider disconnected');

    expect(await loadConvergeRunState(options.gitCommonDir, target)).toMatchObject({
      lastLaunch: { status: 'failed', ordinaryInputs },
    });
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  it.each([
    { version: 2, packetSha256: 'd'.repeat(64), baseSha: null },
    { version: 1, packetSha256: 'invalid', baseSha: null },
    { version: 1, packetSha256: 'd'.repeat(64), baseSha: 'invalid' },
    { version: 1, packetSha256: 'd'.repeat(64) },
  ])('rejects malformed retained input binding before spending a claim: %j', async ordinaryInputs => {
    const options = await fixture();

    await expect(guardReviewLaunch({ ...options, beforeClaim: async () => ({ ordinaryInputs }) } as any))
      .rejects.toThrow();

    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toBeUndefined();
  });

  it('durably retains authenticated inputs with the exact upcoming claim before dispatch', async () => {
    const options = await fixture();
    const retainedPath = join(options.gitCommonDir, 'retained-inputs.json');
    const captured = { headSha: options.headSha, baseSha: 'e'.repeat(40), inputSha256: options.inputSha256 };
    const order: string[] = [];
    options.validate = async () => { order.push('validate'); };
    const beforeClaim = vi.fn(async (context: ConvergeContext, ownership: NativeTargetOwnership) => {
      await assertNativeTargetOwnership(ownership, options.gitCommonDir, target);
      expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
      expect(await loadConvergeRunState(options.gitCommonDir, target)).toBeUndefined();
      await writeFile(retainedPath, JSON.stringify({ ...captured, context }));
      order.push('retain');
    });
    options.onClaim = async () => { order.push('claim'); };
    options.run = vi.fn(async context => {
      expect(JSON.parse(await readFile(retainedPath, 'utf8'))).toEqual({ ...captured, context });
      order.push('dispatch');
      return completion;
    });

    await guardReviewLaunch({ ...options, beforeClaim });

    expect(order).toEqual(['validate', 'retain', 'claim', 'dispatch']);
    expect(beforeClaim).toHaveBeenCalledExactlyOnceWith({ target, round: 1, attempt: 1 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });

  it('fails closed without spending a claim when retaining inputs fails', async () => {
    const options = await fixture();
    const beforeClaim = vi.fn(async () => { throw new Error('retained package write failed'); });

    await expect(guardReviewLaunch({ ...options, beforeClaim })).rejects.toThrow('retained package write failed');

    expect(beforeClaim).toHaveBeenCalledTimes(1);
    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toBeUndefined();
  });

  it('retains the next existing attempt on bounded retry and skips retention when the budget refuses', async () => {
    const options = await fixture();
    const beforeClaim = vi.fn(async () => {});
    options.run = vi.fn().mockRejectedValueOnce(new Error('dispatch lost')).mockResolvedValueOnce(completion);
    await expect(guardReviewLaunch({ ...options, beforeClaim, maxAttempts: 1 })).rejects.toThrow('dispatch lost');
    await expect(guardReviewLaunch({ ...options, beforeClaim, retryReason: 'Provider recovered.' }))
      .rejects.toThrow(/budget exhausted/i);
    expect(beforeClaim).toHaveBeenCalledTimes(1);

    await guardReviewLaunch({ ...options, beforeClaim, maxAttempts: 2, retryReason: 'Provider recovered.' });

    expect(beforeClaim).toHaveBeenNthCalledWith(2, { target, round: 1, attempt: 2 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2, cap: 2 });
  });

  it('does not retain inputs before launch validation succeeds', async () => {
    const options = await fixture();
    const beforeClaim = vi.fn(async () => {});
    options.validate = async () => { throw new Error('provider validation failed'); };

    await expect(guardReviewLaunch({ ...options, beforeClaim })).rejects.toThrow('provider validation failed');

    expect(beforeClaim).not.toHaveBeenCalled();
    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
  });
});

describe('operation-bound original preflight', () => {
  it('refuses capability before a native claim, checkpoint or provider callback', async () => {
    const options = await fixture(), original = retainedOriginal();
    const beforeClaim = vi.fn(async (bound: any) => {
      expect(decodeOriginalLaunch(bound.launchBytes)).toEqual(bound.launch);
      expect(bound.launch.originalNativeClaim).toEqual({ attempt: 1, round: 1 });
      expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
      throw new Error('server_private_recovery_unsupported');
    });
    await expect(guardReviewLaunch({ ...options, originalLaunch: { input: original.input, beforeClaim, nowMs: () => 1500 } } as any))
      .rejects.toThrow('server_private_recovery_unsupported');
    expect(beforeClaim).toHaveBeenCalledTimes(1); expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toBeUndefined();
    await expect(CheckpointJournal.inspectRead(checkpointPath(options.gitCommonDir, target, completion.runId))).rejects.toThrow();
  });

  it('passes the same canonical bytes to owned persistence and snapshots caller input before preflight', async () => {
    const options = await fixture(), original = retainedOriginal();
    let checked = '';
    const beforeClaim = vi.fn(async (bound: any) => {
      checked = bound.launchBytes;
      original.input.expiresAtMs = 9000; original.input.maxPhysicalCalls = 99;
      expect(Object.isFrozen(bound.launch.originalNativeClaim)).toBe(true);
    });
    options.run = async (context, ownership, bound: any) => {
      expect(bound.launchBytes).toBe(checked);
      expect(bound.launch).toEqual(decodeOriginalLaunch(checked));
      expect(bound.launch).toMatchObject({ expiresAtMs: 6000, maxPhysicalCalls: 2,
        originalNativeClaim: { attempt: context.attempt, round: context.round } });
      const journal = await CheckpointJournal.create({ commonDir: options.gitCommonDir, ownership,
        namespace: bound.launch.runId, plan: original.plan });
      await journal.bind('launch', bound.launchBytes, ownership);
      expect((await journal.readBindings()).launch).toBe(checked);
      expect((await journal.read()).records.filter(row => row.type === 'intent')).toHaveLength(0);
      return completion;
    };
    await guardReviewLaunch({ ...options, originalLaunch: { input: original.input, beforeClaim, nowMs: () => 1500 } } as any);
    expect(beforeClaim).toHaveBeenCalledTimes(1);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
    expect((await loadConvergeRunState(options.gitCommonDir, target))!.lastLaunch!.runId).toBe(completion.runId);
  });

  it('supplies native target ownership before the pending claim is persisted', async () => {
    const options = await fixture(), original = retainedOriginal();
    const beforeClaim = vi.fn(async (_bound: any, ownership: NativeTargetOwnership) => {
      expect(ownership.target).toBe(target);
      expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
      expect(await loadConvergeRunState(options.gitCommonDir, target)).toBeUndefined();
    });
    await guardReviewLaunch({ ...options, originalLaunch: { input: original.input, beforeClaim, nowMs: () => 1500 } });
    expect(beforeClaim).toHaveBeenCalledTimes(1);
  });

  it('does not spend when the frozen original deadline expires during awaited preflight', async () => {
    const options = await fixture(), original = retainedOriginal(); let now = 1500;
    const beforeClaim = vi.fn(async () => { now = 6000; });
    await expect(guardReviewLaunch({ ...options, originalLaunch: { input: original.input, beforeClaim, nowMs: () => now } } as any))
      .rejects.toThrow('original_launch_expired');
    expect(beforeClaim).toHaveBeenCalledTimes(1); expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    expect(await loadConvergeRunState(options.gitCommonDir, target)).toBeUndefined();
  });

  it('serializes concurrent original preflights and refuses the second already completed council', async () => {
    const options = await fixture(), original = retainedOriginal();
    const beforeClaim = vi.fn(async () => {});
    const input = { ...options, originalLaunch: { input: original.input, beforeClaim, nowMs: () => 1500 } };
    const results = await Promise.allSettled([guardReviewLaunch(input as any), guardReviewLaunch(input as any)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(beforeClaim).toHaveBeenCalledTimes(1); expect(options.run).toHaveBeenCalledTimes(1);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
  });
});
