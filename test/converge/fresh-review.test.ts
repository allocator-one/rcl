import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('starts unchanged inputs with a normal budget while retaining the original 17 attempts and 13 rounds', async () => {
  const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-fresh-review-'));
  roots.push(gitCommonDir);
  const target = 'rcl-42', headSha = 'a'.repeat(40), inputSha256 = 'b'.repeat(64);
  const at = new Date().toISOString();
  const attemptsPath = convergeAttemptStatePath(gitCommonDir, target);
  const runPath = convergeRunStatePath(gitCommonDir, target);
  const oldAttempts = Buffer.from(JSON.stringify({ version: 2, target, cap: 27, migratedAttempts: 0, attemptsUsed: 17,
    attempts: Array.from({ length: 17 }, (_, i) => ({ attempt: i + 1, claimedAt: at, pid: 99999999, source: 'claim' })), updatedAt: at }));
  const oldRun = Buffer.from(JSON.stringify({ version: 1, target, roundCap: 26, findings: {}, updatedAt: at,
    rounds: Array.from({ length: 13 }, (_, i) => ({ round: i + 1, runId: randomUUID(), counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 } })),
    lastAnnotations: { round: 13, identities: [] },
    lastLaunch: { status: 'completed', attempt: 17, round: 14, headSha, inputSha256, startedAt: at, pid: 99999999,
      runId: randomUUID(), reportJsonSha256: 'c'.repeat(64), successfulReviews: 2, totalReviews: 2, deliveryPending: false } }));
  for (const [path, bytes] of [[attemptsPath, oldAttempts], [runPath, oldRun]] as const) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
  }
  let active: import('../../src/converge/review-cycle.js').ReviewCycleReceipt | null = null;
  const cycleRemote = { repo: 'allocator-one/rcl', prNumber: 42, url: 'https://harness.example',
    current: vi.fn(async () => active),
    start: vi.fn(async (request: import('../../src/converge/review-cycle.js').ReviewCycleRequest) => {
      active = { ...request, id: randomUUID(), inserted_at: at }; return active;
    }) };
  const run = vi.fn(async () => ({ runId: randomUUID(), reportJsonSha256: 'd'.repeat(64),
    successfulReviews: 2, totalReviews: 2, deliveryPending: false }));

  await guardReviewLaunch({ gitCommonDir, target, headSha, inputSha256, validate: async () => {}, run,
    startOver: true, cycleRemote });

  const state = await loadConvergeRunState(gitCommonDir, target);
  expect(state).toMatchObject({ version: 2, roundCap: 15, rounds: [], findings: {},
    cycle: { id: active!.id, history: { attempts: 17, rounds: 13 } } });
  expect(await loadConvergeAttemptState(gitCommonDir, target)).toMatchObject({ version: 3, cap: 20, attemptsUsed: 1,
    cycle: state!.cycle });
  expect(run).toHaveBeenCalledWith({ target, round: 1, attempt: 1, cycleId: active!.id });
  expect(cycleRemote.start).toHaveBeenCalledTimes(1);
  const archive = JSON.parse(await readFile(state!.cycle!.archivePath, 'utf8'));
  expect(Buffer.from(archive.files.attempts.bytes, 'base64')).toEqual(oldAttempts);
  expect(Buffer.from(archive.files.run.bytes, 'base64')).toEqual(oldRun);
});

async function freshFixture() {
  const gitCommonDir = await mkdtemp(join(tmpdir(), 'rcl-fresh-review-'));
  roots.push(gitCommonDir);
  let active: import('../../src/converge/review-cycle.js').ReviewCycleReceipt | null = null;
  const cycleRemote = { repo: 'allocator-one/rcl', prNumber: 42, url: 'https://harness.example',
    current: vi.fn(async () => active),
    start: vi.fn(async (request: import('../../src/converge/review-cycle.js').ReviewCycleRequest) => {
      active = { ...request, id: randomUUID(), inserted_at: new Date().toISOString() }; return active;
    }) };
  const completion = { runId: randomUUID(), reportJsonSha256: 'd'.repeat(64), successfulReviews: 2, totalReviews: 2, deliveryPending: false };
  return { gitCommonDir, target: 'rcl-42', headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
    validate: vi.fn(async () => {}), run: vi.fn(async () => completion), startOver: true, cycleRemote, completion };
}

