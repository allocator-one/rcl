import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { exportOrdinaryPendingPackage, retainOrdinaryLaunchInputs } from '../../src/converge/ordinary-pending-export.js';
import { finalizeOrdinaryPendingLaunch, previewOrdinaryPendingLaunch } from '../../src/converge/pending-legacy-resume.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { guardedInputSha256, sha256Hex, stableStringify } from '../../src/report/run-header.js';
import { asyncTargetKey, consumeBoundAsyncHistory } from '../../src/dispatch/async-lane.js';
import { ordinaryPendingGuardedInput } from '../../src/converge/ordinary-pending-package.js';

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
  const beforeClaim = vi.fn(async (context: { target: string; attempt: number; round: number; cycleId?: string }) => {
    const retained = await retainOrdinaryLaunchInputs({ gitCommonDir: common, target: context.target,
      attempt: context.attempt, round: context.round, ...(context.cycleId ? { cycleId: context.cycleId } : {}),
      headSha, baseSha, guardedInput,
      asyncDescriptors: [{ model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter' }] });
    return { ordinaryInputs: { version: 1 as const, packetSha256: retained.sha256, baseSha } };
  });
  await guardReviewLaunch({ gitCommonDir: common, target, headSha, inputSha256,
    startOver: true, cycleRemote, maxAttempts: 35, maxRounds: 30,
    validate: async () => {}, beforeClaim, run: async () => completion });
  const state = (await loadConvergeRunState(common, target))!;
  const attempts = (await loadConvergeAttemptState(common, target))!;
  const nativePath = convergeRunStatePath(common, target);
  const deadProcessIdentity = state.lastLaunch?.processIdentity
    ? { ...state.lastLaunch.processIdentity, pid: 999_999, birthSha256: '0'.repeat(64) }
    : undefined;
  const pending = {
    ...state,
    lastLaunch: { status: 'pending' as const, attempt: 1, round: 1, headSha, inputSha256,
      startedAt: at, pid: 999_999, ordinaryInputs: state.lastLaunch!.ordinaryInputs,
      ...(deadProcessIdentity ? { processIdentity: deadProcessIdentity } : {}) },
    updatedAt: at,
  };
  await writeFile(nativePath, `${JSON.stringify(pending, null, 2)}\n`);
  attempts.attempts[0]!.pid = 999_999;
  attempts.attempts[0]!.processIdentity = deadProcessIdentity;
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
  const cycleHistory = { storeDir: asyncStoreDir, targetKey: asyncKey, maxResults: 16 };
  return { common, target, headSha, baseSha, inputSha256, nativePath, state, attempts,
    guardedInput, asyncStoreDir, asyncKey, cycleHistory, cycleRemote, beforeClaim, options };
}

async function cycleFinalizeOptions(fixture: Awaited<ReturnType<typeof cyclePendingFixture>>) {
  const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
  return { gitCommonDir: fixture.common, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
    nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 35,
    migrationPackage: fixture.options.migrationPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
    cycleHistory: fixture.cycleHistory };
}

function retainedResultBytes(durationMs = 1): string {
  return JSON.stringify({ model: 'openrouter/moonshotai/kimi-k3', role: 'general',
    provider: 'openrouter', status: 'success', findings: [], durationMs, async: true });
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

it('authenticates historical cycle results against the retained roster after the current roster changes', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 2 });
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-cycle-package-')));
  onTestFinished(() => rm(outputDir, { recursive: true, force: true }));
  const outputPath = join(outputDir, 'pending.json');
  const currentInput = structuredClone(fixture.guardedInput);
  currentInput.roster = [{ model: 'anthropic/current-seat', role: 'general', provider: 'anthropic', lane: 'async' }];
  const result = await exportOrdinaryPendingPackage({ gitCommonDir: fixture.common,
    target: fixture.target, headSha: fixture.headSha, baseSha: fixture.baseSha,
    expectedBaseSha: fixture.baseSha, expectedRound: 1, guardedInput: currentInput,
    asyncStoreDir: fixture.asyncStoreDir, asyncTargetKey: fixture.asyncKey,
    asyncDescriptors: [{ model: 'anthropic/current-seat', role: 'general', provider: 'anthropic' }],
    path: outputPath, preview: false });
  expect(result.retainedAsyncSha256).toEqual(fixture.options.retainedAsyncSha256.slice().sort());
  const compactPackage = JSON.parse(await readFile(outputPath, 'utf8'));
  expect(compactPackage.guardedInputRepresentation)
    .toEqual({ version: 1, encoding: 'json-string-table-v1' });
  expect(ordinaryPendingGuardedInput(compactPackage)).toEqual(fixture.guardedInput);

  const preview = await previewOrdinaryPendingLaunch({ ...fixture.options,
    migrationPackage: compactPackage, previewMode: 'finalize-only' });
  const finalized = await finalizeOrdinaryPendingLaunch({
    gitCommonDir: fixture.common, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
    nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 35,
    migrationPackage: compactPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
    cycleHistory: fixture.cycleHistory,
  });
  expect(finalized.receipt).toMatchObject({ version: 2, finalizedAttempt: 1,
    cycleId: fixture.state.cycle!.id });
});

it('rejects cycle results outside the authenticated historical roster', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const [resultName] = await readdir(fixture.asyncStoreDir);
  await writeFile(join(fixture.asyncStoreDir, resultName!), JSON.stringify({
    model: 'anthropic/unretained-seat', role: 'general', provider: 'anthropic',
    status: 'success', findings: [], durationMs: 1, async: true,
  }));
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-cycle-package-')));
  onTestFinished(() => rm(outputDir, { recursive: true, force: true }));
  await expect(exportOrdinaryPendingPackage({ gitCommonDir: fixture.common,
    target: fixture.target, headSha: fixture.headSha, baseSha: fixture.baseSha,
    expectedBaseSha: fixture.baseSha, expectedRound: 1, guardedInput: fixture.guardedInput,
    asyncStoreDir: fixture.asyncStoreDir, asyncTargetKey: fixture.asyncKey,
    asyncDescriptors: [{ model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter' }],
    path: join(outputDir, 'pending.json'), preview: true }))
    .rejects.toThrow('pending_export_async_identity_mismatch');
});

it('rejects changed retained cycle input bytes even when the current reconstruction is valid', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const [retainedName] = await readdir(join(fixture.common, 'rcl-ordinary-inputs'));
  await writeFile(join(fixture.common, 'rcl-ordinary-inputs', retainedName!), '{"tampered":true}\n');
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-cycle-package-')));
  onTestFinished(() => rm(outputDir, { recursive: true, force: true }));
  await expect(exportOrdinaryPendingPackage({ gitCommonDir: fixture.common,
    target: fixture.target, headSha: fixture.headSha, baseSha: fixture.baseSha,
    expectedBaseSha: fixture.baseSha, expectedRound: 1, guardedInput: fixture.guardedInput,
    asyncStoreDir: fixture.asyncStoreDir, asyncTargetKey: fixture.asyncKey,
    asyncDescriptors: [{ model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter' }],
    path: join(outputDir, 'pending.json'), preview: true }))
    .rejects.toThrow('pending_export_retained_input_mismatch');
});

it('consumes cycle history under the target lock and resumes idempotently after a cleanup crash', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 2 });
  const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
  let first = true;
  const consume = vi.fn(async (storeDir: string, targetKey: string,
    expected: readonly string[], maxResults: number) => {
    if (first) {
      first = false;
      const name = (await readdir(storeDir)).find(value => value.startsWith(`result-${targetKey}-`))!;
      await rm(join(storeDir, name));
      throw new Error('synthetic_cycle_history_cleanup_crash');
    }
    await consumeBoundAsyncHistory(storeDir, targetKey, expected, maxResults);
  });
  const options = { gitCommonDir: fixture.common, target: fixture.target, headSha: fixture.headSha,
    baseSha: fixture.baseSha, pendingInputSha256: fixture.inputSha256,
    nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 35,
    migrationPackage: fixture.options.migrationPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
    cycleHistory: fixture.cycleHistory,
    consumeCycleHistory: consume };
  await expect(finalizeOrdinaryPendingLaunch(options)).rejects.toThrow('synthetic_cycle_history_cleanup_crash');
  expect(await loadConvergeRunState(fixture.common, fixture.target)).toMatchObject({
    lastLaunch: { status: 'failed', pendingRecovery: { blockingOutcome: 'unknown' } },
  });
  await expect(finalizeOrdinaryPendingLaunch(options)).resolves.toMatchObject({ reusedReceipt: false });
  expect(await readdir(fixture.asyncStoreDir)).toEqual([]);
  expect(consume).toHaveBeenCalledTimes(2);
});

