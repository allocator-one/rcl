import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { guardRetainedOriginal } from '../../src/evidence/reviewer-original.js';
import { guardReviewLaunch } from '../../src/converge/launch-guard.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { processRoundReport, loadConvergeRunState, convergeRunStatePath } from '../../src/converge/run-state.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { executeCapturedOriginal } from '../../src/dispatch/original-execution.js';
import { decodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { captureAggregationInputs } from '../../src/report/aggregation-inputs.js';
import { configDigest, diffDigest, sha256Hex, stableStringify } from '../../src/report/run-header.js';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = 'allocator-one/rcl#105', runId = '11111111-1111-4111-8111-111111111111';
const oldRunId = '22222222-2222-4222-8222-222222222222';
const finish = { runId, reportJsonSha256: 'c'.repeat(64), successfulReviews: 2, totalReviews: 2, deliveryPending: false };
const capability = () => new Response(JSON.stringify({ data: { models: [] }, meta: { reviewer_recovery_protocol: 1, reviewer_artifact_schema: 1, reviewer_artifact_max_bytes: 25_000_000 } }), { status: 200 });
async function fixture(): Promise<any> {
  const commonDir = await mkdtemp(join(tmpdir(), 'rcl-original-')); roots.push(commonDir);
  const files = [{ filename: 'a.ts', status: 'modified' as const, patch: '@@\n+x', additions: 1, deletions: 0, language: 'typescript' }];
  const config = { concurrency: 1, maxRetries: 0, quorumFraction: 2 / 3, thresholds: { minConsensusScore: 0, minConfidence: 0, dedupeLineWindow: 3, jaccardThreshold: 0.3 }, output: { belowThresholdAppendix: true } };
  const tools = stableStringify({ parser: { name: 'findings-json', version: 1 }, aggregation: { name: 'consensus', version: 2 } });
  const role = { name: 'general', systemPrompt: 'Review.', focus: [], description: 'General', isSpecialized: false };
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: diffDigest(files),
    configSha256: configDigest(config), specSha256: sha256Hex('spec'), contextSha256: sha256Hex('[]'), toolsSha256: sha256Hex(tools),
    parser: { name: 'findings-json', version: 1 }, roster: ['a', 'b'].map(seat => ({ seat, model: `model-${seat}`, role: 'general', route: 'fake' })),
    chunks: [{ index: 0, total: 1, digest: sha256Hex('chunk') }], prompts: ['a', 'b'].map(seat => ({ seat, chunk: 0, systemSha256: sha256Hex('Review.'), userSha256: sha256Hex(`prompt-${seat}`) })) });
  const captured = captureReviewerInputs({ plan, policy: { version: 1, fraction: 2 / 3 }, patchBytes: stableStringify(files.map(({ language: _language, ...file }) => ({ ...file, previousFilename: null, blobSha: null }))), configBytes: stableStringify(config), specBytes: 'spec', contextBytes: '[]', toolsBytes: tools, chunkBytes: ['chunk'],
    assignments: plan.cells.map(cell => ({ model: cell.model, provider: cell.route, role })), prompts: plan.cells.map(cell => ({ systemPrompt: 'Review.', userPrompt: `prompt-${cell.seat}` })),
    aggregation: captureAggregationInputs({ algorithm: { name: 'consensus', version: 2 }, diffSha256: plan.patchSha256, roleMap: new Map([[role.name, role]]), thresholds: config.thresholds, gating: { mode: 'all-findings', minModels: 2, verificationTimeoutMs: 100, verificationPassTimeoutMs: 100 }, belowThresholdAppendix: true }) });
  const now = Date.now();
  return { guard: { gitCommonDir: commonDir, target, maxAttempts: 5, maxRounds: 5 }, captured, diff: { source: 'local', files }, effectiveMergeBaseSha: plan.mergeBaseSha,
    run: { id: runId, rclVersion: 'test', command: 'review', target: { kind: 'patch', repo: 'allocator-one/rcl', prNumber: 105, headSha: plan.headSha, baseSha: plan.mergeBaseSha }, roster: plan.roster.map(seat => ({ model: seat.model, role: seat.role, provider: seat.route, lane: 'blocking' })), spec: { source: 'flag', sha256: plan.specSha256 }, contextFiles: [], runner: { kind: 'agent' }, startedAt: new Date(now) },
    bounds: { startedAtMs: now, expiresAtMs: now + 30_000, maxPhysicalCalls: 2, maxAttemptsPerCell: 1 }, access: { kind: 'local' }, validate: vi.fn(async () => {}), execute: vi.fn(async () => finish) };
}
async function seed(options: any) {
  await guardReviewLaunch({ ...options.guard, headSha: 'd'.repeat(40), inputSha256: 'e'.repeat(64), validate: async () => {}, run: async () => ({ ...finish, runId: oldRunId }) });
  await processRoundReport({ gitCommonDir: options.guard.gitCommonDir, target, round: 1, findings: [], runId: oldRunId, reportSha256: finish.reportJsonSha256 });
}
function protectedAccess(options: any, fetchImpl: typeof fetch) {
  options.run.target.kind = 'pr'; options.run.target.baseSha = 'c'.repeat(40); options.diff.source = 'github';
  options.diff.metadata = { owner: 'allocator-one', repo: 'rcl', number: 105, baseSha: options.run.target.baseSha, headSha: options.captured.plan.headSha, mergeBaseSha: options.captured.plan.mergeBaseSha };
  return { kind: 'protected', attestation: { runId, credential: { source: 'attest', token: 'rbc_fixture', url: 'https://harness.invalid' }, expiresAt: new Date(options.bounds.expiresAtMs).toISOString() }, fetchImpl };
}

