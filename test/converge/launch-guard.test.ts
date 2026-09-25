import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { claimConvergeAttempt, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import { assertNativeTargetOwnership, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';

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
    options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 1, hardFailure: true });
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
    await guardReviewLaunch({ ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64) });

    expect(options.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 2 }, expect.objectContaining({ target }));
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

  it('cannot use an explicit retry decision to raise or reset the existing cap', async () => {
    const options = await fixture();
    await claimConvergeAttempt({ gitCommonDir: options.gitCommonDir, target, maxAttempts: 1 });

    await expect(guardReviewLaunch({ ...options, retryReason: 'Fixture recovery.' })).rejects.toThrow(/budget exhausted/i);

    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ cap: 1, attemptsUsed: 1 });
  });
});