it('reconciles raw and renamed duplicate occurrences when an exact receipt is replayed', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 3, identicalResults: true });
  const options = await cycleFinalizeOptions(fixture);
  await finalizeOrdinaryPendingLaunch(options);
  const bytes = retainedResultBytes();
  for (const name of ['raw-one.json', 'raw-two.json', `renamed.json.consumed-${randomUUID()}`]) {
    await writeFile(join(fixture.asyncStoreDir, `result-${fixture.asyncKey}-${name}`), bytes);
  }
  await expect(finalizeOrdinaryPendingLaunch(options)).resolves.toMatchObject({ reusedReceipt: true });
  await expect(readdir(fixture.asyncStoreDir)).resolves.toEqual([]);
});

it('accepts a missing or empty cycle namespace only after authenticating an exact receipt', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const options = await cycleFinalizeOptions(fixture);
  await finalizeOrdinaryPendingLaunch(options);
  const resolveEmpty = vi.fn(async () => fixture.asyncStoreDir);
  await expect(finalizeOrdinaryPendingLaunch({ ...options, cycleHistory: {
    ...fixture.cycleHistory, storeDir: undefined, resolveStoreDir: resolveEmpty,
  } })).resolves.toMatchObject({ reusedReceipt: true });
  expect(resolveEmpty).toHaveBeenCalledOnce();

  await rm(fixture.asyncStoreDir, { recursive: true, force: true });
  const missing = Object.assign(new Error('live async store no longer exists'), { code: 'ENOENT' });
  const resolveMissing = vi.fn(async () => { throw missing; });
  await expect(finalizeOrdinaryPendingLaunch({ ...options, cycleHistory: {
    ...fixture.cycleHistory, storeDir: undefined, resolveStoreDir: resolveMissing,
  } })).resolves.toMatchObject({ reusedReceipt: true });
  expect(resolveMissing).toHaveBeenCalledOnce();
});

