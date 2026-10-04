import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claimConvergeAttempt, convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { finalizeOrdinaryPendingLaunch, previewOrdinaryPendingLaunch,
  resumePendingLegacyLaunch } from '../../src/converge/pending-legacy-resume.js';
import { guardedInputSha256, sha256Hex } from '../../src/report/run-header.js';

async function pendingAttemptSix(cap = 20) {
  const common = await realpath(await mkdtemp(join(tmpdir(), 'rcl-ordinary-finalize-')));
  onTestFinished(() => rm(common, { recursive: true, force: true }));
  const target = 'rcl-146';
  const headSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  for (let attempt = 1; attempt <= 6; attempt++) {
    await claimConvergeAttempt({ gitCommonDir: common, target, maxAttempts: cap, recordPid: 900_000 + attempt });
  }
  const retainedBytes = JSON.stringify({ model: 'openai/test', role: 'general', provider: 'openai' });
  const retained = sha256Hex(retainedBytes);
  const guardedInput = { head: headSha, kind: 'patch', repo: 'allocator-one/rcl', pr: 146,
    diff: 'c'.repeat(64), config: 'd'.repeat(64),
    roster: [{ model: 'openai/test', role: 'general', provider: 'openai', lane: 'async' }],
    prompts: [], asyncRoles: [{ name: 'general' }] };
  const inputSha256 = guardedInputSha256(guardedInput);
  const nativePath = convergeRunStatePath(common, target);
  await mkdir(dirname(nativePath), { recursive: true, mode: 0o700 });
  await writeFile(nativePath, `${JSON.stringify({ version: 1, target, roundCap: 15,
    rounds: [{ round: 1, counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } }], findings: {},
    updatedAt: '2026-10-02T00:00:00.000Z', lastLaunch: { status: 'pending', attempt: 6, round: 4,
      headSha, inputSha256, startedAt: '2026-10-02T00:00:00.000Z', pid: 999_999 } }, null, 2)}\n`);
  const migrationPackage = { target, headSha, baseSha, attempt: 6, round: 4, pid: 999_999,
    retainedAsyncSha256: [retained], retainedAsync: [{ sha256: retained, model: 'openai/test',
      role: 'general', provider: 'openai', lane: 'async' as const }], guardedInput };
  const options = { gitCommonDir: common, target, headSha, baseSha, pendingInputSha256: inputSha256,
    recoveryInputSha256: inputSha256, retryReason: 'Finalize dead owner before an independent successor.',
    captured: {} as never, retainedAsyncSha256: [retained], migrationPackage, maxAttempts: cap,
    maxPhysicalCalls: 1, maxAttemptsPerCell: 1, maxDurationMs: 1_000,
    validate: vi.fn(async () => {}), ownerAlive: () => false,
    loadRetainedAsync: vi.fn(async () => [{ path: join(common, 'async.json'), sha256: retained,
      bytesBase64: Buffer.from(retainedBytes).toString('base64') }]),
    run: vi.fn(async () => { throw new Error('provider callback must not run'); }) };
  return { common, target, nativePath, attemptsPath: convergeAttemptStatePath(common, target), options };
}