it('replays one durable operation after a lost acknowledgement and never restores old cap overrides', async () => {
  const options = await freshFixture();
  const start = options.cycleRemote.start.getMockImplementation()!;
  options.cycleRemote.start.mockImplementationOnce(async request => { await start(request); throw new Error('lost acknowledgement'); });
  await expect(guardReviewLaunch(options)).rejects.toThrow('lost acknowledgement');
  expect(options.run).not.toHaveBeenCalled();
  await expect(guardReviewLaunch({ ...options, startOver: false })).rejects.toThrow('fresh_review_pending');
  options.cycleRemote.start.mockImplementationOnce(async () => (await options.cycleRemote.current())!);
  await guardReviewLaunch(options);
  expect(options.cycleRemote.start.mock.calls[1][0]).toEqual(options.cycleRemote.start.mock.calls[0][0]);
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ cap: 20, attemptsUsed: 1 });
});

it('does not create a cycle or change accounting when preflight fails', async () => {
  const options = await freshFixture();
  options.validate.mockRejectedValueOnce(new Error('missing provider'));
  await expect(guardReviewLaunch(options)).rejects.toThrow('missing provider');
  expect(options.cycleRemote.start).not.toHaveBeenCalled();
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toBeUndefined();
});

it('retains cumulative spending through successive explicit cycles', async () => {
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const first = await loadConvergeRunState(options.gitCommonDir, options.target);
  await guardReviewLaunch(options);
  const second = await loadConvergeRunState(options.gitCommonDir, options.target);
  expect(second!.cycle).toMatchObject({ previousCycleId: first!.cycle!.id, history: { attempts: 1, rounds: 0 } });
  expect(second!.cycle!.id).not.toBe(first!.cycle!.id);
  expect(await readFile(first!.cycle!.archivePath)).toBeTruthy();
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 1 });
});

it('does not replenish the budget on ordinary continuation and rejects a report from a retired cycle', async () => {
  const { processRoundReport } = await import('../../src/converge/run-state.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const first = await loadConvergeRunState(options.gitCommonDir, options.target);
  const report = { gitCommonDir: options.gitCommonDir, target: options.target, round: 1, findings: [],
    runId: options.completion.runId, reportSha256: options.completion.reportJsonSha256, cycleId: first!.cycle!.id };
  await processRoundReport(report);
  await guardReviewLaunch({ ...options, startOver: false, headSha: 'c'.repeat(40) });
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 2 });
  await guardReviewLaunch(options);
  await expect(processRoundReport(report)).rejects.toThrow('review_cycle_mismatch');
  expect((await loadConvergeRunState(options.gitCommonDir, options.target))!.rounds).toEqual([]);
});

it('requires the current completed launch and its digest for fresh-cycle admission', async () => {
  const { processRoundReport } = await import('../../src/converge/run-state.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const state = await loadConvergeRunState(options.gitCommonDir, options.target);
  await expect(processRoundReport({ gitCommonDir: options.gitCommonDir, target: options.target, round: 1, findings: [],
    runId: randomUUID(), reportSha256: options.completion.reportJsonSha256, cycleId: state!.cycle!.id })).rejects.toThrow('review_cycle_launch_mismatch');
  await expect(processRoundReport({ gitCommonDir: options.gitCommonDir, target: options.target, round: 1, findings: [],
    runId: options.completion.runId, reportSha256: 'e'.repeat(64), cycleId: state!.cycle!.id })).rejects.toThrow('review_cycle_launch_mismatch');
});

it('restores exact prior bytes after a definite noncommit and permits a later explicit request', async () => {
  const { ReviewCycleRejected } = await import('../../src/converge/cycle-remote.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const path = convergeAttemptStatePath(options.gitCommonDir, options.target);
  const before = await readFile(path);
  options.cycleRemote.start.mockRejectedValueOnce(new ReviewCycleRejected('Fresh review refused: head_changed'));
  await expect(guardReviewLaunch(options)).rejects.toThrow('head_changed');
  expect(await readFile(path)).toEqual(before);
  expect(options.run).toHaveBeenCalledTimes(1);
  await guardReviewLaunch(options);
  expect(options.run).toHaveBeenCalledTimes(2);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 1, cycle: { history: { attempts: 1 } } });
});