it.each(['overcount', 'unexpected'] as const)(
  'rejects %s live occurrences while replaying an exact receipt', async mode => {
    const fixture = await cyclePendingFixture({ retainedCount: 2, identicalResults: true });
    const options = await cycleFinalizeOptions(fixture);
    await finalizeOrdinaryPendingLaunch(options);
    const bytes = retainedResultBytes();
    const replay = mode === 'overcount' ? [bytes, bytes, bytes] : [bytes, retainedResultBytes(99)];
    await Promise.all(replay.map((item, index) => writeFile(
      join(fixture.asyncStoreDir, `result-${fixture.asyncKey}-replay-${index}.json`), item)));
    await expect(finalizeOrdinaryPendingLaunch(options))
      .rejects.toThrow('async_resume_result_binding_mismatch');
  });

it('fails when the authenticated cycle store disappears after path resolution', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const options = await cycleFinalizeOptions(fixture);
  await finalizeOrdinaryPendingLaunch(options);
  const resolveThenRemove = vi.fn(async () => {
    await rm(fixture.asyncStoreDir, { recursive: true, force: true });
    return fixture.asyncStoreDir;
  });
  await expect(finalizeOrdinaryPendingLaunch({ ...options, cycleHistory: {
    ...fixture.cycleHistory, storeDir: undefined, resolveStoreDir: resolveThenRemove,
  } })).rejects.toMatchObject({ code: 'ENOENT' });
});

it('requires one unambiguous cycle history source and does not excuse a new missing store', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const options = await cycleFinalizeOptions(fixture);
  await expect(finalizeOrdinaryPendingLaunch({ ...options, cycleHistory: {
    ...fixture.cycleHistory, resolveStoreDir: async () => fixture.asyncStoreDir,
  } })).rejects.toThrow('pending_legacy_resume_invalid_input');
  const missing = Object.assign(new Error('new receipt store missing'), { code: 'ENOENT' });
  await expect(finalizeOrdinaryPendingLaunch({ ...options, cycleHistory: {
    ...fixture.cycleHistory, storeDir: undefined, resolveStoreDir: async () => { throw missing; },
  } })).rejects.toMatchObject({ code: 'ENOENT' });
});

it('allows an advanced successor only with an empty old namespace and rejects remaining ambiguity', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const options = await cycleFinalizeOptions(fixture);
  await finalizeOrdinaryPendingLaunch(options);
  await guardReviewLaunch({ gitCommonDir: fixture.common, target: fixture.target,
    headSha: 'f'.repeat(40), inputSha256: '1'.repeat(64), retryReason: 'Materially changed inputs.',
    cycleRemote: fixture.cycleRemote, validate: async () => {}, run: async () => ({
      runId: randomUUID(), reportJsonSha256: '2'.repeat(64), successfulReviews: 2,
      totalReviews: 2, deliveryPending: false,
    }) });
  await expect(finalizeOrdinaryPendingLaunch(options)).resolves.toMatchObject({ reusedReceipt: true });
  await writeFile(join(fixture.asyncStoreDir, `result-${fixture.asyncKey}-ambiguous.json`),
    retainedResultBytes());
  await expect(finalizeOrdinaryPendingLaunch(options))
    .rejects.toThrow('pending_legacy_resume_cycle_history_ambiguous_after_successor');
});