describe('ordinary pending finalize-only recovery', () => {
  it('validates combined successor cap compatibility before any mutation', async () => {
    const fixture = await pendingAttemptSix();
    const nativeBefore = await readFile(fixture.nativePath);
    const attemptsBefore = await readFile(fixture.attemptsPath);
    const archive = join(fixture.common, 'rcl-converge-pending-recovery');

    await expect(resumePendingLegacyLaunch(fixture.options))
      .rejects.toThrow('pending_legacy_resume_attempt_cap_mismatch');

    expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    expect(fixture.options.validate).not.toHaveBeenCalled();
    expect(fixture.options.loadRetainedAsync).not.toHaveBeenCalled();
    expect(fixture.options.run).not.toHaveBeenCalled();
    await expect(access(archive)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('previews and finalizes A6 without claiming A7, then reads back the same receipt', async () => {
    const fixture = await pendingAttemptSix();
    const nativeBefore = await readFile(fixture.nativePath);
    const attemptsBefore = await readFile(fixture.attemptsPath);
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    const finalizeOptions = { gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256,
      maxAttempts: fixture.options.maxAttempts, migrationPackage: fixture.options.migrationPackage,
      ownerAlive: fixture.options.ownerAlive, loadRetainedAsync: fixture.options.loadRetainedAsync };

    expect(preview).toMatchObject({ attemptsUsed: 6, cap: 20, nextAttempt: 7,
      source: { pendingAttempt: 6, round: 4, blockingOutcome: 'unknown' } });
    expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    await expect(access(join(fixture.common, 'rcl-converge-pending-recovery')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(fixture.common, 'rcl-converge-pending-finalizations')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const first = await finalizeOrdinaryPendingLaunch(finalizeOptions);
    expect(first).toMatchObject({ reusedReceipt: false, receipt: {
      version: 1, operation: 'ordinary-pending-finalize-only', target: fixture.target,
      finalizedAttempt: 6, round: 4, attemptsUsed: 6, cap: 20, nextFreeAttempt: 7,
      blockingOutcome: 'unknown', receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    } });
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    expect(JSON.parse(await readFile(fixture.nativePath, 'utf8')).lastLaunch)
      .toMatchObject({ status: 'failed', attempt: 6, round: 4,
        pendingRecovery: { pendingAttempt: 6, blockingOutcome: 'unknown' } });
    expect(JSON.parse(await readFile(fixture.nativePath, 'utf8')).rounds)
      .toEqual([{ round: 1, counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } }]);
    expect(fixture.options.run).not.toHaveBeenCalled();
    await expect(access(join(fixture.common, 'rcl-checkpoints'))).rejects.toMatchObject({ code: 'ENOENT' });

    const nativeFinalized = await readFile(fixture.nativePath);
    fixture.options.loadRetainedAsync.mockRejectedValue(new Error('original async store is unavailable'));
    const repeated = await finalizeOrdinaryPendingLaunch(finalizeOptions);
    expect(repeated).toEqual({ receipt: first.receipt, reusedReceipt: true,
      snapshotBindingUpgraded: false });
    expect(await readFile(fixture.nativePath)).toEqual(nativeFinalized);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    expect(fixture.options.loadRetainedAsync).toHaveBeenCalledTimes(2);
  });

  it('allows finalize-only at an exhausted attempt cap without allocating a successor', async () => {
    const fixture = await pendingAttemptSix(6);
    const attemptsBefore = await readFile(fixture.attemptsPath);
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    expect(preview).toMatchObject({ attemptsUsed: 6, cap: 6, nextAttempt: 7 });
    await expect(previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'combined' }))
      .rejects.toThrow('pending_legacy_resume_attempt_cap_exhausted');

    const result = await finalizeOrdinaryPendingLaunch({ gitCommonDir: fixture.common,
      target: fixture.target, headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 6,
      migrationPackage: fixture.options.migrationPackage, ownerAlive: fixture.options.ownerAlive,
      loadRetainedAsync: fixture.options.loadRetainedAsync });
    expect(result.receipt).toMatchObject({ finalizedAttempt: 6, attemptsUsed: 6, cap: 6,
      nextFreeAttempt: 7 });
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
  });

  it('reads back an immutable receipt after a legitimate successor claim', async () => {
    const fixture = await pendingAttemptSix();
    const pendingWithFinding = JSON.parse(await readFile(fixture.nativePath, 'utf8'));
    pendingWithFinding.findings = { stable: { marker: 'original' } };
    await writeFile(fixture.nativePath, `${JSON.stringify(pendingWithFinding, null, 2)}\n`);
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    const options = { gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 20,
      migrationPackage: fixture.options.migrationPackage, ownerAlive: fixture.options.ownerAlive,
      loadRetainedAsync: fixture.options.loadRetainedAsync };
    const finalized = await finalizeOrdinaryPendingLaunch(options);
    const finalizedNative = await readFile(fixture.nativePath);
    const finalizedAttempts = await readFile(fixture.attemptsPath);
    const receiptRoot = join(fixture.common, 'rcl-converge-pending-finalizations');
    const [receiptDirectory] = await readdir(receiptRoot);
    const receiptPath = join(receiptRoot, receiptDirectory!, 'receipt.json');
    const receiptBeforeUpgrade = await readFile(receiptPath);
    await rm(join(receiptRoot, receiptDirectory!, 'source-attempt-state.json'));
    await rm(join(receiptRoot, receiptDirectory!, 'finalized-native-state.json'));
    const archive = join(fixture.common, 'rcl-converge-pending-recovery',
      finalized.receipt.sourceDigest);
    const archiveBefore = await Promise.all((await readdir(archive)).sort()
      .map(async name => [name, await readFile(join(archive, name))] as const));

    const upgraded = await finalizeOrdinaryPendingLaunch(options);
    expect(upgraded).toEqual({ receipt: finalized.receipt, reusedReceipt: true,
      snapshotBindingUpgraded: true });
    expect(await readFile(fixture.nativePath)).toEqual(finalizedNative);
    expect(await readFile(fixture.attemptsPath)).toEqual(finalizedAttempts);
    expect(await readFile(receiptPath)).toEqual(receiptBeforeUpgrade);
    expect(await Promise.all((await readdir(archive)).sort()
      .map(async name => [name, await readFile(join(archive, name))] as const))).toEqual(archiveBefore);

    await claimConvergeAttempt({ gitCommonDir: fixture.common, target: fixture.target,
      maxAttempts: 7, recordPid: 900_007 });
    const successorState = JSON.parse(await readFile(fixture.nativePath, 'utf8'));
    successorState.lastLaunch = { status: 'pending', attempt: 7, round: 4,
      headSha: fixture.options.headSha, inputSha256: fixture.options.pendingInputSha256,
      startedAt: '2026-10-02T02:00:00.000Z', pid: 900_007 };
    successorState.updatedAt = '2026-10-02T02:00:00.000Z';
    await writeFile(fixture.nativePath, `${JSON.stringify(successorState, null, 2)}\n`);
    fixture.options.loadRetainedAsync.mockRejectedValue(new Error('original async store is unavailable'));

    await expect(finalizeOrdinaryPendingLaunch(options))
      .resolves.toEqual({ receipt: finalized.receipt, reusedReceipt: true,
        snapshotBindingUpgraded: false });
    expect(JSON.parse(await readFile(fixture.attemptsPath, 'utf8')))
      .toMatchObject({ attemptsUsed: 7, cap: 7 });

    const validSuccessorNative = await readFile(fixture.nativePath);
    const malformedSuccessor = JSON.parse(validSuccessorNative.toString('utf8'));
    delete malformedSuccessor.lastLaunch.startedAt;
    await writeFile(fixture.nativePath, `${JSON.stringify(malformedSuccessor, null, 2)}\n`);
    await expect(finalizeOrdinaryPendingLaunch(options))
      .rejects.toThrow('pending_legacy_resume_finalization_receipt_state_mismatch');

    const changedFinding = JSON.parse(validSuccessorNative.toString('utf8'));
    changedFinding.findings.stable.marker = 'changed';
    await writeFile(fixture.nativePath, `${JSON.stringify(changedFinding, null, 2)}\n`);
    await expect(finalizeOrdinaryPendingLaunch(options))
      .rejects.toThrow('pending_legacy_resume_finalization_receipt_state_mismatch');
    await writeFile(fixture.nativePath, validSuccessorNative);

    const divergentAttempts = JSON.parse(await readFile(fixture.attemptsPath, 'utf8'));
    divergentAttempts.attempts[0].pid += 1;
    await writeFile(fixture.attemptsPath, `${JSON.stringify(divergentAttempts, null, 2)}\n`);
    await expect(finalizeOrdinaryPendingLaunch(options))
      .rejects.toThrow('pending_legacy_resume_finalization_receipt_state_mismatch');
  });

  it('resumes receipt publication after finalization without changing accounting or duplicating archives', async () => {
    const fixture = await pendingAttemptSix();
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    const options = { gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256,
      maxAttempts: fixture.options.maxAttempts, migrationPackage: fixture.options.migrationPackage,
      ownerAlive: fixture.options.ownerAlive, loadRetainedAsync: fixture.options.loadRetainedAsync };
    const first = await finalizeOrdinaryPendingLaunch(options);
    const nativeFinalized = await readFile(fixture.nativePath);
    const attemptsFinalized = await readFile(fixture.attemptsPath);
    const receiptRoot = join(fixture.common, 'rcl-converge-pending-finalizations');
    const packageDirectories = await readdir(receiptRoot);
    expect(packageDirectories).toHaveLength(1);
    await rm(join(receiptRoot, packageDirectories[0]!, 'receipt.json'));
    fixture.options.loadRetainedAsync.mockRejectedValue(new Error('original async store is unavailable'));

    const resumed = await finalizeOrdinaryPendingLaunch(options);
    expect(resumed).toEqual({ receipt: first.receipt, reusedReceipt: false,
      snapshotBindingUpgraded: false });
    expect(await readFile(fixture.nativePath)).toEqual(nativeFinalized);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsFinalized);
    const archive = join(fixture.common, 'rcl-converge-pending-recovery', first.receipt.sourceDigest);
    expect((await readdir(archive)).sort())
      .toEqual([...first.receipt.retainedAsyncSha256, 'manifest.json'].sort());
    expect(fixture.options.loadRetainedAsync).toHaveBeenCalledTimes(2);
  });

  it('refuses receipt readback when finalized native or attempt state no longer matches', async () => {
    const fixture = await pendingAttemptSix();
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    const options = { gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256,
      maxAttempts: fixture.options.maxAttempts, migrationPackage: fixture.options.migrationPackage,
      ownerAlive: fixture.options.ownerAlive, loadRetainedAsync: fixture.options.loadRetainedAsync };
    await finalizeOrdinaryPendingLaunch(options);
    const finalizedNative = await readFile(fixture.nativePath);

    const changed = JSON.parse(finalizedNative.toString('utf8'));
    changed.updatedAt = '2026-10-02T01:00:00.000Z';
    await writeFile(fixture.nativePath, `${JSON.stringify(changed, null, 2)}\n`);
    await expect(finalizeOrdinaryPendingLaunch(options))
      .rejects.toThrow('pending_legacy_resume_finalization_receipt_state_mismatch');

    await writeFile(fixture.nativePath, finalizedNative);
    const attemptBytes = await readFile(fixture.attemptsPath);
    const attempts = JSON.parse(attemptBytes.toString('utf8'));
    attempts.updatedAt = '2026-10-02T01:00:00.000Z';
    await writeFile(fixture.attemptsPath, `${JSON.stringify(attempts, null, 2)}\n`);
    await expect(finalizeOrdinaryPendingLaunch(options))
      .rejects.toThrow('pending_legacy_resume_finalization_receipt_state_mismatch');
  });

  it('refuses readback when retained archive bytes no longer match the authenticated receipt', async () => {
    const fixture = await pendingAttemptSix();
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    const options = { gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256,
      maxAttempts: fixture.options.maxAttempts, migrationPackage: fixture.options.migrationPackage,
      ownerAlive: fixture.options.ownerAlive, loadRetainedAsync: fixture.options.loadRetainedAsync };
    const first = await finalizeOrdinaryPendingLaunch(options);
    const nativeFinalized = await readFile(fixture.nativePath);
    const attemptsFinalized = await readFile(fixture.attemptsPath);
    await writeFile(join(fixture.common, 'rcl-converge-pending-recovery', first.receipt.sourceDigest,
      first.receipt.retainedAsyncSha256[0]!), 'tampered');

    await expect(finalizeOrdinaryPendingLaunch(options))
      .rejects.toThrow('pending_legacy_resume_async_binding_mismatch');
    expect(await readFile(fixture.nativePath)).toEqual(nativeFinalized);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsFinalized);
  });

  it('refuses a finalize-only cap mismatch before reading artifacts or changing state', async () => {
    const fixture = await pendingAttemptSix();
    const nativeBefore = await readFile(fixture.nativePath);
    const attemptsBefore = await readFile(fixture.attemptsPath);
    await expect(previewOrdinaryPendingLaunch({ ...fixture.options, maxAttempts: 7,
      previewMode: 'finalize-only' }))
      .rejects.toThrow('pending_legacy_resume_attempt_cap_mismatch');
    await expect(finalizeOrdinaryPendingLaunch({ gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: 'f'.repeat(64), attemptStateSha256: 'e'.repeat(64),
      retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 7,
      migrationPackage: fixture.options.migrationPackage, ownerAlive: fixture.options.ownerAlive,
      loadRetainedAsync: fixture.options.loadRetainedAsync }))
      .rejects.toThrow('pending_legacy_resume_attempt_cap_mismatch');
    await expect(finalizeOrdinaryPendingLaunch({ gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: 'f'.repeat(64), attemptStateSha256: 'e'.repeat(64),
      retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 20,
      migrationPackage: fixture.options.migrationPackage, ownerAlive: fixture.options.ownerAlive,
      loadRetainedAsync: fixture.options.loadRetainedAsync }))
      .rejects.toThrow('pending_legacy_resume_source_digest_mismatch');
    await expect(finalizeOrdinaryPendingLaunch({ gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: sha256Hex(nativeBefore), attemptStateSha256: sha256Hex(attemptsBefore),
      retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 20,
      migrationPackage: fixture.options.migrationPackage, ownerAlive: () => true,
      loadRetainedAsync: fixture.options.loadRetainedAsync }))
      .rejects.toThrow('pending_legacy_resume_owner_alive');
    expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    expect(fixture.options.loadRetainedAsync).not.toHaveBeenCalled();
  });

  it('refuses mismatched retained async bytes before any durable write', async () => {
    const fixture = await pendingAttemptSix();
    const nativeBefore = await readFile(fixture.nativePath);
    const attemptsBefore = await readFile(fixture.attemptsPath);
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    const loaderCalls = fixture.options.loadRetainedAsync.mock.calls.length;
    fixture.options.loadRetainedAsync.mockResolvedValue([{
      path: join(fixture.common, 'wrong.json'),
      sha256: fixture.options.retainedAsyncSha256[0]!,
      bytesBase64: Buffer.from('wrong').toString('base64'),
    }]);

    await expect(finalizeOrdinaryPendingLaunch({ gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 20,
      migrationPackage: fixture.options.migrationPackage, ownerAlive: fixture.options.ownerAlive,
      loadRetainedAsync: fixture.options.loadRetainedAsync }))
      .rejects.toThrow('pending_legacy_resume_async_binding_mismatch');

    expect(fixture.options.loadRetainedAsync).toHaveBeenCalledTimes(loaderCalls + 1);
    expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    await expect(access(join(fixture.common, 'rcl-converge-pending-recovery')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(fixture.common, 'rcl-converge-pending-finalizations')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes from a complete archive when native publication failed and the original store is gone', async () => {
    const fixture = await pendingAttemptSix();
    const nativeBefore = await readFile(fixture.nativePath);
    const attemptsBefore = await readFile(fixture.attemptsPath);
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    const writeFailure = vi.fn(async () => { throw new Error('injected_native_write_failure'); });
    const options = { gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 20,
      migrationPackage: fixture.options.migrationPackage, ownerAlive: fixture.options.ownerAlive,
      loadRetainedAsync: fixture.options.loadRetainedAsync, writeFinalizedState: writeFailure };

    await expect(finalizeOrdinaryPendingLaunch(options)).rejects.toThrow('injected_native_write_failure');
    expect(writeFailure).toHaveBeenCalledTimes(1);
    expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    const archive = join(fixture.common, 'rcl-converge-pending-recovery', preview.source.digest);
    expect((await readdir(archive)).sort())
      .toEqual([...fixture.options.retainedAsyncSha256, 'manifest.json'].sort());
    await expect(access(join(fixture.common, 'rcl-converge-pending-finalizations')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const originalLoads = fixture.options.loadRetainedAsync.mock.calls.length;
    fixture.options.loadRetainedAsync.mockRejectedValue(new Error('original async store is unavailable'));
    const resumed = await finalizeOrdinaryPendingLaunch({ ...options, writeFinalizedState: undefined });
    expect(resumed).toMatchObject({ reusedReceipt: false, snapshotBindingUpgraded: false,
      receipt: { finalizedAttempt: 6, attemptsUsed: 6, nextFreeAttempt: 7 } });
    expect(fixture.options.loadRetainedAsync).toHaveBeenCalledTimes(originalLoads);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
  });

  it.runIf(process.platform !== 'win32')('preflights native destination safety before archiving evidence', async () => {
    const fixture = await pendingAttemptSix();
    const nativeBefore = await readFile(fixture.nativePath);
    const attemptsBefore = await readFile(fixture.attemptsPath);
    const preview = await previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' });
    await chmod(dirname(fixture.nativePath), 0o777);

    await expect(finalizeOrdinaryPendingLaunch({ gitCommonDir: fixture.common, target: fixture.target,
      headSha: fixture.options.headSha, baseSha: fixture.options.baseSha,
      pendingInputSha256: fixture.options.pendingInputSha256,
      nativeStateSha256: preview.nativeStateSha256, attemptStateSha256: preview.attemptStateSha256,
      retainedAsyncSha256: fixture.options.retainedAsyncSha256, maxAttempts: 20,
      migrationPackage: fixture.options.migrationPackage, ownerAlive: fixture.options.ownerAlive,
      loadRetainedAsync: fixture.options.loadRetainedAsync }))
      .rejects.toThrow('unsafe_converge_state_directory');

    expect(await readFile(fixture.nativePath)).toEqual(nativeBefore);
    expect(await readFile(fixture.attemptsPath)).toEqual(attemptsBefore);
    await expect(access(join(fixture.common, 'rcl-converge-pending-recovery')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(fixture.common, 'rcl-converge-pending-finalizations')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a legacy package when native state claims a cycle before archiving evidence', async () => {
    const fixture = await pendingAttemptSix();
    const native = JSON.parse(await readFile(fixture.nativePath, 'utf8'));
    native.version = 2;
    native.cycle = { id: '0199a410-0000-7000-8000-000000000001',
      operationId: '0199a410-0000-7000-8000-000000000002', previousCycleId: null,
      repo: 'allocator-one/rcl', prNumber: 146, url: 'https://harness.infra.one',
      archivePath: join(fixture.common, 'missing-cycle-archive.json'),
      archiveSha256: 'e'.repeat(64), history: { attempts: 0, rounds: 0 } };
    await writeFile(fixture.nativePath, `${JSON.stringify(native, null, 2)}\n`);
    await expect(previewOrdinaryPendingLaunch({ ...fixture.options, previewMode: 'finalize-only' }))
      .rejects.toThrow('ordinary_pending_package_mismatch');
    await expect(access(join(fixture.common, 'rcl-converge-pending-recovery')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(fixture.common, 'rcl-converge-pending-finalizations')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
