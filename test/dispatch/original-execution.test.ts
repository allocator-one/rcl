import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelReview } from '../../src/consensus/types.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { CheckpointJournal, exportCheckpointProof, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { bindOriginalCouncil, executeCapturedOriginal } from '../../src/dispatch/original-execution.js';
import { createOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { createCheckpointLateAudit } from '../../src/dispatch/late-audit.js';
import { stableStringify } from '../../src/report/run-header.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const target = 'rcl-105';
const runId = '01a0daa6-b575-759b-942c-e879460be5bf';
function fixture(maxPhysicalCalls = 3, concurrency = 1, providerConcurrency?: Record<string, number>,
  quorumFraction = 2 / 3, provider = 'fake') {
  const assignments = Array.from({ length: 3 }, (_, index) => ({ model: `fake/model-${index}`, provider,
    role: { name: 'general', systemPrompt: 'system', description: 'fixture', focus: [], isSpecialized: false } }));
  const prompts = assignments.map(() => ({ systemPrompt: 'system', userPrompt: 'patch' }));
  const configBytes = stableStringify({ concurrency, maxRetries: 0, timeout: 1000, quorumFraction,
    ...(providerConcurrency === undefined ? {} : { providerConcurrency }) });
  const toolsBytes = '{"aggregation":{"name":"consensus","version":1},"parser":{"name":"findings-json","version":1}}';
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: hash('patch'), configSha256: hash(configBytes), specSha256: hash(''), contextSha256: hash('[]'),
    toolsSha256: hash(toolsBytes), parser: { name: 'findings-json', version: 1 },
    roster: assignments.map((a, i) => ({ seat: `s${i}`, model: a.model, role: a.role.name, route: a.provider })),
    chunks: [{ index: 0, total: 1, digest: hash('patch') }],
    prompts: assignments.map((_, i) => ({ seat: `s${i}`, chunk: 0, systemSha256: hash('system'), userSha256: hash('patch') })),
  });
  const captured = captureReviewerInputs({ plan, policy: { version: 1, fraction: quorumFraction }, assignments, prompts,
    patchBytes: 'patch', configBytes, specBytes: '', contextBytes: '[]', toolsBytes, chunkBytes: ['patch'] });
  const launch = createOriginalLaunch({ runId, target, originalNativeClaim: { attempt: 1, round: 1 },
    capturedInputsSha256: captured.digest, planDigest: plan.digest, startedAtMs: 1000, expiresAtMs: 6000,
    maxPhysicalCalls, maxAttemptsPerCell: 1 });
  const review = (model: string, status: ModelReview['status'] = 'success'): ModelReview => ({ model, role: 'general', provider,
    status, findings: [{ id: 'same-id', file: 'x.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', title: model, description: 'Retained finding' }],
    durationMs: 1, ...(status === 'error' ? { error: '503 overloaded' } : {}) });
  return { captured, launch, plan, provider, review };
}
async function directory() { const root = await mkdtemp(join(tmpdir(), 'rcl-original-execution-')); roots.push(root); return root; }