it('returns a completed dispatch after a crash before the terminal journal without claiming again', async () => {
  const { reviewCycleDirectory } = await import('../../src/converge/fresh-review.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const state = await loadConvergeRunState(options.gitCommonDir, options.target);
  const operationPath = join(reviewCycleDirectory(options.gitCommonDir, options.target), `${state!.cycle!.operationId}.json`);
  const operation = JSON.parse(await readFile(operationPath, 'utf8'));
  await writeFile(operationPath, JSON.stringify({ ...operation, phase: 'active' }));
  options.validate.mockRejectedValueOnce(new Error('output already exists'));
  const result = await guardReviewLaunch(options);
  expect(result.resumedCompletion).toEqual(options.completion);
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 1 });
});

it('refuses a missing native partner rather than migrating old spending into a new budget', async () => {
  const { claimConvergeAttempt } = await import('../../src/converge/attempt-budget.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  await rm(convergeAttemptStatePath(options.gitCommonDir, options.target));
  await expect(claimConvergeAttempt(options)).rejects.toThrow('fresh_review_state_pair_mismatch');
  await expect(guardReviewLaunch(options)).rejects.toThrow('fresh_review_state_pair_mismatch');
  expect(options.run).toHaveBeenCalledTimes(1);
});

it('requires a run-bound verdict after round numbers restart', async () => {
  const { processRoundReport, recordVerdicts } = await import('../../src/converge/run-state.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const state = await loadConvergeRunState(options.gitCommonDir, options.target);
  await processRoundReport({ ...options, round: 1, findings: [], runId: options.completion.runId,
    reportSha256: options.completion.reportJsonSha256, cycleId: state!.cycle!.id });
  await expect(recordVerdicts({ ...options, round: 1, verdicts: [] })).rejects.toThrow('review_cycle_verdict_run_mismatch');
  await expect(recordVerdicts({ ...options, round: 1, verdicts: [], runId: randomUUID() })).rejects.toThrow('review_cycle_verdict_run_mismatch');
  expect(await recordVerdicts({ ...options, round: 1, verdicts: [], runId: options.completion.runId })).toMatchObject({ runId: options.completion.runId });
});

it('does not turn a concurrent fresh request into another budget after the owner completes', async () => {
  const options = await freshFixture();
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  options.run.mockImplementationOnce(async () => { entered(); await pending; return options.completion; });
  const first = guardReviewLaunch(options);
  await started;
  const second = guardReviewLaunch(options);
  // Give the second invocation time to observe the active operation and wait for ownership.
  await new Promise(resolve => setTimeout(resolve, 100));
  release();
  await first;
  await expect(second).rejects.toThrow('fresh_review_request_changed');
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
});

it('resumes an interrupted dispatch in the same cycle without asking for a fabricated retry reason', async () => {
  const { reviewCycleDirectory } = await import('../../src/converge/fresh-review.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const runPath = convergeRunStatePath(options.gitCommonDir, options.target);
  const state = (await loadConvergeRunState(options.gitCommonDir, options.target))!;
  const operationPath = join(reviewCycleDirectory(options.gitCommonDir, options.target), `${state.cycle!.operationId}.json`);
  await writeFile(operationPath, JSON.stringify({ ...JSON.parse(await readFile(operationPath, 'utf8')), phase: 'active' }));
  await writeFile(runPath, JSON.stringify({ ...state, lastLaunch: { ...state.lastLaunch, status: 'pending' } }));
  await guardReviewLaunch(options);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
  expect(options.run).toHaveBeenCalledTimes(2);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 2, cap: 20, cycle: { id: state.cycle!.id } });
});

it('starts over after the old cap is exhausted but never replenishes an ordinary continuation', async () => {
  const { processRoundReport } = await import('../../src/converge/run-state.js');
  const options = await freshFixture();
  await guardReviewLaunch({ ...options, maxAttempts: 1 });
  const first = (await loadConvergeRunState(options.gitCommonDir, options.target))!;
  await processRoundReport({ ...options, round: 1, findings: [], runId: options.completion.runId,
    reportSha256: options.completion.reportJsonSha256, cycleId: first.cycle!.id });
  await expect(guardReviewLaunch({ ...options, startOver: false, headSha: 'e'.repeat(40) })).rejects.toThrow('budget exhausted');
  expect(options.run).toHaveBeenCalledTimes(1);
  await guardReviewLaunch(options);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ cap: 20, attemptsUsed: 1, cycle: { history: { attempts: 1, rounds: 1 } } });
});

