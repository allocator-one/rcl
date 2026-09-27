import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelReview } from '../../src/consensus/types.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, freezeCheckpointPlan, type PaidAttempt } from '../../src/dispatch/checkpoint.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { bindOriginalCouncil, executeCapturedOriginal, type OriginalExecutionOptions } from '../../src/dispatch/original-execution.js';
import { createOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { recoverReviewerAssignments, recoverCapturedAssignments, type ReviewerRecoveryOptions, type CapturedRecoveryOptions } from '../../src/dispatch/recovery.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import { stableStringify } from '../../src/report/run-header.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const target = 'allocator-one/rcl#105';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-physical-progress-'))); roots.push(commonDir);
  const assignments = [0, 1].map(index => ({ model: `fake/model-${index}`, provider: 'fake',
    role: { name: 'general', systemPrompt: 'system', description: 'fixture', focus: [], isSpecialized: false } }));
  const prompts = assignments.map(() => ({ systemPrompt: 'system', userPrompt: 'patch' }));
  const configBytes = stableStringify({ concurrency: 1, maxRetries: 1, timeout: 1000, quorumFraction: 1 });
  const toolsBytes = '{"aggregation":{"name":"consensus","version":1},"parser":{"name":"findings-json","version":1}}';
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: hash('patch'), configSha256: hash(configBytes), specSha256: hash(''), contextSha256: hash('[]'), toolsSha256: hash(toolsBytes),
    parser: { name: 'findings-json', version: 1 }, roster: assignments.map((a, index) => ({ seat: `s${index}`, model: a.model, role: 'general', route: 'fake' })),
    chunks: [{ index: 0, total: 1, digest: hash('patch') }], prompts: assignments.map((_, index) => ({ seat: `s${index}`, chunk: 0, systemSha256: hash('system'), userSha256: hash('patch') })) });
  const captured = captureReviewerInputs({ plan, policy: { version: 1, fraction: 1 }, assignments, prompts,
    patchBytes: 'patch', configBytes, specBytes: '', contextBytes: '[]', toolsBytes, chunkBytes: ['patch'] });
  return { commonDir, assignments, prompts, plan, expectedPlan: plan, captured, sourceAttempts: [], fraction: 1,
    maxAdditionalCalls: 4, maxAttemptsPerCell: 2, remainingMs: 4_000, timeoutMs: 1000, concurrency: 1 };
}
function review(model: string, status: ModelReview['status'] = 'success'): ModelReview {
  return { model, role: 'general', provider: 'fake', status, durationMs: 1, usage: { inputTokens: 7, outputTokens: 3 },
    findings: [{ id: 'raw', file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', title: model, description: 'Exact raw concern' }],
    ...(status === 'error' ? { error: '503 overloaded' } : {}) };
}
type Observer = (raw: ModelReview, index: number, paid: PaidAttempt) => void | Promise<void>;

describe('durably recorded physical-result progress', () => {
  it('observes a failed retry and later success once each, after persistence, with no source or replay notifications', async () => {
    const f = await fixture();
    await withNativeTarget(f.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...f, namespace: 'retry', ownership });
      const observed: Array<{ status: string; index: number; paid: PaidAttempt }> = [];
      const onPhysicalReviewComplete: Observer = async (raw, index, paid) => {
        const state = await journal.read(), result = state.outcomes.find(row => row.paidAttempt.id === paid.id);
        expect(result?.cell).toBe(`s${index}:0`); expect(result?.result.reviewBytes).toBe(JSON.stringify(raw));
        expect(state.records.filter(row => row.type === 'intent')).toHaveLength(observed.length + 1);
        observed.push({ status: raw.status, index, paid: { ...paid } });
        raw.findings.length = 0; raw.status = 'parse_failed'; paid.id = 'observer mutation';
      };
      const called = vi.fn(async (model: string): Promise<ModelReview> => review(model, called.mock.calls.length === 1 ? 'error' : 'success'));
      const options = { ...f, ownership, journal, sourceAttempts: [{ id: 'original', cell: 's0:0', outcome: review('fake/model-0') }],
        onPhysicalReviewComplete, adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: called }) } as ReviewerRecoveryOptions;
      const result = await recoverReviewerAssignments(options);
      expect(observed.map(row => [row.status, row.index])).toEqual([['error', 1], ['success', 1]]);
      expect(new Set(observed.map(row => row.paid.id)).size).toBe(2); expect(result.newAttempts).toBe(2);
      expect(result.preview.successfulSeats).toBe(2); expect(result.reviews[1]).toEqual(review('fake/model-1'));
      expect(result.reviews[0]).toEqual(review('fake/model-0'));
      await recoverReviewerAssignments(options);
      expect(called).toHaveBeenCalledTimes(2); expect(observed).toHaveLength(2); expect((await journal.read()).outcomes).toHaveLength(2);
    });
  });

  it('does not notify an outcome whose durable recording failed', async () => {
    const f = await fixture(), callback = vi.fn(), diskError = new Error('synthetic durable result failure'); let journal!: CheckpointJournal;
    await expect(withNativeTarget(f.commonDir, target, async ownership => {
      journal = await CheckpointJournal.create({ ...f, namespace: 'failed-write', ownership });
      vi.spyOn(journal, 'recordResult').mockRejectedValueOnce(diskError);
      await recoverReviewerAssignments({ ...f, ownership, journal, onPhysicalReviewComplete: callback,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: async model => review(model) }) } as ReviewerRecoveryOptions);
    })).rejects.toBe(diskError);
    expect(callback).not.toHaveBeenCalled(); expect((await journal.read()).outcomes).toEqual([]); expect((await journal.read()).uncertain).toHaveLength(1);
  });

  it('reports the persisted bytes even if the provider-owned object changes while persistence completes', async () => {
    const f = await fixture(), raw = review('fake/model-1'), original = JSON.stringify(raw), observed: string[] = [];
    await withNativeTarget(f.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...f, namespace: 'provider-mutation', ownership }), record = journal.recordResult.bind(journal);
      vi.spyOn(journal, 'recordResult').mockImplementationOnce(async (...args) => {
        await record(...args); raw.findings[0]!.description = 'provider changed its object'; raw.usage!.inputTokens = 900;
      });
      const result = await recoverReviewerAssignments({ ...f, ownership, journal,
        sourceAttempts: [{ id: 'source', cell: 's0:0', outcome: review('fake/model-0') }],
        onPhysicalReviewComplete: outcome => { observed.push(JSON.stringify(outcome)); },
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: async () => raw }) });
      expect(observed).toEqual([original]); expect(JSON.stringify(result.reviews[1])).toBe(original);
      expect((await journal.read()).outcomes[0]?.result.reviewBytes).toBe(original);
    });
  });

  it('surfaces callback rejection, retaining the result and spend so restart only dispatches the missing cell', async () => {
    const f = await fixture(), callbackError = new Error('progress consumer failed'), called = vi.fn(async (model: string) => review(model));
    let journal!: CheckpointJournal;
    const observer = vi.fn(async () => { throw callbackError; });
    await expect(withNativeTarget(f.commonDir, target, async ownership => {
      journal = await CheckpointJournal.create({ ...f, namespace: 'callback-failed', ownership });
      await recoverReviewerAssignments({ ...f, ownership, journal, onPhysicalReviewComplete: observer,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: called }) } as ReviewerRecoveryOptions);
    })).rejects.toBe(callbackError);
    expect(observer).toHaveBeenCalledTimes(1); expect(called).toHaveBeenCalledTimes(1);
    expect((await journal.read()).successes).toHaveLength(1); expect((await journal.read()).records.filter(row => row.type === 'intent')).toHaveLength(1);
    const resumed = vi.fn();
    await withNativeTarget(f.commonDir, target, async ownership => {
      journal = await CheckpointJournal.openWrite({ ...f, namespace: 'callback-failed', ownership });
      const result = await recoverReviewerAssignments({ ...f, ownership, journal, onPhysicalReviewComplete: resumed,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: called }) } as ReviewerRecoveryOptions);
      expect(result.newAttempts).toBe(2); expect(result.preview.successfulSeats).toBe(2);
    });
    expect(called.mock.calls.map(call => call[0])).toEqual(['fake/model-0', 'fake/model-1']);
    expect(resumed).toHaveBeenCalledTimes(1); expect(resumed.mock.calls[0]?.[1]).toBe(1);
  });

  it('excludes canceled in-flight work and unstarted placeholders from result progress', async () => {
    const f = await fixture(), controller = new AbortController(), started = deferred<void>(), callback = vi.fn();
    await withNativeTarget(f.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...f, namespace: 'uncertain', ownership });
      const running = recoverReviewerAssignments({ ...f, ownership, journal, signal: controller.signal, onPhysicalReviewComplete: callback,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: () => { started.resolve(); return new Promise<ModelReview>(() => {}); } }) } as ReviewerRecoveryOptions);
      await started.promise; controller.abort(); const result = await running;
      expect(callback).not.toHaveBeenCalled(); expect(result.newAttempts).toBe(1); expect((await journal.read()).uncertain).toHaveLength(1);
      expect((await journal.read()).outcomes).toEqual([]);
    });
  });

  it('does not treat adapter setup failures as paid result progress', async () => {
    const f = await fixture(), callback = vi.fn();
    await withNativeTarget(f.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...f, namespace: 'setup', ownership });
      const result = await recoverReviewerAssignments({ ...f, ownership, journal, onPhysicalReviewComplete: callback,
        adapterFactory: () => { throw new Error('missing fake adapter configuration'); } } as ReviewerRecoveryOptions);
      expect(callback).not.toHaveBeenCalled(); expect(result.newAttempts).toBe(0); expect((await journal.read()).records).toEqual([]);
    });
  });

  it('forwards progress through captured original execution and omits already recorded copies on repeat', async () => {
    const f = await fixture(), callback = vi.fn();
    const launch = createOriginalLaunch({ runId: '11111111-1111-4111-8111-111111111111', target, originalNativeClaim: { attempt: 1, round: 1 },
      capturedInputsSha256: f.captured.digest, planDigest: f.plan.digest, startedAtMs: 1000, expiresAtMs: 6000, maxPhysicalCalls: 4, maxAttemptsPerCell: 2 });
    await withNativeTarget(f.commonDir, target, async ownership => {
      const journal = await bindOriginalCouncil({ commonDir: f.commonDir, ownership, captured: f.captured, launch });
      const options = { ...f, ownership, journal, launch, nowMs: () => 1500, onPhysicalReviewComplete: callback,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: async (model: string) => review(model) }) } as OriginalExecutionOptions;
      expect((await executeCapturedOriginal(options)).newAttempts).toBe(2);
      expect(callback.mock.calls.map(call => call[1])).toEqual([0, 1]);
      await executeCapturedOriginal(options); expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  it('forwards progress through captured recovery without notifying reused source reviews', async () => {
    const f = await fixture(), callback = vi.fn();
    const operation = createRecoveryOperation({ operationId: '11111111-1111-4111-8111-111111111111',
      sourceRunId: '22222222-2222-4222-8222-222222222222', successorRunId: '33333333-3333-4333-8333-333333333333',
      sourceReportSha256: hash('source report'), sourceCheckpointSha256: hash('source checkpoint'), capturedInputsSha256: f.captured.digest,
      planDigest: f.plan.digest, target, originalNativeClaim: { attempt: 1, round: 1 }, startedAtMs: 1000, expiresAtMs: 6000, maxAdditionalCalls: 2, maxAttemptsPerCell: 2 });
    await withNativeTarget(f.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...f, namespace: 'captured-recovery', ownership });
      await journal.bind('captured-inputs', f.captured.bytes, ownership); await journal.bind('operation', encodeRecoveryOperation(operation), ownership);
      const options = { ...f, ownership, journal, operation, nowMs: () => 1500, onPhysicalReviewComplete: callback,
        sourceAttempts: [{ id: 'source', cell: 's0:0', outcome: review('fake/model-0') }],
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(), review: async (model: string) => review(model) }) } as CapturedRecoveryOptions;
      expect((await recoverCapturedAssignments(options)).newAttempts).toBe(1);
      expect(callback).toHaveBeenCalledTimes(1); expect(callback.mock.calls[0]?.[1]).toBe(1);
      await recoverCapturedAssignments(options); expect(callback).toHaveBeenCalledTimes(1);
    });
  });
});
