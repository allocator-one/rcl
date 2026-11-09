import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';
import { sampleFinding } from '../telemetry/fixtures.js';

// RCL-205: one blocking seat returned parse_failed in a 7/10 conclusive round
// that converge-report admitted; the next head was refused as an infrastructure failure.
const directories: string[] = [];
const target = 'fixture-seat-failure';
const conclusive = {
  runId: '019921a0-0000-7000-8000-000000000001',
  reportJsonSha256: 'c'.repeat(64),
  successfulReviews: 7,
  totalReviews: 10,
  deliveryPending: false,
  hardFailure: true,
  reviewerHealth: { version: 1 as const, policy: resolveQuorumPolicy(10), successfulSeats: 7 },
};

async function fixture(): Promise<GuardedLaunchOptions> {
  const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-seat-failure-'));
  directories.push(gitCommonDir);
  return {
    gitCommonDir, target, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
    validate: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(conclusive),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('a seat failure inside a conclusive admitted round', () => {
  it('needs admission first, then lets a changed head continue without a retry reason', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    const next = { ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64) };

    await expect(guardReviewLaunch(next)).rejects.toThrow('report_not_admitted');
    const report = await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: conclusive.runId, reportSha256: conclusive.reportJsonSha256 });
    await recordVerdicts({ gitCommonDir: options.gitCommonDir, target, round: 1,
      verdicts: [{ key: report.findings[0]!.identity, verdict: 'fixed', reason: 'Fixture fix validated.' }] });

    await guardReviewLaunch(next);
    expect(options.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 2 }, expect.objectContaining({ target }));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });

  it('still refuses to re-review the admitted inputs', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [], runId: conclusive.runId, reportSha256: conclusive.reportJsonSha256 });

    await expect(guardReviewLaunch(options)).rejects.toThrow('inputs_unchanged');
    expect(options.run).toHaveBeenCalledTimes(1);
  });

  it('still requires a retry reason when the failed seats left the round inconclusive', async () => {
    const options = await fixture();
    options.run = vi.fn().mockResolvedValue({ ...conclusive, successfulReviews: 6,
      reviewerHealth: { ...conclusive.reviewerHealth, successfulSeats: 6 } });
    await guardReviewLaunch(options);

    await expect(guardReviewLaunch({ ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64) }))
      .rejects.toThrow('infrastructure_failure');
    expect(options.run).toHaveBeenCalledTimes(1);
  });
});