describe('retained original owned launch coordinator', () => {
  it('refuses preflight that consumes the reserved paid window before native claim', async () => {
    const options = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(options.bounds.startedAtMs);
    options.access = protectedAccess(options, vi.fn(async () => { vi.setSystemTime(options.bounds.startedAtMs + 23000); return capability(); }) as typeof fetch);
    await expect(guardRetainedOriginal(options)).rejects.toThrow();
    expect(options.execute).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.guard.gitCommonDir, target)).toBeUndefined();
  });

  it('refuses a tiny new lifetime before capability, native claim or provider work', async () => {
    const options = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(options.bounds.startedAtMs);
    options.bounds.expiresAtMs = options.bounds.startedAtMs + 3;
    options.access = protectedAccess(options, vi.fn(async () => capability()) as typeof fetch);
    await expect(guardRetainedOriginal(options)).rejects.toThrow('retained_execution_budget');
    expect(options.access.fetchImpl).not.toHaveBeenCalled(); expect(options.execute).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.guard.gitCommonDir, target)).toBeUndefined();
  });
  it('uses the actual non-one guard claim and the SAME immutable launch bytes/header/journal', async () => {
    const options = await fixture(); await seed(options); options.requireExistingNativeState = true;
    let prepared: any;
    options.beforeClaim = async (value: any) => { prepared = value; expect((await loadConvergeAttemptState(options.guard.gitCommonDir, target))?.attemptsUsed).toBe(1); };
    options.execute = async (value: any) => {
      expect(value.prepared).toBe(prepared); expect(value.launch).toBe(prepared.launch);
      expect(value.run.converge).toEqual({ target, attempt: 2, round: 2 }); expect(value.run.id).toBe(runId);
      expect((await value.journal.readBindings()).launch).toBe(prepared.launchBytes);
      expect(decodeOriginalLaunch(prepared.launchBytes).originalNativeClaim).toEqual({ attempt: 2, round: 2 });
      expect((await value.journal.read()).records.filter((record: any) => record.type === 'intent')).toHaveLength(0); return finish;
    };
    expect(await guardRetainedOriginal(options)).toMatchObject({ attempt: 2, cap: 5 });
    expect(await loadConvergeRunState(options.guard.gitCommonDir, target)).toMatchObject({ lastLaunch: { runId, attempt: 2, round: 2, status: 'completed' } });
  });
  it('allows a genuine first protected original with actual credential capability before the claim', async () => {
    const options = await fixture(); const fetchImpl = vi.fn(async (_url: any, init: any) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer rbc_fixture');
      expect(await loadConvergeAttemptState(options.guard.gitCommonDir, target)).toBeUndefined(); return capability();
    }); options.access = protectedAccess(options, fetchImpl as typeof fetch);
    options.execute = async (value: any) => { expect(value.run.converge).toEqual({ target, attempt: 1, round: 1 }); expect(value.delivery).toBeDefined(); return finish; };
    expect(await guardRetainedOriginal(options)).toMatchObject({ attempt: 1 }); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('checks the asserted current credential without spending an attempt on unsupported capability', async () => {
    const options = await fixture(); await seed(options); const before = await readFile(convergeRunStatePath(options.guard.gitCommonDir, target));
    options.access = { kind: 'asserted', credential: { source: 'login', token: 'current-fixture', url: 'https://harness.invalid' }, fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) };
    await expect(guardRetainedOriginal(options)).rejects.toThrow('capability'); expect(options.execute).not.toHaveBeenCalled();
    expect((await loadConvergeAttemptState(options.guard.gitCommonDir, target))?.attemptsUsed).toBe(1);
    expect(await readFile(convergeRunStatePath(options.guard.gitCommonDir, target))).toEqual(before);
  });
  it('refuses continuation without the original native ledger instead of rebuilding its counters', async () => {
    const options = await fixture(); options.requireExistingNativeState = true;
    options.access = protectedAccess(options, vi.fn(async () => capability()) as typeof fetch);
    await expect(guardRetainedOriginal(options)).rejects.toThrow('native_state'); expect(options.execute).not.toHaveBeenCalled();
    expect(options.access.fetchImpl).not.toHaveBeenCalled(); expect(await loadConvergeAttemptState(options.guard.gitCommonDir, target)).toBeUndefined();
  });
  it.each(['base', 'patch', 'roster', 'spec', 'context', 'head', 'pr', 'capture'])('rejects changed %s bindings before preflight/native/provider work', async kind => {
    const options = await fixture(); options.access = protectedAccess(options, vi.fn(async () => capability()) as typeof fetch);
    if (kind === 'base') options.effectiveMergeBaseSha = 'c'.repeat(40);
    if (kind === 'patch') options.diff.files[0].patch = 'changed';
    if (kind === 'roster') options.run.roster.reverse();
    if (kind === 'spec') options.run.spec.sha256 = '0'.repeat(64);
    if (kind === 'context') options.run.contextFiles = [{ path: 'borrowed', sha256: '0'.repeat(64) }];
    if (kind === 'head') options.run.target.headSha = '0'.repeat(40);
    if (kind === 'pr') options.run.target.prNumber++;
    if (kind === 'capture') options.captured = { ...options.captured, bytes: options.captured.bytes.replace('Review.', 'Forged.') };
    await expect(guardRetainedOriginal(options)).rejects.toThrow(); expect(options.access.fetchImpl).not.toHaveBeenCalled(); expect(options.execute).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.guard.gitCommonDir, target)).toBeUndefined();
  });
  it('never extends credential expiry and rechecks it after preflight before claiming', async () => {
    const options = await fixture(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(options.bounds.startedAtMs);
    options.access = protectedAccess(options, vi.fn(async () => { vi.setSystemTime(options.bounds.startedAtMs + 1000); return capability(); }) as typeof fetch);
    options.access.attestation.expiresAt = new Date(options.bounds.startedAtMs + 500).toISOString();
    await expect(guardRetainedOriginal(options)).rejects.toThrow(); expect(options.execute).not.toHaveBeenCalled(); expect(await loadConvergeAttemptState(options.guard.gitCommonDir, target)).toBeUndefined();
  });
  it('runs captured prompts only after capability, native claim and each durable physical intent', async () => {
    const options = await fixture(); let supported = false;
    options.access = { kind: 'asserted', credential: { source: 'login', token: 'fixture-current', url: 'https://harness.invalid' }, fetchImpl: vi.fn(async () => { supported = true; return capability(); }) };
    const called: string[] = [];
    options.execute = async (session: any) => {
      const result = await executeCapturedOriginal({ commonDir: options.guard.gitCommonDir, ownership: session.ownership,
        journal: session.journal, expectedPlan: session.captured.plan, launch: session.launch, signal: session.signal,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: async (model, role, system, user) => {
          expect(supported).toBe(true); expect((await loadConvergeAttemptState(options.guard.gitCommonDir, target))?.attemptsUsed).toBe(1);
          const cell = session.captured.plan.cells.find((entry: any) => entry.model === model);
          expect((await session.journal.read()).records.some((entry: any) => entry.type === 'intent' && entry.cell === cell.id)).toBe(true);
          expect([system, user]).toEqual(['Review.', `prompt-${cell.seat}`]); called.push(model);
          return { model, role, provider: 'fake', status: 'success', findings: [], durationMs: 1 };
        } }),
      });
      expect(result.reviews.filter(review => review.status === 'success')).toHaveLength(2);
      expect((await session.journal.read()).records.filter((entry: any) => entry.type === 'intent')).toHaveLength(2);
      await session.journal.finalize(session.ownership); return finish;
    };
    await guardRetainedOriginal(options); expect(called.sort()).toEqual(['model-a', 'model-b']);
  });
  it('freezes the shorter protected TTL into the SAME launch before the callback', async () => {
    const options = await fixture(); options.access = protectedAccess(options, vi.fn(async () => capability()) as typeof fetch);
    const expiry = options.bounds.startedAtMs + 10_000; options.access.attestation.expiresAt = new Date(expiry).toISOString();
    options.beforeClaim = async (value: any) => { expect(value.launch.expiresAtMs).toBe(expiry); };
    options.execute = async (value: any) => { expect(decodeOriginalLaunch((await value.journal.readBindings()).launch).expiresAtMs).toBe(expiry); return finish; };
    await guardRetainedOriginal(options);
  });
  it('does not dispatch after cancellation at the last pre-claim boundary', async () => {
    const options = await fixture(); const controller = new AbortController(); options.signal = controller.signal;
    options.beforeClaim = async () => controller.abort();
    await expect(guardRetainedOriginal(options)).rejects.toThrow(); expect(options.execute).not.toHaveBeenCalled();
    expect(await loadConvergeAttemptState(options.guard.gitCommonDir, target)).toBeUndefined();
  });
  it('passes cancellation through preflight and refuses an already aborted operation before claim', async () => {
    const options = await fixture(); options.signal = AbortSignal.abort();
    await expect(guardRetainedOriginal(options)).rejects.toThrow(); expect(options.execute).not.toHaveBeenCalled(); expect(await loadConvergeAttemptState(options.guard.gitCommonDir, target)).toBeUndefined();
  });
});
