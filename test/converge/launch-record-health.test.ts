import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
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


describe('retained launch health schema compatibility', () => {
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

});