it.each(['unresolved', 'dismissed'])('makes repeated %s findings actionable in a fresh cycle', async prior => {
  const { processRoundReport, recordVerdicts } = await import('../../src/converge/run-state.js');
  const { sampleFinding } = await import('../telemetry/fixtures.js');
  const options = await freshFixture();
  const finding = sampleFinding();
  await guardReviewLaunch(options);
  const first = (await loadConvergeRunState(options.gitCommonDir, options.target))!;
  const report = { ...options, round: 1, findings: [finding], runId: options.completion.runId,
    reportSha256: options.completion.reportJsonSha256, cycleId: first.cycle!.id };
  const old = await processRoundReport(report);
  if (prior === 'dismissed') await recordVerdicts({ ...options, round: 1, runId: options.completion.runId,
    verdicts: [{ key: old.findings[0].identity, verdict: 'dismissed', reason: 'Prior evidence only' }] });
  await guardReviewLaunch(options);
  const next = (await loadConvergeRunState(options.gitCommonDir, options.target))!;
  const fresh = await processRoundReport({ ...report, cycleId: next.cycle!.id });
  expect(fresh.findings[0].status).toBe('new');
  expect((await loadConvergeRunState(options.gitCommonDir, options.target))!.findings[fresh.findings[0].identity].verdict).toBeUndefined();
});

it('admits a conclusive partial fleet but refuses an inconclusive fresh report', async () => {
  const { processRoundReport } = await import('../../src/converge/run-state.js');
  const options = await freshFixture();
  options.run.mockResolvedValue({ ...options.completion, totalReviews: 3, successfulReviews: 2, hardFailure: true } as never);
  await guardReviewLaunch(options);
  const state = (await loadConvergeRunState(options.gitCommonDir, options.target))!;
  await expect(processRoundReport({ ...options, round: 1, findings: [], runId: options.completion.runId,
    reportSha256: options.completion.reportJsonSha256, cycleId: state.cycle!.id })).resolves.toMatchObject({ counts: { new: 0 } });
  options.run.mockResolvedValue({ ...options.completion, totalReviews: 3, successfulReviews: 1 });
  await guardReviewLaunch(options);
  const next = (await loadConvergeRunState(options.gitCommonDir, options.target))!;
  await expect(processRoundReport({ ...options, round: 1, findings: [], runId: options.completion.runId,
    reportSha256: options.completion.reportJsonSha256, cycleId: next.cycle!.id })).rejects.toThrow('review_cycle_launch_mismatch');
});

