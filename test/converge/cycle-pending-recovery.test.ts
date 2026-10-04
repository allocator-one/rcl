import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { exportOrdinaryPendingPackage } from '../../src/converge/ordinary-pending-export.js';
import { finalizeOrdinaryPendingLaunch, previewOrdinaryPendingLaunch } from '../../src/converge/pending-legacy-resume.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { guardedInputSha256, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { asyncTargetKey, consumeBoundAsyncHistory } from '../../src/dispatch/async-lane.js';

async function cyclePendingFixture(fixtureOptions: { retainedCount?: number; identicalResults?: boolean } = {}) {
  const common = await realpath(await mkdtemp(join(tmpdir(), 'rcl-cycle-pending-')));
  onTestFinished(() => rm(common, { recursive: true, force: true }));
  const target = 'allocator-one-9897';
  const headSha = '9'.repeat(40);
  const baseSha = 'd'.repeat(40);
  const at = '2026-10-04T03:38:13.314Z';
  let active: import('../../src/converge/review-cycle.js').ReviewCycleReceipt | null = null;
  const cycleRemote = {
    repo: 'allocator-one/allocator-one', prNumber: 9897, url: 'https://harness.example',
    current: vi.fn(async () => active),
    start: vi.fn(async (request: import('../../src/converge/review-cycle.js').ReviewCycleRequest) => {
      active = { ...request, id: randomUUID(), inserted_at: at };
      return active;
    }),
  };
  const guardedInput = {
    head: headSha, kind: 'patch', repo: cycleRemote.repo, pr: cycleRemote.prNumber,
    diff: 'c'.repeat(64), config: 'e'.repeat(64),
    roster: [{ model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter', lane: 'async' }],
    prompts: [], asyncRoles: [{ name: 'general' }],
  };
  const inputSha256 = guardedInputSha256(guardedInput);
  const completion = { runId: randomUUID(), reportJsonSha256: 'f'.repeat(64), successfulReviews: 2,
    totalReviews: 2, deliveryPending: false };
  const beforeClaim = vi.fn(async () => ({ ordinaryInputs: {
    version: 1 as const, packetSha256: 'a'.repeat(64), baseSha,
  } }));
  await guardReviewLaunch({ gitCommonDir: common, target, headSha, inputSha256,
    startOver: true, cycleRemote, maxAttempts: 35, maxRounds: 30,
    validate: async () => {}, beforeClaim, run: async () => completion });
  const state = (await loadConvergeRunState(common, target))!;
  const attempts = (await loadConvergeAttemptState(common, target))!;
  const nativePath = convergeRunStatePath(common, target);
  const pending = {
    ...state,
    lastLaunch: { status: 'pending' as const, attempt: 1, round: 1, headSha, inputSha256,
      startedAt: at, pid: 999_999 },
    updatedAt: at,
  };
  await writeFile(nativePath, `${JSON.stringify(pending, null, 2)}\n`);
  attempts.attempts[0]!.pid = 999_999;
  await writeFile(convergeAttemptStatePath(common, target), `${JSON.stringify(attempts, null, 2)}\n`);
  const retained = Array.from({ length: fixtureOptions.retainedCount ?? 16 }, (_, index) => {
    const bytes = JSON.stringify({ model: 'openrouter/moonshotai/kimi-k3', role: 'general',
      provider: 'openrouter', status: 'success', findings: [],
      durationMs: fixtureOptions.identicalResults ? 1 : index + 1, async: true });
    return { path: join(common, `async-${index}.json`), sha256: sha256Hex(bytes),
      bytesBase64: Buffer.from(bytes).toString('base64') };
  });
  const retainedAsyncSha256 = retained.map(item => item.sha256);
  const asyncStoreDir = join(common, 'rcl-async');
  await mkdir(asyncStoreDir, { mode: 0o700 });
  const asyncKey = asyncTargetKey(target, target, state.cycle!.id);
  await Promise.all(retained.map((item, index) => writeFile(
    join(asyncStoreDir, `result-${asyncKey}-${String(index).padStart(2, '0')}.json`),
    Buffer.from(item.bytesBase64, 'base64'), { mode: 0o600 })));
  const migrationPackage = {
    version: 2 as const,
    target, headSha, baseSha, attempt: 1, round: 1, pid: 999_999,
    cycle: state.cycle!, attemptCap: attempts.cap, roundCap: state.roundCap,
    attemptsUsed: attempts.attemptsUsed,
    asyncAttribution: 'cycle-history-unattributed' as const,
    retainedAsyncSha256,
    retainedAsync: retained.map(item => ({ sha256: item.sha256,
      model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter', lane: 'async' as const })),
    guardedInput,
  };
  const options = {
    gitCommonDir: common, target, headSha, baseSha, pendingInputSha256: inputSha256,
    recoveryInputSha256: inputSha256, retryReason: 'Terminalize the lost cycle launcher.',
    captured: {} as never, retainedAsyncSha256, migrationPackage, maxAttempts: 35,
    maxPhysicalCalls: 1, maxAttemptsPerCell: 1, maxDurationMs: 1,
    validate: vi.fn(async () => {}), ownerAlive: () => false, cycleRemote,
    loadRetainedAsync: vi.fn(async () => retained),
    run: vi.fn(async () => { throw new Error('no provider call is permitted'); }),
  };
  return { common, target, headSha, baseSha, inputSha256, nativePath, state, attempts,
    guardedInput, asyncStoreDir, asyncKey, cycleRemote, beforeClaim, options };
}

it('retains exact preclaim inputs for a cycle-backed launch', async () => {
  const fixture = await cyclePendingFixture();
  expect(fixture.beforeClaim).toHaveBeenCalledOnce();
  expect(fixture.beforeClaim).toHaveBeenCalledWith({ target: fixture.target, attempt: 1, round: 1,
    cycleId: fixture.state.cycle!.id }, expect.objectContaining({ target: fixture.target }));
});

it('exports every cycle artifact as unattributed history without requiring a legacy launch marker', async () => {
  const fixture = await cyclePendingFixture();
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-cycle-package-')));
  onTestFinished(() => rm(outputDir, { recursive: true, force: true }));
  const result = await exportOrdinaryPendingPackage({ gitCommonDir: fixture.common,
    target: fixture.target, headSha: fixture.headSha, baseSha: fixture.baseSha,
    expectedBaseSha: fixture.baseSha, expectedRound: 1, guardedInput: fixture.guardedInput,
    asyncStoreDir: fixture.asyncStoreDir, asyncTargetKey: fixture.asyncKey,
    asyncDescriptors: [{ model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter' }],
    path: join(outputDir, 'pending.json'), preview: true });
  expect(result).toMatchObject({ mode: 'pending-package-preview', attempt: 1, attemptsUsed: 1,
    cap: 35, roundCap: 30, cycleId: fixture.state.cycle!.id,
    operationId: fixture.state.cycle!.operationId });
  expect(result.retainedAsyncSha256).toHaveLength(16);
});

it('preserves duplicate-byte cycle artifacts as an exact multiset through finalization and cleanup', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 2, identicalResults: true });
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-cycle-package-')));
  onTestFinished(() => rm(outputDir, { recursive: true, force: true }));
  const result = await exportOrdinaryPendingPackage({ gitCommonDir: fixture.common,
    target: fixture.target, headSha: fixture.headSha, baseSha: fixture.baseSha,
    expectedBaseSha: fixture.baseSha, expectedRound: 1, guardedInput: fixture.guardedInput,
    asyncStoreDir: fixture.asyncStoreDir, asyncTargetKey: fixture.asyncKey,
    asyncDescriptors: [{ model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter' }],
    path: join(outputDir, 'pending.json'), preview: true });
  expect(result.retainedAsyncSha256).toEqual([
    fixture.options.retainedAsyncSha256[0], fixture.options.retainedAsyncSha256[0],
  ]);

  const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
  const finalized = await finalizeOrdinaryPendingLaunch({
    gitCommonDir: fixture.common, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
    nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 35,
    migrationPackage: fixture.options.migrationPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
  });
  expect(finalized.receipt.retainedAsyncSha256).toHaveLength(2);
  await consumeBoundAsyncHistory(fixture.asyncStoreDir, fixture.asyncKey,
    fixture.options.retainedAsyncSha256, 16);
  await expect((await import('node:fs/promises')).readdir(fixture.asyncStoreDir)).resolves.toEqual([]);
});

it('terminalizes a cycle with zero completed async artifacts', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 0 });
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-cycle-package-')));
  onTestFinished(() => rm(outputDir, { recursive: true, force: true }));
  const exported = await exportOrdinaryPendingPackage({ gitCommonDir: fixture.common,
    target: fixture.target, headSha: fixture.headSha, baseSha: fixture.baseSha,
    expectedBaseSha: fixture.baseSha, expectedRound: 1, guardedInput: fixture.guardedInput,
    asyncStoreDir: fixture.asyncStoreDir, asyncTargetKey: fixture.asyncKey,
    asyncDescriptors: [{ model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter' }],
    path: join(outputDir, 'pending.json'), preview: true });
  expect(exported.retainedAsyncSha256).toEqual([]);

  const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
  const finalized = await finalizeOrdinaryPendingLaunch({
    gitCommonDir: fixture.common, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
    nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: [], maxAttempts: 35,
    migrationPackage: fixture.options.migrationPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
  });
  expect(finalized.receipt.retainedAsyncSha256).toEqual([]);
  await consumeBoundAsyncHistory(fixture.asyncStoreDir, fixture.asyncKey, [], 16);
  await expect((await import('node:fs/promises')).readdir(fixture.asyncStoreDir)).resolves.toEqual([]);
  const successor = vi.fn(async () => ({ runId: randomUUID(), reportJsonSha256: '2'.repeat(64),
    successfulReviews: 2, totalReviews: 2, deliveryPending: false }));
  await guardReviewLaunch({ gitCommonDir: fixture.common, target: fixture.target,
    headSha: 'f'.repeat(40), inputSha256: '1'.repeat(64),
    retryReason: 'Continue at the current exact head after empty-history finalization.',
    cycleRemote: fixture.cycleRemote, validate: async () => {}, run: successor });
  expect(successor).toHaveBeenCalledOnce();
});

it('terminalizes a dead cycle attempt with unattributed async history and permits only a later successor', async () => {
  const fixture = await cyclePendingFixture();
  const nativeBefore = await readFile(fixture.nativePath);
  const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
  expect(preview).toMatchObject({ attemptsUsed: 1, cap: 35, nextAttempt: 2,
    source: { pendingAttempt: 1, round: 1, cycleId: fixture.state.cycle!.id,
      operationId: fixture.state.cycle!.operationId } });
  expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
  expect(fixture.options.run).not.toHaveBeenCalled();

  await expect(guardReviewLaunch({ gitCommonDir: fixture.common, target: fixture.target,
    headSha: 'f'.repeat(40), inputSha256: '1'.repeat(64), retryReason: 'Current exact head after A29.',
    cycleRemote: fixture.cycleRemote, validate: async () => {}, run: async () => ({
      runId: randomUUID(), reportJsonSha256: '2'.repeat(64), successfulReviews: 2,
      totalReviews: 2, deliveryPending: false,
    }) })).rejects.toThrow('cycle_pending_recovery_required');

  const finalized = await finalizeOrdinaryPendingLaunch({
    gitCommonDir: fixture.common, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
    nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 35,
    migrationPackage: fixture.options.migrationPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
  });
  expect(finalized).toMatchObject({ reusedReceipt: false, receipt: {
    version: 2, operation: 'cycle-pending-finalize-only', finalizedAttempt: 1,
    cycleId: fixture.state.cycle!.id, operationId: fixture.state.cycle!.operationId,
    attemptCap: 35, roundCap: 30, attemptsUsed: 1,
    asyncAttribution: 'cycle-history-unattributed', blockingOutcome: 'unknown',
  } });
  expect((await loadConvergeAttemptState(fixture.common, fixture.target))!).toEqual(fixture.attempts);
  expect(await loadConvergeRunState(fixture.common, fixture.target)).toMatchObject({
    cycle: fixture.state.cycle, roundCap: 30, rounds: [], findings: {},
    lastLaunch: { status: 'failed', attempt: 1, round: 1,
      pendingRecovery: { blockingOutcome: 'unknown' } },
  });
  expect(fixture.options.run).not.toHaveBeenCalled();
  await consumeBoundAsyncHistory(fixture.asyncStoreDir, fixture.asyncKey,
    fixture.options.retainedAsyncSha256, 16);
  await expect((await import('node:fs/promises')).readdir(fixture.asyncStoreDir)).resolves.toEqual([]);

  const attemptsBeforeSuccessor = await readFile(convergeAttemptStatePath(fixture.common, fixture.target));
  const sameInputValidate = vi.fn(async () => {});
  const sameInputSuccessor = vi.fn(async () => ({ runId: randomUUID(), reportJsonSha256: '2'.repeat(64),
    successfulReviews: 2, totalReviews: 2, deliveryPending: false }));
  await expect(guardReviewLaunch({ gitCommonDir: fixture.common, target: fixture.target,
    headSha: fixture.headSha, inputSha256: fixture.inputSha256,
    retryReason: 'Repeat the exact inputs after terminalizing A29.',
    cycleRemote: fixture.cycleRemote, validate: sameInputValidate, run: sameInputSuccessor }))
    .rejects.toThrow('cycle_pending_inputs_unchanged');
  expect(sameInputValidate).not.toHaveBeenCalled();
  expect(sameInputSuccessor).not.toHaveBeenCalled();
  expect(await readFile(convergeAttemptStatePath(fixture.common, fixture.target)))
    .toEqual(attemptsBeforeSuccessor);

  const successor = vi.fn(async () => ({ runId: randomUUID(), reportJsonSha256: '2'.repeat(64),
    successfulReviews: 2, totalReviews: 2, deliveryPending: false }));
  await guardReviewLaunch({ gitCommonDir: fixture.common, target: fixture.target,
    headSha: 'f'.repeat(40), inputSha256: '1'.repeat(64), retryReason: 'Current exact head after A29.',
    cycleRemote: fixture.cycleRemote, validate: async () => {}, run: successor });
  expect(successor).toHaveBeenCalledOnce();
  expect(await loadConvergeAttemptState(fixture.common, fixture.target)).toMatchObject({
    attemptsUsed: 2, cap: 35, cycle: fixture.state.cycle,
  });

  fixture.options.loadRetainedAsync.mockRejectedValue(new Error('live store no longer exists'));
  await expect(finalizeOrdinaryPendingLaunch({
    gitCommonDir: fixture.common, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
    nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 35,
    migrationPackage: fixture.options.migrationPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
  })).resolves.toMatchObject({ reusedReceipt: true, receipt: finalized.receipt });
});

it('rejects a recomputed cycle receipt and mutated attempt cap before validating or claiming a successor', async () => {
  const fixture = await cyclePendingFixture();
  const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
  const finalized = await finalizeOrdinaryPendingLaunch({
    gitCommonDir: fixture.common, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
    nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 35,
    migrationPackage: fixture.options.migrationPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
  });
  const attemptPath = convergeAttemptStatePath(fixture.common, fixture.target);
  const attempts = JSON.parse((await readFile(attemptPath)).toString('utf8'));
  attempts.cap = 36;
  const mutatedAttemptBytes = Buffer.from(`${JSON.stringify(attempts, null, 2)}\n`);
  await writeFile(attemptPath, mutatedAttemptBytes);

  const receiptPath = join(fixture.common, 'rcl-converge-pending-finalizations',
    finalized.receipt.migrationPackageSha256, 'receipt.json');
  const receipt = JSON.parse((await readFile(receiptPath)).toString('utf8'));
  receipt.cap = 36;
  receipt.attemptCap = 36;
  receipt.sourceAttemptStateSha256 = sha256Hex(mutatedAttemptBytes);
  const { receiptDigest: _oldDigest, ...body } = receipt;
  receipt.receiptDigest = sha256Hex(stableStringify(body));
  await writeFile(receiptPath, stableStringify(receipt));

  const validate = vi.fn(async () => {});
  const run = vi.fn(async () => ({ runId: randomUUID(), reportJsonSha256: '2'.repeat(64),
    successfulReviews: 2, totalReviews: 2, deliveryPending: false }));
  const attemptsBefore = await readFile(attemptPath);
  await expect(guardReviewLaunch({ gitCommonDir: fixture.common, target: fixture.target,
    headSha: 'f'.repeat(40), inputSha256: '1'.repeat(64), maxAttempts: 36,
    retryReason: 'Current exact head after A29.', cycleRemote: fixture.cycleRemote,
    validate, run })).rejects.toThrow('cycle_pending_recovery_required');
  expect(validate).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(await readFile(attemptPath)).toEqual(attemptsBefore);
});

it('refuses cycle, cap, and server membership drift before any recovery write', async () => {
  const fixture = await cyclePendingFixture();
  const nativeBefore = await readFile(fixture.nativePath);
  const attemptsBefore = await readFile(convergeAttemptStatePath(fixture.common, fixture.target));
  const changedCycle = structuredClone(fixture.options.migrationPackage);
  changedCycle.cycle.id = randomUUID();
  await expect(previewOrdinaryPendingLaunch({ ...fixture.options,
    migrationPackage: changedCycle, previewMode: 'finalize-only' }))
    .rejects.toThrow('ordinary_pending_package_mismatch');
  await expect(previewOrdinaryPendingLaunch({ ...fixture.options,
    migrationPackage: { ...fixture.options.migrationPackage, attemptCap: 34 }, previewMode: 'finalize-only' }))
    .rejects.toThrow('ordinary_pending_package_mismatch');
  const current = await fixture.cycleRemote.current();
  fixture.cycleRemote.current.mockResolvedValueOnce({ ...current!, id: randomUUID() });
  await expect(previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' }))
    .rejects.toThrow('pending_legacy_resume_cycle_superseded');
  expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
  expect(await readFile(convergeAttemptStatePath(fixture.common, fixture.target))).toEqual(attemptsBefore);
  expect(fixture.options.loadRetainedAsync).not.toHaveBeenCalled();
});
