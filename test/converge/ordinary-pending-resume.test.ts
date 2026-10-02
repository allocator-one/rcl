import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { capturePreparedCouncil } from '../../src/dispatch/capture-council.js';
import { chunkDiff } from '../../src/prepare/chunker.js';
import { guardedInputSha256, sha256Hex } from '../../src/report/run-header.js';
import { previewOrdinaryPendingLaunch, resumePendingLegacyLaunch } from '../../src/converge/pending-legacy-resume.js';

describe('ordinary pending launch migration', () => {
  it('finalizes a dead owner as unknown and claims exactly one fresh attempt without legacy inspection', async () => {
    const common = await realpath(await mkdtemp(join(tmpdir(), 'rcl-ordinary-pending-')));
    onTestFinished(() => rm(common, { recursive: true, force: true }));
    const target = 'ordinary-pending', headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
    const retainedBytes = JSON.stringify({ model: 'openai/test', role: 'general', provider: 'openai' });
    const retained = sha256Hex(retainedBytes);
    const guardedInput = { head: headSha, kind: 'patch', repo: 'allocator-one/allocator-one', pr: 9691,
      diff: 'c'.repeat(64), config: 'd'.repeat(64), roster: [{ model: 'openai/test', role: 'general', provider: 'openai', lane: 'async' }], prompts: [],
      asyncRoles: [{ name: 'general' }] };
    const inputSha256 = guardedInputSha256(guardedInput);
    const initialRun = vi.fn(async () => ({ runId: '018f21b4-bf80-7fd5-8000-000000000001',
      reportJsonSha256: 'f'.repeat(64), successfulReviews: 1, totalReviews: 1, deliveryPending: false }));
    await guardReviewLaunch({ gitCommonDir: common, target, headSha, inputSha256,
      maxAttempts: 2, maxRounds: 15, run: initialRun, validate: vi.fn(async () => {}) });
    const nativePath = convergeRunStatePath(common, target);
    const native = JSON.parse(await readFile(nativePath, 'utf8'));
    native.lastLaunch.status = 'pending';
    delete native.lastLaunch.runId;
    delete native.lastLaunch.reportJsonSha256;
    delete native.lastLaunch.successfulReviews;
    delete native.lastLaunch.totalReviews;
    delete native.lastLaunch.deliveryPending;
    native.lastLaunch.pid = 987_654;
    if (native.lastLaunch.processIdentity) native.lastLaunch.processIdentity.pid = 987_654;
    await writeFile(nativePath, JSON.stringify(native));

    const role = { name: 'general', description: 'review', focus: ['correctness'], isSpecialized: false,
      systemPrompt: 'review carefully' };
    const assignments = [{ model: 'openai/test', provider: 'openai' as const, role },
      { model: 'openai/test-2', provider: 'openai' as const, role: { ...role, name: 'security' } }];
    const diff = { files: [{ filename: 'a.ts', status: 'modified' as const,
      patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 }] };
    const chunks = chunkDiff(diff.files);
    const prompts = chunks.flatMap(() => assignments.map(assignment => ({
      systemPrompt: assignment.role.systemPrompt, userPrompt: 'patch',
    })));
    const captured = capturePreparedCouncil({ target, headSha, mergeBaseSha: baseSha, diff, assignments,
      lanes: ['blocking', 'blocking'], chunks, prompts,
      config: { models: ['openai/test'] }, specBytes: 'spec', contextDocs: [],
      compatibility: { parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } } });
    let crashAfterFinalize = true;
    const recoveredRun = vi.fn(async ({ launch }: any) => {
      if (crashAfterFinalize) { crashAfterFinalize = false; throw new Error('crash after ordinary finalization'); }
      return { runId: launch.runId, reportJsonSha256: '1'.repeat(64), successfulReviews: 1, totalReviews: 1, deliveryPending: false };
    });
    const options = { gitCommonDir: common, target, headSha, baseSha,
      pendingInputSha256: inputSha256, recoveryInputSha256: inputSha256,
      retryReason: 'Retry after dead ordinary owner.', captured, retainedAsyncSha256: [retained],
      migrationPackage: { target, headSha, baseSha, attempt: 1, round: 1, pid: 987_654,
        retainedAsyncSha256: [retained], retainedAsync: [{ sha256: retained, model: 'openai/test', role: 'general', provider: 'openai', lane: 'async' }], guardedInput }, maxAttempts: 2, maxPhysicalCalls: 1,
      maxAttemptsPerCell: 1, maxDurationMs: 1_000, validate: vi.fn(async () => {}), ownerAlive: () => false,
      loadRetainedAsync: async () => [{ path: join(common, 'async.json'), sha256: retained,
        bytesBase64: Buffer.from(retainedBytes).toString('base64') }], run: recoveredRun };
    const before = await readFile(nativePath);
    const attemptsPath = convergeAttemptStatePath(common, target);
    const attemptsBefore = await readFile(attemptsPath);
    await expect(previewOrdinaryPendingLaunch(options)).resolves.toMatchObject({
      attemptsUsed: 1, cap: 2, nextAttempt: 2,
      source: { pendingAttempt: 1, round: 1, originalPid: 987_654 },
    });
    expect(options.validate).not.toHaveBeenCalled();
    expect(recoveredRun).not.toHaveBeenCalled();
    expect(await readFile(nativePath)).toEqual(before);
    expect(await readFile(attemptsPath)).toEqual(attemptsBefore);
    await expect(resumePendingLegacyLaunch({ ...options, ownerAlive: () => true }))
      .rejects.toThrow('pending_legacy_resume_owner_alive');
    expect(await readFile(nativePath)).toEqual(before);
    await expect(resumePendingLegacyLaunch({ ...options, pendingInputSha256: 'f'.repeat(64) }))
      .rejects.toThrow('pending_legacy_resume_launch_mismatch');
    expect(await readFile(nativePath)).toEqual(before);
    const tampered = structuredClone(options.migrationPackage);
    tampered.target = 'another-target';
    await expect(resumePendingLegacyLaunch({ ...options, migrationPackage: tampered }))
      .rejects.toThrow('ordinary_pending_package_mismatch');
    expect(await readFile(nativePath)).toEqual(before);
    expect((await loadConvergeAttemptState(common, target))?.attemptsUsed).toBe(1);
    await expect(resumePendingLegacyLaunch(options)).rejects.toThrow('crash after ordinary finalization');
    expect((await loadConvergeRunState(common, target))?.lastLaunch)
      .toMatchObject({ status: 'failed', attempt: 2, pendingRecovery: { pendingAttempt: 1, blockingOutcome: 'unknown' } });
    expect((await loadConvergeAttemptState(common, target))?.attemptsUsed).toBe(2);
    const result = await resumePendingLegacyLaunch(options);

    expect(result.claim).toMatchObject({ attempt: 2, attemptsUsed: 2 });
    expect(recoveredRun).toHaveBeenCalledTimes(2);
    expect((await loadConvergeAttemptState(common, target))?.attempts[1]?.pendingRecoverySource)
      .toMatchObject({ migrationPackageSha256: expect.stringMatching(/^[a-f0-9]{64}$/), pendingAttempt: 1 });
    expect((await loadConvergeRunState(common, target))?.lastLaunch)
      .toMatchObject({ status: 'completed', attempt: 2, pendingRecovery: { blockingOutcome: 'unknown' } });
    await expect(resumePendingLegacyLaunch(options)).resolves.toMatchObject({ reusedCompletion: true,
      claim: { attempt: 2, attemptsUsed: 2 } });
    expect(recoveredRun).toHaveBeenCalledTimes(2);
  });
});
