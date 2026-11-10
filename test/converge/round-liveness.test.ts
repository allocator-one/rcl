import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { guardReviewLaunch, ReviewCouncilInterrupted, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { inspectRoundLiveness, waitForRoundOutcome } from '../../src/converge/round-liveness.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const target = 'fixture-liveness';
const headSha = 'a'.repeat(40);
const completion = { runId: '019921a0-0000-7000-8000-0000000000aa', reportJsonSha256: 'c'.repeat(64),
  successfulReviews: 3, totalReviews: 3, deliveryPending: false, reportPath: '/tmp/rcl-report-fixture.json' };

async function launchOptions(gitCommonDir?: string): Promise<GuardedLaunchOptions> {
  const commonDir = gitCommonDir ?? await realpath(await mkdtemp(join(tmpdir(), 'rcl-liveness-')));
  if (!gitCommonDir) directories.push(commonDir);
  return { gitCommonDir: commonDir, target, headSha, inputSha256: 'b'.repeat(64),
    validate: vi.fn(async () => {}),
    beforeClaim: vi.fn(async () => ({ ordinaryInputs: { version: 1 as const, packetSha256: 'd'.repeat(64), baseSha: null } })),
    ordinaryCheckpoint: { exists: vi.fn(async () => true) },
    run: vi.fn(async () => { throw new ReviewCouncilInterrupted(5, 10); }) };
}

/** The launching process is gone: a killed council, or a forked worker's background task ended with its fork. */
async function exitOwner(gitCommonDir: string): Promise<void> {
  const nativePath = convergeRunStatePath(gitCommonDir, target), state = JSON.parse(await readFile(nativePath, 'utf8'));
  const ledgerPath = convergeAttemptStatePath(gitCommonDir, target), ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  for (const owner of [state.lastLaunch, ledger.attempts.at(-1)]) {
    owner.pid = 99_999_999;
    if (owner.processIdentity) owner.processIdentity.pid = 99_999_999;
  }
  await writeFile(nativePath, JSON.stringify(state)); await writeFile(ledgerPath, JSON.stringify(ledger));
}

/** A launch whose council stopped and whose process then exited, leaving only a pending record. */
async function abandonedLaunch(gitCommonDir?: string): Promise<GuardedLaunchOptions> {
  const options = await launchOptions(gitCommonDir);
  await expect(guardReviewLaunch(options)).rejects.toBeInstanceOf(ReviewCouncilInterrupted);
  await exitOwner(options.gitCommonDir);
  return options;
}

/** Start a guarded launch whose council runs until `finish` is called. */
function runningLaunch(options: GuardedLaunchOptions) {
  let finish!: (outcome: 'complete' | 'interrupt') => void;
  const gate = new Promise<'complete' | 'interrupt'>(resolve => { finish = resolve; });
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const launch = guardReviewLaunch({ ...options, run: vi.fn(async () => {
    started();
    if (await gate === 'interrupt') throw new ReviewCouncilInterrupted(5, 10);
    return completion;
  }) });
  return { launch, running, finish };
}

describe('converge round liveness (RCL-232)', () => {
  it('keeps an accepted slug launch visible ahead of an old completed reference alias', async () => {
    const options = await launchOptions();
    const reference = 'owner/rcl#42', slug = 'rcl-42';
    await guardReviewLaunch({ ...options, target: reference, run: async () => completion });
    await withNativeTarget(options.gitCommonDir, slug, async () => {
      expect(await inspectRoundLiveness({ gitCommonDir: options.gitCommonDir,
        target: reference, headSha, lockTimeoutMs: 1000 }))
        .toMatchObject({ target: slug, requestedTarget: reference, status: 'launching', action: 'wait' });
    });
  });

  it('keeps waiting during accepted preflight before the first round registers', async () => {
    const options = await launchOptions();
    await withNativeTarget(options.gitCommonDir, target, async () => {
      let time = 0;
      const sleep = vi.fn(async (ms: number) => { time += ms; });
      const status = await waitForRoundOutcome({ gitCommonDir: options.gitCommonDir, target, headSha,
        lockTimeoutMs: 50, timeoutMs: 100, intervalMs: 100, sleep, now: () => time });
      expect(status).toMatchObject({ status: 'launching', action: 'wait' });
      expect(status.launch).toBeUndefined();
      expect(sleep).toHaveBeenCalledTimes(1);
    });
    expect(await inspectRoundLiveness({ gitCommonDir: options.gitCommonDir, target, headSha }))
      .toMatchObject({ status: 'not_launched', action: 'launch' });
  });

  it('reports a pending round whose process exited as dead, so the caller stops waiting', async () => {
    const options = await abandonedLaunch();

    const status = await inspectRoundLiveness({ gitCommonDir: options.gitCommonDir, target, headSha });

    expect(status).toMatchObject({ status: 'dead', action: 'resume', launch: { attempt: 1, round: 1, headSha } });
  });

  it('reports a launch that holds the target as running, then its completed report as awaiting admission', async () => {
    // A resumed council keeps the exited original claimant on record; only the target lock shows it is alive.
    const options = await abandonedLaunch();
    const { launch, running, finish } = runningLaunch(options);
    await running;

    expect(await inspectRoundLiveness({ gitCommonDir: options.gitCommonDir, target, headSha, lockTimeoutMs: 200 }))
      .toMatchObject({ status: 'running', action: 'wait' });

    finish('complete');
    await launch;
    expect(await inspectRoundLiveness({ gitCommonDir: options.gitCommonDir, target, headSha })).toMatchObject({
      status: 'completed', action: 'process_report', admitted: false,
      launch: { runId: completion.runId, reportPath: completion.reportPath } });
  });

  it('reports a head that no launch reached as not launched', async () => {
    const options = await abandonedLaunch();

    expect(await inspectRoundLiveness({ gitCommonDir: options.gitCommonDir, target, headSha: 'e'.repeat(40) }))
      .toMatchObject({ status: 'not_launched', action: 'launch' });
  });

  it('describes the registered running round when another head is requested', async () => {
    const options = await launchOptions();
    const { launch, running, finish } = runningLaunch(options);
    await running;
    try {
      expect(await inspectRoundLiveness({ gitCommonDir: options.gitCommonDir, target,
        headSha: 'e'.repeat(40), lockTimeoutMs: 500 }))
        .toMatchObject({ status: 'running', action: 'wait', launch: { attempt: 1, round: 1, headSha } });
    } finally {
      finish('complete');
      await launch;
    }
  });

  it('stops waiting as soon as a running round dies', async () => {
    const options = await launchOptions();
    const { launch, running, finish } = runningLaunch(options);
    await running;
    const sleep = vi.fn(async () => {
      finish('interrupt');
      await expect(launch).rejects.toBeInstanceOf(ReviewCouncilInterrupted);
      await exitOwner(options.gitCommonDir);
    });

    const status = await waitForRoundOutcome({ gitCommonDir: options.gitCommonDir, target, headSha, lockTimeoutMs: 200,
      timeoutMs: 60_000, intervalMs: 1, sleep });

    expect(status).toMatchObject({ status: 'dead', action: 'resume' });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('exits 6 from converge-status for a dead round', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'rcl-liveness-cli-')); directories.push(repo);
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const env = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };
    execFileSync('git', ['init', '-q'], { cwd: repo, env });
    await abandonedLaunch(await realpath(join(repo, '.git')));

    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'),
      fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
      'converge-status', '--target', target, '--head', headSha, '--json'], {
      cwd: repo, encoding: 'utf8', timeout: 20_000,
      env: { ...env, NODE_NO_WARNINGS: '1', RCL_DATA_DIR: join(repo, 'private-data'),
        XDG_CONFIG_HOME: join(repo, 'private-config'), HARNESS_API_TOKEN: '', HARNESS_API_URL: '' } });

    expect(result.status).toBe(6);
    expect(JSON.parse(result.stdout)).toMatchObject({ target, status: 'dead', action: 'resume' });
  });
});
