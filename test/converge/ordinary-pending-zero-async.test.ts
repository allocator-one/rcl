import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claimConvergeAttempt, convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { exportOrdinaryPendingPackage } from '../../src/converge/ordinary-pending-export.js';
import type { OrdinaryPendingPackage } from '../../src/converge/ordinary-pending-package.js';
import { finalizeOrdinaryPendingLaunch, previewOrdinaryPendingLaunch,
  resumePendingLegacyLaunch } from '../../src/converge/pending-legacy-resume.js';
import { capturePreparedCouncil } from '../../src/dispatch/capture-council.js';
import { chunkDiff } from '../../src/prepare/chunker.js';
import { guardedInputSha256 } from '../../src/report/run-header.js';

const blockingRoster = [
  { model: 'openai/test', role: 'bug-hunter', provider: 'openai', lane: 'blocking' },
  { model: 'openai/test', role: 'security-auditor', provider: 'openai', lane: 'blocking' },
  { model: 'openai/verify', role: 'verification', provider: 'openai', lane: 'verification' },
];

// A legacy ordinary launch whose owner died while its blocking council ran.
async function pendingLaunch(guardedOverrides: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-zero-async-pending-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const gitCommonDir = join(root, 'native');
  const asyncStoreDir = join(root, 'async');
  await mkdir(gitCommonDir);
  await mkdir(asyncStoreDir);
  const target = 'owner-repo-11650', headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
  const guardedInput = { head: headSha, kind: 'pr', repo: 'owner/repo', pr: 11650,
    diff: 'c'.repeat(64), config: 'd'.repeat(64), roster: blockingRoster, prompts: [], asyncRoles: [],
    ...guardedOverrides };
  const inputSha256 = guardedInputSha256(guardedInput);
  await claimConvergeAttempt({ gitCommonDir, target, maxAttempts: 2, recordPid: 999_999 });
  const nativePath = convergeRunStatePath(gitCommonDir, target);
  await mkdir(dirname(nativePath), { recursive: true, mode: 0o700 });
  await writeFile(nativePath, JSON.stringify({ version: 1, target, roundCap: 15, rounds: [], findings: {},
    updatedAt: '2026-10-11T00:00:00.000Z', lastLaunch: { status: 'pending', attempt: 1, round: 1, headSha,
      inputSha256, startedAt: '2026-10-11T00:00:00.000Z', pid: 999_999 } }));
  const exportPackage = (preview: boolean, { withoutStore = false } = {}) =>
    exportOrdinaryPendingPackage({ gitCommonDir, target, headSha, baseSha, expectedBaseSha: baseSha,
      guardedInput, asyncStoreDir: withoutStore ? undefined : asyncStoreDir, asyncTargetKey: 'zero-async',
      asyncDescriptors: [], path: join(root, 'pending.json'), preview });
  return { root, gitCommonDir, asyncStoreDir, target, headSha, baseSha, inputSha256, nativePath,
    attemptsPath: convergeAttemptStatePath(gitCommonDir, target), exportPackage };
}

type PendingLaunch = Awaited<ReturnType<typeof pendingLaunch>>;

async function exported(fixture: PendingLaunch): Promise<OrdinaryPendingPackage> {
  const preview = await fixture.exportPackage(true);
  expect(preview).toMatchObject({ mode: 'pending-package-preview', retainedAsyncSha256: [],
    attempt: 1, round: 1, pid: 999_999, attemptsUsed: 1, blockingOutcome: 'unknown' });
  expect(await readdir(fixture.root)).not.toContain('pending.json');
  const receipt = await fixture.exportPackage(false);
  expect(receipt).toMatchObject({ mode: 'pending-package-export', packageSha256: preview.packageSha256 });
  return JSON.parse(await readFile(join(fixture.root, 'pending.json'), 'utf8')) as OrdinaryPendingPackage;
}

function recoveryOptions(fixture: PendingLaunch, migrationPackage: OrdinaryPendingPackage) {
  const role = { name: 'bug-hunter', description: 'review', focus: ['correctness'], isSpecialized: false,
    systemPrompt: 'review carefully' };
  const assignments = [{ model: 'openai/test', provider: 'openai' as const, role },
    { model: 'openai/test', provider: 'openai' as const, role: { ...role, name: 'security-auditor' } }];
  const diff = { files: [{ filename: 'a.ts', status: 'modified' as const,
    patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 }] };
  const chunks = chunkDiff(diff.files);
  const captured = capturePreparedCouncil({ target: fixture.target, headSha: fixture.headSha,
    mergeBaseSha: fixture.baseSha, diff, assignments, lanes: ['blocking', 'blocking'], chunks,
    prompts: chunks.flatMap(() => assignments.map(assignment => ({
      systemPrompt: assignment.role.systemPrompt, userPrompt: 'patch' }))),
    config: { models: ['openai/test'] }, specBytes: 'spec', contextDocs: [],
    compatibility: { parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } } });
  return { gitCommonDir: fixture.gitCommonDir, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256, recoveryInputSha256: fixture.inputSha256,
    retryReason: 'Retry after the zero-async owner died.', captured, retainedAsyncSha256: [] as string[],
    migrationPackage, maxAttempts: 2, maxPhysicalCalls: 2, maxAttemptsPerCell: 1, maxDurationMs: 1_000,
    validate: vi.fn(async () => {}), ownerAlive: () => false, loadRetainedAsync: vi.fn(async () => []),
    run: vi.fn(async ({ launch }: any) => ({ runId: launch.runId, reportJsonSha256: '1'.repeat(64),
      successfulReviews: 2, totalReviews: 2, deliveryPending: false })) };
}