describe('captured original council execution', () => {
  it('resumes an interrupted binding publication without changing the original run', async () => {
    const commonDir = await directory(), f = fixture();
    await withNativeTarget(commonDir, target, async ownership => {
      const interrupted = await CheckpointJournal.create({
        commonDir, namespace: runId, plan: f.plan, ownership,
      });
      await interrupted.bind('captured-inputs', f.captured.bytes, ownership);

      const resumed = await bindOriginalCouncil({
        commonDir, ownership, captured: f.captured, launch: f.launch,
      });

      expect(await resumed.readBindings()).toMatchObject({
        'captured-inputs': f.captured.bytes,
        launch: expect.any(String),
      });
      expect((await resumed.read()).records.filter(record => record.type === 'binding')).toHaveLength(2);
    });
  });

  it('uses only a policy frozen in the capture and leaves legacy provider policy omitted', async () => {
    async function peakFor(providerConcurrency?: Record<string, number>) {
      const provider = providerConcurrency === undefined ? 'fake' : 'anthropic';
      const commonDir = await directory(), f = fixture(3, 3, providerConcurrency, 1, provider);
      let active = 0, peak = 0;
      await withNativeTarget(commonDir, target, async ownership => {
        const journal = await bindOriginalCouncil({ commonDir, ownership, captured: f.captured, launch: f.launch });
        await executeCapturedOriginal({ commonDir, ownership, journal, expectedPlan: f.plan,
          launch: f.launch, nowMs: () => 1500,
          adapterFactory: () => ({ name: 'fake', provider: f.provider, ask: vi.fn(), review: async model => {
            active++; peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            return f.review(model);
          } }) });
      });
      return { peak, providerConcurrency: f.captured.config.providerConcurrency };
    }
    expect(await peakFor({ anthropic: 1 })).toEqual({ peak: 1, providerConcurrency: { anthropic: 1 } });
    expect((await peakFor()).providerConcurrency).toBeUndefined();
  });

  it('refuses an explicit changed provider policy before replay dispatch', async () => {
    const commonDir = await directory(), f = fixture(3, 3, { anthropic: 1 }, 1, 'anthropic');
    const changedPlan = freezeCheckpointPlan({ ...f.plan,
      configSha256: hash(stableStringify({ ...f.captured.config, providerConcurrency: { anthropic: 2 } })) });
    const called = vi.fn();
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const journal = await bindOriginalCouncil({ commonDir, ownership, captured: f.captured, launch: f.launch });
      await executeCapturedOriginal({ commonDir, ownership, journal, expectedPlan: changedPlan,
        launch: f.launch, nowMs: () => 1500,
        adapterFactory: () => ({ name: 'fake', provider: f.provider, ask: vi.fn(), review: called }) });
    })).rejects.toThrow('original_execution_launch_mismatch');
    expect(called).not.toHaveBeenCalled();
  });

  it('retains a late original response under its physical intent without changing sealed health or proof', async () => {
    const commonDir = await directory(), f = fixture(3, 2);
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await bindOriginalCouncil({ commonDir, ownership, captured: f.captured, launch: f.launch });
      const onError = vi.fn(), audit = createCheckpointLateAudit({ commonDir, journal, ownership, onError });
      const controller = new AbortController();
      let completeLate!: (review: ModelReview) => void, observed!: () => void;
      const late = new Promise<ModelReview>(resolve => { completeLate = resolve; });
      const observation = new Promise<void>(resolve => { observed = resolve; });
      const result = await executeCapturedOriginal({ commonDir, ownership, journal, expectedPlan: f.plan,
        launch: f.launch, nowMs: () => 1500, signal: controller.signal,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(),
          review: async model => {
            if (model.endsWith('0')) return late;
            return f.review(model);
          } }),
        onPhysicalReviewComplete: async (_review, index) => { if (index === 1) controller.abort(); },
        auditLateAttempt: async (review, index, attempt) => { await audit.accept(review, index, attempt); observed(); },
        onLateAuditError: onError });
      expect(result.preview.successfulSeats).toBe(1);
      expect(result.newAttempts).toBe(2);
      await journal.finalize(ownership);
      const proof = await exportCheckpointProof(journal), state = await journal.read();
      await audit.flushAfterFinalization();
      completeLate(f.review('fake/model-0'));
      await observation;
      await audit.drain();
      const rows = await journal.readLateAudit();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.paidAttempt.id).toBe(state.uncertain[0]!.paidAttempt.id);
      expect(JSON.parse(rows[0]!.reviewBytes).findings).toEqual(f.review('fake/model-0').findings);
      expect((await exportCheckpointProof(journal)).bytes).toBe(proof.bytes);
      expect((await journal.read()).successes).toHaveLength(1);
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it('refuses an original descriptor that silently raises the captured retry policy', async () => {
    const commonDir = await directory(), f = fixture();
    await expect(withNativeTarget(commonDir, target, ownership => bindOriginalCouncil({ commonDir, ownership,
      captured: f.captured, launch: { ...f.launch, maxAttemptsPerCell: 2 } })))
      .rejects.toThrow('original_execution_retry_policy_raise');
    await expect(withNativeTarget(commonDir, target, ownership => bindOriginalCouncil({ commonDir, ownership,
      captured: f.captured, launch: { ...f.launch, maxPhysicalCalls: 4 } })))
      .rejects.toThrow('original_execution_retry_policy_raise');
  });

  it('binds actual inputs before the first physical call and stops at original-seat quorum', async () => {
    const commonDir = await directory(), f = fixture();
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const journal = await bindOriginalCouncil({ commonDir, ownership, captured: f.captured, launch: f.launch });
      const called = vi.fn(async (model: string) => {
        const state = await journal.read(), bindings = await journal.readBindings();
        expect(bindings['captured-inputs']).toBe(f.captured.bytes);
        expect(JSON.parse(bindings.launch!)).toEqual(f.launch);
        expect(bindings.operation).toBeUndefined();
        expect(bindings.source).toBeUndefined();
        expect(state.records.filter(r => r.type === 'intent')).toHaveLength(called.mock.calls.length);
        return f.review(model);
      });
      const options = { commonDir, ownership, journal, expectedPlan: f.plan, launch: f.launch, nowMs: () => 1500,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) };
      const result = await executeCapturedOriginal(options);
      expect(result.preview.successfulSeats).toBe(2);
      expect(result.newAttempts).toBe(2);
      expect(called).toHaveBeenCalledTimes(2);
      expect((called.mock.calls[0] as unknown[])[4]).toMatchObject({ maxRetries: 0 });
      const retained = (await journal.read()).successes.map(success => success.reviewBytes);
      await executeCapturedOriginal(options);
      expect(called).toHaveBeenCalledTimes(2);
      expect((await journal.read()).successes.map(success => success.reviewBytes)).toEqual(retained);
      await journal.finalize(ownership);
      const proof = await exportCheckpointProof(journal);
      await expect(executeCapturedOriginal(options)).rejects.toThrow('original_execution_finalized');
      expect((await exportCheckpointProof(journal)).bytes).toBe(proof.bytes);
    })).rejects.toThrow('original_execution_finalized');
  });

  it('cannot reset spent original calls or renew the deadline after reopening', async () => {
    const commonDir = await directory(), f = fixture(3);
    const called = vi.fn(async (model: string) => f.review(model, 'error'));
    const run = (create: boolean, nowMs: number, runtimeBounds?: { maxPhysicalCalls: number }) => withNativeTarget(commonDir, target, async ownership => {
      const journal = create ? await bindOriginalCouncil({ commonDir, ownership, captured: f.captured, launch: f.launch })
        : await CheckpointJournal.openWrite({ commonDir, ownership, plan: f.plan, namespace: runId });
      return executeCapturedOriginal({ commonDir, ownership, journal, expectedPlan: f.plan, launch: f.launch, nowMs: () => nowMs,
        ...(runtimeBounds === undefined ? {} : { runtimeBounds }),
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
    });
    const first = await run(true, 1500, { maxPhysicalCalls: 2 });
    expect(first.preview.nextAction).toBe('call_limit');
    expect(first.newAttempts).toBe(2);
    expect(called).toHaveBeenCalledTimes(2);
    const expired = await run(false, 7000);
    expect(expired.preview.nextAction).toBe('time_limit');
    expect(expired.newAttempts).toBe(2);
    expect(called).toHaveBeenCalledTimes(2);
  });

  it('refuses a changed run identity, capture or successor binding before dispatch', async () => {
    const commonDir = await directory(), f = fixture();
    const called = vi.fn();
    // Child operation failure correctly poisons the owner even when caught locally.
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const journal = await bindOriginalCouncil({ commonDir, ownership, captured: f.captured, launch: f.launch });
      await journal.bind('source', 'not an original council', ownership);
      await executeCapturedOriginal({ commonDir, ownership, journal, expectedPlan: f.plan, launch: f.launch,
        nowMs: () => 1500, adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
    })).rejects.toThrow('original_execution_successor_binding');
    expect(called).not.toHaveBeenCalled();
    for (const change of [{ runId: '22222222-2222-4222-8222-222222222222' }, { capturedInputsSha256: hash('changed') }]) {
      const nextDir = await directory();
      await expect(withNativeTarget(nextDir, target, async ownership => {
        const journal = await bindOriginalCouncil({ commonDir: nextDir, ownership, captured: f.captured, launch: f.launch });
        await executeCapturedOriginal({ commonDir: nextDir, ownership, journal, expectedPlan: f.plan,
          launch: { ...f.launch, ...change }, nowMs: () => 1500,
          adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
      })).rejects.toThrow('original_execution_launch_mismatch');
    }
    expect(called).not.toHaveBeenCalled();
  });
});