it('refuses late cycle-history contamination before a waiting successor can become eligible', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
  let entered!: () => void, release!: () => void;
  const consuming = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const consume = vi.fn(async (storeDir: string, targetKey: string,
    expected: readonly string[], maxResults: number) => {
    entered(); await held;
    await consumeBoundAsyncHistory(storeDir, targetKey, expected, maxResults);
  });
  const finalizing = finalizeOrdinaryPendingLaunch({ gitCommonDir: fixture.common,
    target: fixture.target, headSha: fixture.headSha, baseSha: fixture.baseSha,
    pendingInputSha256: fixture.inputSha256, nativeStateSha256: preview.nativeStateSha256,
    attemptStateSha256: preview.attemptStateSha256,
    retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 35,
    migrationPackage: fixture.options.migrationPackage, ownerAlive: () => false,
    cycleRemote: fixture.cycleRemote, loadRetainedAsync: fixture.options.loadRetainedAsync,
    cycleHistory: fixture.cycleHistory, consumeCycleHistory: consume });
  await consuming;
  const successorRun = vi.fn(async () => ({ runId: randomUUID(), reportJsonSha256: '2'.repeat(64),
    successfulReviews: 2, totalReviews: 2, deliveryPending: false }));
  const successor = guardReviewLaunch({ gitCommonDir: fixture.common, target: fixture.target,
    headSha: 'f'.repeat(40), inputSha256: '1'.repeat(64),
    retryReason: 'Materially changed exact inputs.', cycleRemote: fixture.cycleRemote,
    validate: async () => {}, run: successorRun });
  await writeFile(join(fixture.asyncStoreDir, `result-${fixture.asyncKey}-late.json`),
    JSON.stringify({ model: 'openrouter/moonshotai/kimi-k3', role: 'general', provider: 'openrouter',
      status: 'success', findings: [], durationMs: 999, async: true }));
  release();
  await expect(finalizing).rejects.toThrow('async_resume_result_binding_mismatch');
  await expect(successor).rejects.toThrow('cycle_pending_recovery_required');
  expect(successorRun).not.toHaveBeenCalled();
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
    cycleHistory: fixture.cycleHistory,
  });
  expect(finalized.receipt.retainedAsyncSha256).toHaveLength(2);
  await expect(readdir(fixture.asyncStoreDir)).resolves.toEqual([]);
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
    cycleHistory: fixture.cycleHistory,
  });
  expect(finalized.receipt.retainedAsyncSha256).toEqual([]);
  await expect(readdir(fixture.asyncStoreDir)).resolves.toEqual([]);
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
    cycleHistory: fixture.cycleHistory,
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
  await expect(readdir(fixture.asyncStoreDir)).resolves.toEqual([]);

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
    cycleHistory: fixture.cycleHistory,
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
    cycleHistory: fixture.cycleHistory,
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

it('revalidates live cycle membership immediately before the first recovery write', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const options = await cycleFinalizeOptions(fixture);
  const nativeBefore = await readFile(fixture.nativePath);
  const attemptsBefore = await readFile(convergeAttemptStatePath(fixture.common, fixture.target));
  const asyncBefore = await readdir(fixture.asyncStoreDir);
  const active = structuredClone(fixture.state.cycle!);
  fixture.cycleRemote.current.mockReset();
  fixture.cycleRemote.current
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce({ ...active, id: randomUUID() });

  await expect(finalizeOrdinaryPendingLaunch(options))
    .rejects.toThrow('pending_legacy_resume_cycle_superseded');

  expect(fixture.cycleRemote.current).toHaveBeenCalledTimes(2);
  expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
  expect(await readFile(convergeAttemptStatePath(fixture.common, fixture.target))).toEqual(attemptsBefore);
  expect(await readdir(fixture.asyncStoreDir)).toEqual(asyncBefore);
  await expect(readdir(join(fixture.common, 'rcl-converge-pending-recovery')))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it('revalidates live cycle membership before an exact receipt replay can mutate state', async () => {
  const fixture = await cyclePendingFixture({ retainedCount: 1 });
  const options = await cycleFinalizeOptions(fixture);
  await finalizeOrdinaryPendingLaunch(options);
  const nativeBefore = await readFile(fixture.nativePath);
  const attemptsBefore = await readFile(convergeAttemptStatePath(fixture.common, fixture.target));
  const consumeCycleHistory = vi.fn<typeof consumeBoundAsyncHistory>();
  const active = structuredClone(fixture.state.cycle!);
  fixture.cycleRemote.current.mockReset();
  fixture.cycleRemote.current
    .mockResolvedValueOnce(active)
    .mockResolvedValueOnce({ ...active, id: randomUUID() });

  await expect(finalizeOrdinaryPendingLaunch({ ...options, consumeCycleHistory }))
    .rejects.toThrow('pending_legacy_resume_cycle_superseded');

  expect(fixture.cycleRemote.current).toHaveBeenCalledTimes(2);
  expect(consumeCycleHistory).not.toHaveBeenCalled();
  expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
  expect(await readFile(convergeAttemptStatePath(fixture.common, fixture.target))).toEqual(attemptsBefore);
});