it('resumes after one fresh native file was activated without rewriting its counters', async () => {
  const { prepareFreshReview, reviewCycleDirectory } = await import('../../src/converge/fresh-review.js');
  const { withNativeTarget } = await import('../../src/converge/target-ownership.js');
  const options = await freshFixture();
  const fresh = await withNativeTarget(options.gitCommonDir, options.target, ownership => prepareFreshReview({ ...options, remote: options.cycleRemote, ownership }));
  const operationPath = join(reviewCycleDirectory(options.gitCommonDir, options.target), `${fresh.operationId}.json`);
  await writeFile(operationPath, JSON.stringify({ ...JSON.parse(await readFile(operationPath, 'utf8')), phase: 'recorded' }));
  await writeFile(convergeRunStatePath(options.gitCommonDir, options.target), JSON.stringify({ version: 2, target: options.target, startOverPending: fresh.operationId }));
  await guardReviewLaunch(options);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 1, cycle: { id: fresh.cycle.id } });
});

it('retains a claim interrupted before pending-launch publication and resumes within the same budget', async () => {
  const { prepareFreshReview } = await import('../../src/converge/fresh-review.js');
  const { withNativeTarget } = await import('../../src/converge/target-ownership.js');
  const { claimConvergeAttempt } = await import('../../src/converge/attempt-budget.js');
  const options = await freshFixture();
  await withNativeTarget(options.gitCommonDir, options.target, async ownership => {
    const fresh = await prepareFreshReview({ ...options, remote: options.cycleRemote, ownership });
    await claimConvergeAttempt({ ...options, ownership, freshReviewOperation: fresh.operationId });
  });
  await guardReviewLaunch(options);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 2 });
});

it('stops a superseded interrupted operation and allows a later explicit fresh request', async () => {
  const options = await freshFixture();
  let active: import('../../src/converge/review-cycle.js').ReviewCycleReceipt | null = null;
  options.cycleRemote.current.mockImplementation(async () => active);
  options.cycleRemote.start.mockImplementation(async request => {
    active = { ...request, id: randomUUID(), inserted_at: new Date().toISOString() }; return active;
  });
  options.cycleRemote.start.mockImplementationOnce(async request => {
    const original = { ...request, id: randomUUID(), inserted_at: new Date().toISOString() };
    active = { ...original, id: randomUUID(), operation_id: randomUUID(), previous_cycle_id: original.id };
    return original;
  });
  await expect(guardReviewLaunch(options)).rejects.toThrow('fresh_review_superseded');
  const winner = active!.id;
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
  expect(options.run).not.toHaveBeenCalled();
  // A later intentional request is distinct; the failed call itself never retires the winner.
  await guardReviewLaunch(options);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(2);
  expect(options.cycleRemote.start.mock.calls[1]![0].previous_cycle_id).toBe(winner);
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ cap: 20, attemptsUsed: 1 });
});

it('supports RCL-106 stale continuation inside a fresh cycle and refuses its manifest after another start-over', async () => {
  const { sampleResult, sampleReview } = await import('../telemetry/fixtures.js');
  const { previewStaleReport, applyStaleReport } = await import('../../src/converge/stale-report.js');
  const { sha256 } = await import('../../src/telemetry/recovery/files.js');
  const options = await freshFixture();
  const reportPath = join(options.gitCommonDir, 'original.json');
  options.run.mockImplementationOnce(async (context: any) => {
    const report = sampleResult({ reviews: [sampleReview(), sampleReview({ model: 'openai/fixture' })] });
    report.run!.converge = { target: context.target, round: context.round, attempt: context.attempt };
    report.run!.cycle_id = context.cycleId;
    report.run!.target.head_sha = options.headSha;
    report.stats.successfulReviews = report.stats.totalReviews = 2;
    await writeFile(reportPath, JSON.stringify(report));
    return { ...options.completion, runId: report.run!.id, reportJsonSha256: sha256(await readFile(reportPath)) };
  });
  await guardReviewLaunch(options);
  const bytes = await readFile(reportPath);
  const manifest = await previewStaleReport({ target: options.target, headSha: 'c'.repeat(40), inputSha256: 'd'.repeat(64),
    reportPath, reportSha256: sha256(bytes), reason: 'Current committed inputs supersede this report' }, options.gitCommonDir);
  const manifestPath = join(options.gitCommonDir, 'stale.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const request = { manifest: manifestPath, manifestSha256: sha256(await readFile(manifestPath)), mode: 'apply' as const };
  await applyStaleReport(request, options.gitCommonDir);
  await guardReviewLaunch({ ...options, startOver: false, headSha: 'c'.repeat(40), inputSha256: 'd'.repeat(64) });
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 2 });
  await guardReviewLaunch(options);
  await expect(applyStaleReport(request, options.gitCommonDir)).rejects.toThrow();
  expect(await readFile(reportPath)).toEqual(bytes);
});