describe('zero-async ordinary pending recovery', () => {
  it('exports, previews and finalizes a dead owner without async seats as unknown', async () => {
    const fixture = await pendingLaunch();
    const migrationPackage = await exported(fixture);
    expect(migrationPackage).toMatchObject({ retainedAsyncSha256: [], retainedAsync: [], attempt: 1, pid: 999_999 });
    const options = recoveryOptions(fixture, migrationPackage);
    const nativeBefore = await readFile(fixture.nativePath);
    const attemptsBefore = await readFile(fixture.attemptsPath);

    const preview = await previewOrdinaryPendingLaunch({ ...options, previewMode: 'finalize-only' });
    expect(preview).toMatchObject({ attemptsUsed: 1, cap: 2, nextAttempt: 2,
      source: { pendingAttempt: 1, round: 1, originalPid: 999_999, blockingOutcome: 'unknown' } });
    expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);

    const finalizeOptions = { gitCommonDir: fixture.gitCommonDir, target: fixture.target,
      headSha: fixture.headSha, baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: [] as string[], maxAttempts: 2, migrationPackage,
      ownerAlive: options.ownerAlive, loadRetainedAsync: options.loadRetainedAsync };
    const first = await finalizeOrdinaryPendingLaunch(finalizeOptions);
    expect(first).toMatchObject({ reusedReceipt: false, receipt: { version: 1,
      operation: 'ordinary-pending-finalize-only', finalizedAttempt: 1, attemptsUsed: 1, cap: 2,
      nextFreeAttempt: 2, blockingOutcome: 'unknown', retainedAsyncSha256: [] } });
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    expect((await loadConvergeRunState(fixture.gitCommonDir, fixture.target))?.lastLaunch)
      .toMatchObject({ status: 'failed', attempt: 1, pendingRecovery: { pendingAttempt: 1, blockingOutcome: 'unknown' } });
    expect(options.run).not.toHaveBeenCalled();
    await expect(finalizeOrdinaryPendingLaunch(finalizeOptions))
      .resolves.toEqual({ receipt: first.receipt, reusedReceipt: true, snapshotBindingUpgraded: false });
  });

  it('retries a dead owner without async seats in exactly one fresh attempt', async () => {
    const fixture = await pendingLaunch();
    const options = recoveryOptions(fixture, await exported(fixture));

    const result = await resumePendingLegacyLaunch(options);

    expect(result.claim).toMatchObject({ attempt: 2, attemptsUsed: 2 });
    expect(options.run).toHaveBeenCalledTimes(1);
    expect((await loadConvergeAttemptState(fixture.gitCommonDir, fixture.target))?.attempts[1]?.pendingRecoverySource)
      .toMatchObject({ pendingAttempt: 1, retainedAsyncSha256: [],
        migrationPackageSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await loadConvergeRunState(fixture.gitCommonDir, fixture.target))?.lastLaunch)
      .toMatchObject({ status: 'completed', attempt: 2, pendingRecovery: { blockingOutcome: 'unknown' } });
  });

  it('exports the same package from a checkout that never created an async store', async () => {
    const fixture = await pendingLaunch();
    const withStore = await fixture.exportPackage(true);

    await rm(fixture.asyncStoreDir, { recursive: true });

    await expect(fixture.exportPackage(true, { withoutStore: true })).resolves.toMatchObject({
      packageSha256: withStore.packageSha256, retainedAsyncSha256: [] });
  });

  it('refuses to export a launch whose async seats left no retained results', async () => {
    const fixture = await pendingLaunch({ asyncRoles: [{ name: 'general' }], roster: [...blockingRoster,
      { model: 'openai/async', role: 'general', provider: 'openai', lane: 'async' }] });
    const nativeBefore = await readFile(fixture.nativePath);
    const attemptsBefore = await readFile(fixture.attemptsPath);

    await expect(fixture.exportPackage(false)).rejects.toThrow('ordinary_pending_package_mismatch');

    expect(await readdir(fixture.root)).not.toContain('pending.json');
    expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
  });
});
