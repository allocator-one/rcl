import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { convergeRunStatePath, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';
import { configDigest, sha256Hex, type RosterEntry } from '../../src/report/run-header.js';
import { sampleFinding, sampleResult, sampleReview } from '../telemetry/fixtures.js';

/**
 * RCL-202: a 4.5.17 guarded launch records its own blocking health, so an
 * inconclusive round retries with --retry-reason alone. --retry-report proves
 * health only for 4.1.10–4.1.12 aggregate-only launches.
 */
async function currentProducerFixture() {
  const common = await realpath(await mkdtemp(join(tmpdir(), 'rcl-current-health-')));
  onTestFinished(() => rm(common, { recursive: true, force: true }));
  const target = 'current-health';
  const prior = await processRoundReport({ gitCommonDir: common, target, round: 1, findings: [sampleFinding()], maxRounds: 3 });
  await recordVerdicts({ gitCommonDir: common, target, round: 1,
    verdicts: [{ key: prior.findings[0]!.identity, verdict: 'fixed', reason: 'Original fix verified.' }] });
  const config = { models: ['openai/fixture'], quorumFraction: 2 / 3 };
  const roster: RosterEntry[] = Array.from({ length: 10 }, (_, i) =>
    ({ model: 'openai/fixture', role: `role-${i}`, provider: 'openai', lane: 'blocking' }));
  const report = sampleResult({ reviews: roster.map((seat, index) => sampleReview({ ...seat,
    status: index < 5 ? 'success' : 'error' })), findings: [] });
  report.run!.rcl_version = '4.5.17'; report.run!.roster = roster;
  report.run!.config_sha256 = configDigest(config);
  report.run!.converge = { target, round: 2, attempt: 1 };
  report.run!.target.head_sha = 'a'.repeat(40);
  report.stats.totalReviews = 10; report.stats.successfulReviews = 5;
  const reportPath = join(common, 'report.json');
  const text = JSON.stringify(report);
  await writeFile(reportPath, text);
  const run = vi.fn().mockResolvedValue({ runId: report.run!.id, reportJsonSha256: sha256Hex(text),
    successfulReviews: 5, totalReviews: 10, deliveryPending: false, hardFailure: true,
    reviewerHealth: { version: 1, policy: resolveQuorumPolicy(10, 2 / 3), successfulSeats: 5 } });
  const options: GuardedLaunchOptions = { gitCommonDir: common, target, headSha: 'a'.repeat(40),
    inputSha256: 'b'.repeat(64), maxAttempts: 20, maxRounds: 3, run, validate: vi.fn(async () => {}) };
  await guardReviewLaunch(options);
  run.mockClear();
  const retryReason = 'Blocking health 5/10, required 7: provider connection errors inspected; bounded retry.';
  const bytes = () => Promise.all([convergeRunStatePath(common, target), convergeAttemptStatePath(common, target)]
    .map(path => readFile(path)));
  return { common, target, config, roster, reportPath, options, retryReason, run, bytes };
}

describe('retrying an inconclusive launch that recorded its own blocking health', () => {
  it('refuses --retry-report before claim and names the supported retry', async () => {
    const f = await currentProducerFixture();
    const before = await f.bytes();

    const refusal = guardReviewLaunch({ ...f.options, retryReason: f.retryReason,
      legacyRetry: { reportPath: f.reportPath, config: f.config, roster: f.roster } });

    await expect(refusal).rejects.toThrow(/^retry_report_current_health: .*5\/10 blocking seats, 7 required.*--retry-reason alone/);
    expect(f.run).not.toHaveBeenCalled();
    expect(await f.bytes()).toEqual(before);
  });

  it('admits the bounded retry with --retry-reason alone exactly once at the same round', async () => {
    const f = await currentProducerFixture();

    await guardReviewLaunch({ ...f.options, retryReason: f.retryReason });

    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run.mock.calls[0]![0]).toMatchObject({ target: f.target, attempt: 2, round: 2 });
    const attempts = await loadConvergeAttemptState(f.common, f.target);
    expect(attempts?.attemptsUsed).toBe(2);
    expect(attempts?.attempts[1]?.retrySource).toBeUndefined();
  });
});