it('refuses standalone spending while a fresh operation is unfinished', async () => {
  const { prepareFreshReview } = await import('../../src/converge/fresh-review.js');
  const { withNativeTarget } = await import('../../src/converge/target-ownership.js');
  const { claimConvergeAttempt } = await import('../../src/converge/attempt-budget.js');
  const options = await freshFixture();
  await withNativeTarget(options.gitCommonDir, options.target, ownership => prepareFreshReview({ ...options, remote: options.cycleRemote, ownership }));
  await expect(claimConvergeAttempt(options)).rejects.toThrow('fresh_review_pending');
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 0 });
});


it('reconciles delivered evidence only for the current cycle launch without changing its budget', async () => {
  const { reconcileDeliveredRun } = await import('../../src/converge/delivery-reconciliation.js');
  const options = await freshFixture();
  options.run.mockResolvedValue({ ...options.completion, deliveryPending: true });
  await guardReviewLaunch(options);
  const cycle = (await loadConvergeRunState(options.gitCommonDir, options.target))!.cycle;
  const getRun = vi.fn().mockResolvedValue({ kind: 'ok', value: {
    id: options.completion.runId, converge: { target: options.target, round: 1, attempt: 1 },
    target: { kind: 'pull_request', head_sha: options.headSha },
    artifacts: [{ kind: 'report_json', stored: true, declared_sha256: options.completion.reportJsonSha256 }], findings: [], calls: [] } });
  expect(await reconcileDeliveredRun(options.completion.runId, {} as never, { gitCommonDir: options.gitCommonDir, getRun })).toBe('reconciled');
  expect(await loadConvergeRunState(options.gitCommonDir, options.target)).toMatchObject({ cycle, lastLaunch: { deliveryPending: false } });
  const nextId = randomUUID();
  options.run.mockResolvedValue({ ...options.completion, runId: nextId, deliveryPending: true });
  await guardReviewLaunch(options);
  expect(await reconcileDeliveredRun(options.completion.runId, {} as never, { gitCommonDir: options.gitCommonDir, getRun })).toBe('unchanged');
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ cap: 20, attemptsUsed: 1 });
  expect(await loadConvergeRunState(options.gitCommonDir, options.target)).toMatchObject({ lastLaunch: { runId: nextId, deliveryPending: true } });
});

