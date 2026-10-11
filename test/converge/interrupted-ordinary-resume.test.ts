import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { assertNoPendingFreshReview } from '../../src/converge/fresh-review.js';
import { guardReviewLaunch, ordinaryCheckpointNamespace, ReviewCouncilInterrupted,
  type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import type { ReviewCycleReceipt } from '../../src/converge/review-cycle.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const target = 'fixture-interrupted';
const packetSha256 = 'd'.repeat(64);
const completion = { runId: '019921a0-0000-7000-8000-0000000000aa', reportJsonSha256: 'c'.repeat(64),
  successfulReviews: 3, totalReviews: 3, deliveryPending: false };

async function fixture(): Promise<GuardedLaunchOptions & { exists: ReturnType<typeof vi.fn> }> {
  const gitCommonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-interrupted-'))); directories.push(gitCommonDir);
  const exists = vi.fn(async () => true);
  return { gitCommonDir, target, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64), exists,
    validate: vi.fn(async () => {}),
    beforeClaim: vi.fn(async () => ({ ordinaryInputs: { version: 1 as const, packetSha256, baseSha: null } })),
    ordinaryCheckpoint: { exists },
    run: vi.fn(async () => { throw new ReviewCouncilInterrupted(5, 10); }) };
}

/** Model the interrupted coordinator having exited, without touching any real process. */
async function exitOwner(options: GuardedLaunchOptions): Promise<void> {
  const path = convergeRunStatePath(options.gitCommonDir, target), state = JSON.parse(await readFile(path, 'utf8'));
  state.lastLaunch.pid = 99_999_999;
  if (state.lastLaunch.processIdentity) state.lastLaunch.processIdentity.pid = 99_999_999;
  await writeFile(path, JSON.stringify(state));
}

describe('interrupted journaled council (RCL-80)', () => {
  it('keeps the interrupted launch pending and resumes it under the same attempt and round', async () => {
    const options = await fixture();
    await expect(guardReviewLaunch(options)).rejects.toBeInstanceOf(ReviewCouncilInterrupted);
    expect(options.run).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, round: 1 }), expect.anything(), undefined,
      { namespace: ordinaryCheckpointNamespace(packetSha256), resumed: false });
    expect((await loadConvergeRunState(options.gitCommonDir, target))!.lastLaunch).toMatchObject({ status: 'pending', attempt: 1 });
    await exitOwner(options);

    const run = vi.fn(async () => completion);
    const claim = await guardReviewLaunch({ ...options, run });
    expect(claim).toMatchObject({ attempt: 1, attemptsUsed: 1, resumedInterrupted: true });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, round: 1 }), expect.anything(), undefined,
      { namespace: ordinaryCheckpointNamespace(packetSha256), resumed: true });
    expect(options.exists).toHaveBeenCalledWith(ordinaryCheckpointNamespace(packetSha256));
    expect(await loadConvergeAttemptState(options.gitCommonDir, target)).toMatchObject({ attemptsUsed: 1 });
    expect((await loadConvergeRunState(options.gitCommonDir, target))!.lastLaunch)
      .toMatchObject({ status: 'completed', attempt: 1, round: 1, pid: process.pid, runId: completion.runId });
  });

  it.each([
    ['the original process may still own it', async (_options: GuardedLaunchOptions) => {}, {}],
    ['the inputs changed', exitOwner, { inputSha256: 'e'.repeat(64) }],
    ['no matching journal exists', exitOwner, { ordinaryCheckpoint: { exists: async () => false } }],
  ] as const)('keeps the unknown-dispatch refusal when %s', async (_label, prepare, overrides) => {
    const options = await fixture();
    await expect(guardReviewLaunch(options)).rejects.toBeInstanceOf(ReviewCouncilInterrupted);
    await prepare(options);
    const before = await readFile(convergeAttemptStatePath(options.gitCommonDir, target));
    const run = vi.fn(async () => completion);
    await expect(guardReviewLaunch({ ...options, ...overrides, run })).rejects.toThrow('dispatch_unknown');
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(convergeAttemptStatePath(options.gitCommonDir, target))).toEqual(before);
  });

  it('marks a council that failed for another reason as failed, never resumable', async () => {
    const options = await fixture();
    await expect(guardReviewLaunch({ ...options, run: vi.fn(async () => { throw new Error('provider setup failed'); }) }))
      .rejects.toThrow('provider setup failed');
    expect((await loadConvergeRunState(options.gitCommonDir, target))!.lastLaunch).toMatchObject({ status: 'failed' });
    await exitOwner(options);
    await expect(guardReviewLaunch({ ...options, run: vi.fn(async () => completion) })).rejects.toThrow('dispatch_unknown');
  });

  it('resumes an interrupted fresh review through the same --start-over request without another cycle', async () => {
    const options = await fixture();
    let active: ReviewCycleReceipt | null = null;
    const cycleRemote = { repo: 'allocator-one/rcl', prNumber: 80, url: 'https://harness.example', current: vi.fn(async () => active),
      start: vi.fn(async (request: Omit<ReviewCycleReceipt, 'id' | 'inserted_at'>) => {
        active = { ...request, id: randomUUID(), inserted_at: new Date().toISOString() } as ReviewCycleReceipt; return active; }) };
    const fresh = { ...options, startOver: true, cycleRemote };
    await expect(guardReviewLaunch(fresh)).rejects.toBeInstanceOf(ReviewCouncilInterrupted);
    await expect(assertNoPendingFreshReview(options.gitCommonDir, target)).rejects.toThrow('fresh_review_pending');
    await exitOwner(options);

    const run = vi.fn(async () => completion);
    const claim = await guardReviewLaunch({ ...fresh, run });
    expect(claim).toMatchObject({ attempt: 1, resumedInterrupted: true });
    expect(cycleRemote.start).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined, expect.objectContaining({ resumed: true }));
    await expect(assertNoPendingFreshReview(options.gitCommonDir, target)).resolves.toBeUndefined();
  });
});
