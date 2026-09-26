import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { claimConvergeAttempt, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { sampleFinding } from '../telemetry/fixtures.js';

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
  it('validates before claiming and derives the first round without admitting it', async () => {
    const options = await fixture();
    options.validate = vi.fn(async () => {
      expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    });

    await guardReviewLaunch(options);

    expect(options.run).toHaveBeenCalledWith({ target, round: 1, attempt: 1 });
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

    expect(options.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 2 });
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

    expect(options.run).toHaveBeenCalledWith({ target, round: 1, attempt: 2 });
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });

  it('projects legacy ledger claims without mistaking their count for the next round', async () => {
    const options = await fixture();
    await writeFile(join(options.gitCommonDir, `rcl-converge-${target}-ledger.md`), '## Round 7\n');

    await expect(guardReviewLaunch(options)).rejects.toThrow('legacy_dispatch_unknown');
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toBeUndefined();
    await guardReviewLaunch({ ...options, retryReason: 'Legacy launch audited; no native round was admitted.' });

    expect(options.run).toHaveBeenCalledWith({ target, round: 1, attempt: 8 });
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

    expect(options.run).toHaveBeenLastCalledWith({ target, round: 1, attempt: 2 });
  });

  it('allows explicit cap consent without an extra preclaim or reset', async () => {
    const options = await fixture();
    options.run = vi.fn().mockRejectedValue(new Error('lost dispatch'));
    await expect(guardReviewLaunch({ ...options, maxAttempts: 1 })).rejects.toThrow('lost dispatch');
    options.run = vi.fn().mockResolvedValue(completion);
    await expect(guardReviewLaunch({ ...options, retryReason: 'Launcher repaired.' })).rejects.toThrow(/budget exhausted/i);
    await guardReviewLaunch({ ...options, retryReason: 'Launcher repaired.', maxAttempts: 2 });

    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ cap: 2, attemptsUsed: 2 });
    expect(options.run).toHaveBeenCalledWith({ target, round: 1, attempt: 2 });
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
    expect((await loadConvergeRunState(options.gitCommonDir, target))?.findings[report.findings[0]!.identity])
      .toMatchObject({ verdictHeadSha: options.headSha });

    await expect(guardReviewLaunch(options)).rejects.toThrow(/fix|unchanged/i);
    await expect(guardReviewLaunch({ ...options, inputSha256: 'f'.repeat(64) })).rejects.toThrow(/fix.*head|head.*fix/i);
    await guardReviewLaunch({ ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64) });

    expect(options.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 2 });
  });

  it('permits a bounded same-head retry when the review after a real fix is inconclusive', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    const report = await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: completion.runId, reportSha256: completion.reportJsonSha256 });
    await recordVerdicts({ gitCommonDir: options.gitCommonDir, target, round: 1,
      verdicts: [{ key: report.findings[0]!.identity, verdict: 'fixed', reason: 'Fixture fix validated.' }] });

    const fixedHead = { ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64),
      run: vi.fn().mockResolvedValue({ ...completion, runId: '019921a0-0000-7000-8000-000000000002', successfulReviews: 1 }) };
    await guardReviewLaunch(fixedHead);
    await expect(guardReviewLaunch(fixedHead)).rejects.toThrow(/infrastructure.failure|retry.reason/i);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });

    await guardReviewLaunch({ ...fixedHead, retryReason: 'Inconclusive reviewer quorum; provider health checked.' });
    expect(fixedHead.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 3 });
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 3 });
  });

  it('refuses a report head that differs from its first admitted launch', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);

    await expect(processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [], runId: completion.runId, reportSha256: completion.reportJsonSha256,
      headSha: 'd'.repeat(40) })).rejects.toThrow(/report head conflicts with its admitted launch/i);

    expect((await loadConvergeRunState(options.gitCommonDir, target))?.rounds).toEqual([]);
  });

  it('does not admit an inconclusive report as a reviewed round', async () => {
    const options = await fixture();
    options.run = vi.fn().mockResolvedValue({ ...completion, successfulReviews: 1 });
    await guardReviewLaunch(options);

    await expect(processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: completion.runId,
      reportSha256: completion.reportJsonSha256, headSha: options.headSha }))
      .rejects.toThrow(/inconclusive|quorum/i);

    expect((await loadConvergeRunState(options.gitCommonDir, target))?.rounds).toEqual([]);
    await guardReviewLaunch({ ...options, retryReason: 'Provider recovered after inconclusive review.' });
    expect(options.run).toHaveBeenLastCalledWith({ target, round: 1, attempt: 2 });
  });

  it('keeps legacy fixed-round retries on the immediately preceding inconclusive head', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    const report = await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: completion.runId, reportSha256: completion.reportJsonSha256 });
    await recordVerdicts({ gitCommonDir: options.gitCommonDir, target, round: 1,
      verdicts: [{ key: report.findings[0]!.identity, verdict: 'fixed', reason: 'Fixture fix validated.' }] });

    const path = convergeRunStatePath(options.gitCommonDir, target);
    const legacy = JSON.parse(await readFile(path, 'utf8'));
    delete legacy.rounds[0].headSha;
    delete legacy.findings[report.findings[0]!.identity].verdictHeadSha;
    await writeFile(path, JSON.stringify(legacy));

    const fixedHead = { ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64),
      run: vi.fn().mockResolvedValue({ ...completion, runId: '019921a0-0000-7000-8000-000000000002', successfulReviews: 1 }) };
    await guardReviewLaunch(fixedHead);
    await expect(guardReviewLaunch({ ...fixedHead, headSha: 'f'.repeat(40),
      retryReason: 'Additional fix pushed.' })).rejects.toThrow('legacy_fix_head_unverified');
    await guardReviewLaunch({ ...fixedHead, retryReason: 'Provider recovered after inconclusive review.' });

    expect(fixedHead.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 3 });
  });

  it('refuses an old-head retry after the review of a real fix is inconclusive', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    const report = await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: completion.runId, reportSha256: completion.reportJsonSha256 });
    await recordVerdicts({ gitCommonDir: options.gitCommonDir, target, round: 1,
      verdicts: [{ key: report.findings[0]!.identity, verdict: 'fixed', reason: 'Fixture fix validated.' }] });

    const fixedHead = { ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64),
      run: vi.fn().mockResolvedValue({ ...completion, runId: '019921a0-0000-7000-8000-000000000002', successfulReviews: 1 }) };
    await guardReviewLaunch(fixedHead);

    await expect(guardReviewLaunch({ ...fixedHead,
      headSha: options.headSha,
      inputSha256: options.inputSha256,
      retryReason: 'Inconclusive reviewer quorum; provider health checked.'
    })).rejects.toThrow(/same.*head|fixed.*head/i);

    expect(fixedHead.run).toHaveBeenCalledTimes(1);
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 2 });
  });

  it('permits a newer head after the review of a real fix is inconclusive', async () => {
    const options = await fixture();
    await guardReviewLaunch(options);
    const report = await processRoundReport({ gitCommonDir: options.gitCommonDir, target, round: 1,
      findings: [sampleFinding()], runId: completion.runId, reportSha256: completion.reportJsonSha256 });
    await recordVerdicts({ gitCommonDir: options.gitCommonDir, target, round: 1,
      verdicts: [{ key: report.findings[0]!.identity, verdict: 'fixed', reason: 'Fixture fix validated.' }] });

    const fixedHead = { ...options, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64),
      run: vi.fn().mockResolvedValue({ ...completion, runId: '019921a0-0000-7000-8000-000000000002', successfulReviews: 1 }) };
    await guardReviewLaunch(fixedHead);

    await guardReviewLaunch({ ...fixedHead,
      headSha: 'f'.repeat(40),
      inputSha256: 'a'.repeat(64),
      retryReason: 'Additional fix pushed after the inconclusive review.'
    });

    expect(fixedHead.run).toHaveBeenLastCalledWith({ target, round: 2, attempt: 3 });
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

  it('cannot use an explicit retry decision to raise or reset the existing cap', async () => {
    const options = await fixture();
    await claimConvergeAttempt({ gitCommonDir: options.gitCommonDir, target, maxAttempts: 1 });

    await expect(guardReviewLaunch({ ...options, retryReason: 'Fixture recovery.' })).rejects.toThrow(/budget exhausted/i);

    expect(options.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ cap: 1, attemptsUsed: 1 });
  });
});
