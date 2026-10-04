import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { effectivePendingIdentities } from '../../src/converge/recovery-state.js';
import { loadConvergeRunState, processRoundReport } from '../../src/converge/run-state.js';
import type { ConvergeContext } from '../../src/report/run-header.js';
import { installRecoveredProduction } from '../fixtures/recovered-production.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { installTriagedRecoveredProduction } from '../fixtures/guarded-recovered-production.js';

const directories: string[] = [];
type RecoveredLaunchOptions = GuardedLaunchOptions & {
  recoverySource?: NonNullable<ConvergeContext['recovery_source']>;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'rcl-recovered-launch-')));
  directories.push(path);
  return path;
}

function options(f: { gitCommonDir: string; target: string; before: string }): RecoveredLaunchOptions {
  return {
    gitCommonDir: f.gitCommonDir, target: f.target, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
    recoverySource: { version: 1, native_sha256: sha(f.before) },
    validate: vi.fn(async () => {}),
    run: vi.fn(async () => ({ runId: uuid(900), reportJsonSha256: 'c'.repeat(64),
      successfulReviews: 2, totalReviews: 2, deliveryPending: false })),
  };
}

describe('guarded recovered-v3 review launch', () => {
  it('refuses recovered-v3 admission without an exact completed guarded launch', async () => {
    const gitCommonDir = await directory();
    const f = await installRecoveredProduction(gitCommonDir);
    const before = await readFile(f.path, 'utf8');
    const runId = uuid(899);
    const reportJson = JSON.stringify({ run: { id: runId, converge: {
      target: f.plan.target, round: 2, recovery_source: { version: 1, native_sha256: sha(before) },
    }, gating: { bound_classification_protocol: 1 } }, findings: [] });

    await expect(processRoundReport({ gitCommonDir, target: f.plan.target, round: 2,
      runId, findings: [], reportSha256: sha(reportJson), evidence: { reportJson } }))
      .rejects.toThrow('recovery_launch_required');

    expect(await readFile(f.path, 'utf8')).toBe(before);
    expect(await loadConvergeAttemptState(gitCommonDir, f.plan.target)).toBeUndefined();
  });

  it('refuses an unresolved earlier recovered obligation before spending', async () => {
    const gitCommonDir = await directory();
    const recovered = await installRecoveredProduction(gitCommonDir);
    const before = await readFile(recovered.path, 'utf8');
    const state = (await loadConvergeRunState(gitCommonDir, recovered.plan.target))!;
    expect(effectivePendingIdentities(state)).toContain(recovered.selection.identity);
    const input = options({ gitCommonDir, target: recovered.plan.target, before });

    await expect(guardReviewLaunch(input)).rejects.toThrow(/triage|pending|gating/i);

    expect(input.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(gitCommonDir, input.target)).toBeUndefined();
    expect(await readFile(recovered.path, 'utf8')).toBe(before);
  });

  it('keeps exact native predecessor bytes through dispatch and binds the report for admission', async () => {
    const f = await installTriagedRecoveredProduction(await directory());
    let reportJson = '';
    let context: ConvergeContext | undefined;
    let nativeDuringDispatch = '';
    const input = options(f);
    input.run = vi.fn(async converge => {
      context = converge;
      nativeDuringDispatch = await readFile(f.path, 'utf8');
      reportJson = JSON.stringify({ run: { id: uuid(900), converge,
        gating: { bound_classification_protocol: 1 } }, findings: [] });
      return { runId: uuid(900), reportJsonSha256: sha(reportJson), successfulReviews: 2, totalReviews: 2, deliveryPending: false };
    });

    await guardReviewLaunch({ ...input, maxAttempts: 3 });

    expect.soft(nativeDuringDispatch).toBe(f.before);
    expect.soft(await readFile(f.path, 'utf8')).toBe(f.before);
    expect.soft(context).toEqual({ target: f.target, round: 3, attempt: 2, recovery_source: input.recoverySource });
    expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toMatchObject({
      cap: 3, attemptsUsed: 2, migratedAttempts: 0, attempts: [{ attempt: 1, source: 'claim' }, { attempt: 2, source: 'claim' }],
      lastLaunch: { status: 'completed', attempt: 2, round: 3, runId: uuid(900), reportJsonSha256: sha(reportJson) },
    });
    await expect(guardReviewLaunch(input)).rejects.toThrow(/admit|existing report/i);
    expect(input.run).toHaveBeenCalledTimes(1);
    const admitted = await processRoundReport({ gitCommonDir: f.gitCommonDir, target: f.target, round: 3,
      runId: uuid(900), findings: [], reportSha256: sha(reportJson), evidence: { reportJson } });
    expect(admitted.counts).toEqual({ new: 0, repeat: 0, suppressed: 0, regating: 0 });
    const after = (await loadConvergeRunState(f.gitCommonDir, f.target))!;
    expect(after.rounds.at(-1)?.reportBinding?.reportSha256).toBe(sha(reportJson));
    expect(after.recovery).toEqual(JSON.parse(f.before).recovery);
  });

  it.each(['missing', 'stale'] as const)('refuses a %s selected predecessor before claiming', async kind => {
    const f = await installTriagedRecoveredProduction(await directory());
    const attemptsBefore = await loadConvergeAttemptState(f.gitCommonDir, f.target);
    const input = options(f);
    if (kind === 'missing') delete input.recoverySource;
    else input.recoverySource = { version: 1, native_sha256: 'f'.repeat(64) };

    await expect(guardReviewLaunch(input)).rejects.toThrow(/predecessor|recovery.*source|native.*chang/i);

    expect(input.run).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toEqual(attemptsBefore);
    expect(await readFile(f.path, 'utf8')).toBe(f.before);
  });

  it('keeps a failed dispatch spent without rewriting native recovery bytes', async () => {
    const f = await installTriagedRecoveredProduction(await directory());
    const input = options(f);
    input.run = vi.fn(async () => { throw new Error('Synthetic council completion failure.'); });

    await expect(guardReviewLaunch({ ...input, maxAttempts: 2 })).rejects.toThrow('Synthetic council completion failure.');

    expect.soft(await readFile(f.path, 'utf8')).toBe(f.before);
    expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toMatchObject({
      cap: 2, attemptsUsed: 2, migratedAttempts: 0, attempts: [{ attempt: 1, source: 'claim' }, { attempt: 2, source: 'claim' }],
      lastLaunch: { status: 'failed', attempt: 2, round: 3 },
    });
    await expect(guardReviewLaunch(input)).rejects.toThrow(/unknown|retry.*reason/i);
    expect(input.run).toHaveBeenCalledTimes(1);
    expect(await loadConvergeAttemptState(f.gitCommonDir, f.target)).toMatchObject({ cap: 2, attemptsUsed: 2 });
  });
});