it('ends an interrupted exhausted operation without refunding its unknown dispatch or spending again', async () => {
  const { prepareFreshReview, reviewCycleDirectory } = await import('../../src/converge/fresh-review.js');
  const { withNativeTarget } = await import('../../src/converge/target-ownership.js');
  const { claimConvergeAttempt } = await import('../../src/converge/attempt-budget.js');
  const options = await freshFixture();
  const fresh = await withNativeTarget(options.gitCommonDir, options.target, async ownership => {
    const operation = await prepareFreshReview({ ...options, maxAttempts: 1, remote: options.cycleRemote, ownership });
    await claimConvergeAttempt({ ...options, ownership, freshReviewOperation: operation.operationId });
    return operation;
  });
  const before = await readFile(convergeAttemptStatePath(options.gitCommonDir, options.target));
  await expect(guardReviewLaunch(options)).rejects.toThrow('budget exhausted');
  expect(await readFile(convergeAttemptStatePath(options.gitCommonDir, options.target))).toEqual(before);
  expect(options.run).not.toHaveBeenCalled();
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(join(reviewCycleDirectory(options.gitCommonDir, options.target), `${fresh.operationId}.json`), 'utf8')).phase).toBe('terminal');
  await guardReviewLaunch(options);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(2);
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ cap: 20, attemptsUsed: 1, cycle: { history: { attempts: 1 } } });
});

it('retires a changed-head unfinished operation after recovering its receipt without new reviewer work', async () => {
  const options = await freshFixture();
  const start = options.cycleRemote.start.getMockImplementation()!;
  options.cycleRemote.start.mockImplementationOnce(async request => { await start(request); throw new Error('lost acknowledgement'); });
  await expect(guardReviewLaunch(options)).rejects.toThrow('lost acknowledgement');
  options.cycleRemote.start.mockImplementationOnce(async () => (await options.cycleRemote.current())!);
  await expect(guardReviewLaunch({ ...options, headSha: 'c'.repeat(40) })).rejects.toThrow('fresh_review_operation_head_changed');
  expect(options.cycleRemote.start.mock.calls[1][0]).toEqual(options.cycleRemote.start.mock.calls[0][0]);
  expect(options.run).not.toHaveBeenCalled();
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 0 });
  await guardReviewLaunch({ ...options, headSha: 'c'.repeat(40) });
  expect(options.run).toHaveBeenCalledTimes(1);
});

it('does not replay an older completed report as a changed-head unfinished request', async () => {
  const { reviewCycleDirectory } = await import('../../src/converge/fresh-review.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const state = (await loadConvergeRunState(options.gitCommonDir, options.target))!;
  const path = join(reviewCycleDirectory(options.gitCommonDir, options.target), `${state.cycle!.operationId}.json`);
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, 'utf8')), phase: 'active' }));
  await expect(guardReviewLaunch({ ...options, headSha: 'c'.repeat(40) })).rejects.toThrow('fresh_review_operation_head_changed');
  expect(await loadConvergeRunState(options.gitCommonDir, options.target)).toEqual(state);
  expect(options.run).toHaveBeenCalledTimes(1);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
});

it('refuses an oversized encoded archive before publishing an operation or changing prior spending', async () => {
  const { reviewCycleDirectory } = await import('../../src/converge/fresh-review.js');
  const options = await freshFixture();
  await guardReviewLaunch(options);
  const runPath = convergeRunStatePath(options.gitCommonDir, options.target);
  const attemptPath = convergeAttemptStatePath(options.gitCommonDir, options.target);
  const pointerPath = join(reviewCycleDirectory(options.gitCommonDir, options.target), 'current.json');
  const before = await Promise.all([runPath, attemptPath, pointerPath].map(path => readFile(path)));
  const ledger = join(options.gitCommonDir, `rcl-converge-${options.target}-ledger.md`);
  await writeFile(ledger, Buffer.alloc(49 * 1024 * 1024, 32));
  await expect(guardReviewLaunch(options)).rejects.toThrow('fresh_review_archive_too_large');
  expect(await Promise.all([runPath, attemptPath, pointerPath].map(path => readFile(path)))).toEqual(before);
  expect(options.cycleRemote.start).toHaveBeenCalledTimes(1);
  expect(options.run).toHaveBeenCalledTimes(1);
  await rm(ledger);
  await guardReviewLaunch(options);
  expect(await loadConvergeAttemptState(options.gitCommonDir, options.target)).toMatchObject({ attemptsUsed: 1, cycle: { history: { attempts: 1 } } });
});
