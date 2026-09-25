import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, exportCheckpointProof, freezeCheckpointPlan, type PaidAttempt } from '../../src/dispatch/checkpoint.js';
import { createCheckpointLateAudit, type CheckpointLateAudit } from '../../src/dispatch/late-audit.js';
import { recoverReviewerAssignments, type ReviewerRecoveryOptions } from '../../src/dispatch/recovery.js';
import type { ModelReview } from '../../src/consensus/types.js';
import type { ReviewAssignment } from '../../src/roles/types.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const target = 'allocator-one/rcl#105';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-late-coordinator-'))); roots.push(commonDir);
  const assignments: ReviewAssignment[] = Array.from({ length: 3 }, (_, i) => ({ model: `fake/model-${i}`, provider: 'fake',
    role: { name: 'general', systemPrompt: 'system', focus: [], description: 'fixture', isSpecialized: false } }));
  const prompts = assignments.map(() => ({ systemPrompt: 'system', userPrompt: 'patch' }));
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: hash('patch'),
    configSha256: hash('config'), specSha256: hash('spec'), contextSha256: hash('context'), toolsSha256: hash('tools'),
    parser: { name: 'findings-json', version: 1 },
    roster: assignments.map((a, i) => ({ seat: `s${i}`, model: a.model, role: 'general', route: 'fake' })),
    chunks: [{ index: 0, total: 1, digest: hash('patch') }],
    prompts: assignments.map((_, i) => ({ seat: `s${i}`, chunk: 0, systemSha256: hash('system'), userSha256: hash('patch') })) });
  return { commonDir, assignments, prompts, plan, expectedPlan: plan, sourceAttempts: [], fraction: 1,
    maxAdditionalCalls: 3, maxAttemptsPerCell: 3, remainingMs: 4_000, timeoutMs: 1_000, concurrency: 3 };
}
function review(index = 0, status: ModelReview['status'] = 'success'): ModelReview {
  return { model: `fake/model-${index}`, role: 'general', provider: 'fake', status, durationMs: 17,
    findings: [{ id: 'late', file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness',
      title: 'Late finding', description: 'Original raw concern\nwith exact details' }],
    usage: { inputTokens: 23, outputTokens: 13 }, ...(status !== 'success' ? { error: 'Original raw error' } : {}) };
}
const attempt = (id = 'original'): PaidAttempt => ({ id, kind: 'paid' });

describe('owned late-result coordinator', () => {
  it('snapshots buffered findings and attempt bytes, then preserves sealed proof and accounting', async () => {
    const input = await fixture(), errors = vi.fn();
    await withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'buffer', ownership });
      await journal.recordIntent('s0:0', attempt(), ownership);
      const audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: errors });
      const raw = review(), paid = attempt(), bytes = JSON.stringify(raw);
      const buffered = audit.accept(raw, 0, paid);
      raw.findings[0]!.description = 'mutated later'; paid.id = 'mutated later'; await buffered;
      expect(await journal.readLateAudit()).toEqual([]);
      await expect(audit.drain()).rejects.toThrow('late_audit_requires_finalization');
      await journal.finalize(ownership);
      const before = await exportCheckpointProof(journal), state = await journal.read();
      await audit.flushAfterFinalization(); await audit.drain();
      const rows = await journal.readLateAudit();
      expect(rows).toHaveLength(1); expect(rows[0]?.reviewBytes).toBe(bytes); expect(rows[0]?.paidAttempt).toEqual(attempt());
      expect(await exportCheckpointProof(journal)).toEqual(before); expect(await journal.read()).toEqual(state);
      expect(state.successes).toEqual([]); expect(state.uncertain).toHaveLength(1); expect(errors).not.toHaveBeenCalled();
    });
  });

  it('checks finalization even when the buffer is empty and remains usable after an early flush', async () => {
    const input = await fixture();
    await withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'empty', ownership });
      const audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: vi.fn() });
      await expect(audit.flushAfterFinalization()).rejects.toThrow('late_audit_requires_finalization');
      await journal.finalize(ownership); await audit.flushAfterFinalization(); await audit.drain();
      expect(await journal.readLateAudit()).toEqual([]);
    });
  });

  it.each(['success', 'error', 'timeout', 'parse_failed', 'canceled'] as const)(
    'writes an observed post-activation %s with all original findings and usage', async status => {
      const input = await fixture();
      await withNativeTarget(input.commonDir, target, async ownership => {
        const journal = await CheckpointJournal.create({ ...input, namespace: 'active', ownership });
        await journal.recordIntent('s0:0', attempt(), ownership); await journal.finalize(ownership);
        const audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: vi.fn() }), before = await exportCheckpointProof(journal);
        await audit.flushAfterFinalization();
        await Promise.all([audit.accept(review(0, status), 0, attempt()), audit.accept(review(0, status), 0, attempt())]);
        await audit.drain();
        expect((await journal.readLateAudit()).map(row => row.reviewBytes)).toEqual([JSON.stringify(review(0, status))]);
        expect(await exportCheckpointProof(journal)).toEqual(before);
      });
    },
  );

  it('rejects a wrong original index or paid intent without changing main history', async () => {
    const input = await fixture(), errors = vi.fn();
    await expect(withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'identity', ownership });
      await journal.recordIntent('s0:0', attempt(), ownership); await journal.finalize(ownership);
      const before = await exportCheckpointProof(journal), audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: errors });
      await audit.flushAfterFinalization();
      await expect(audit.accept(review(1), 1, attempt())).rejects.toThrow('checkpoint_late_missing_intent');
      await expect(audit.accept(review(), -1, attempt())).rejects.toThrow('late_audit_invalid_call_index');
      await expect(audit.drain()).rejects.toThrow();
      expect(errors).toHaveBeenCalledTimes(2); expect(await journal.readLateAudit()).toEqual([]);
      expect(await exportCheckpointProof(journal)).toEqual(before);
    })).rejects.toThrow('checkpoint_late_missing_intent');
  });

  it('retains byte-conflict errors after notification, including repeated drains', async () => {
    const input = await fixture(), errors = vi.fn();
    await expect(withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'conflict', ownership });
      await journal.recordIntent('s0:0', attempt(), ownership); await journal.finalize(ownership);
      const audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: errors }); await audit.flushAfterFinalization();
      const writes = await Promise.allSettled([audit.accept(review(), 0, attempt()), audit.accept(review(0, 'error'), 0, attempt())]);
      expect(writes.map(write => write.status)).toEqual(['fulfilled', 'rejected']);
      await expect(audit.drain()).rejects.toThrow('checkpoint_late_conflict');
      await expect(audit.drain()).rejects.toThrow('checkpoint_late_conflict');
      expect(errors).toHaveBeenCalledTimes(1); expect(errors.mock.calls[0]?.[1]).toBe(0);
      expect((await journal.readLateAudit())[0]?.reviewBytes).toBe(JSON.stringify(review()));
    })).rejects.toThrow('checkpoint_late_conflict');
  });

  it('surfaces persistence and broken error-sink failures without unhandled rejections', async () => {
    const input = await fixture(), writeError = new Error('synthetic write failure'), sinkError = new Error('sink failure');
    await withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'sink', ownership });
      await journal.recordIntent('s0:0', attempt(), ownership); await journal.finalize(ownership);
      const sink = vi.fn(() => { throw sinkError; });
      const audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: sink }); await audit.flushAfterFinalization();
      vi.spyOn(journal, 'recordLateResult').mockRejectedValueOnce(writeError);
      await expect(audit.accept(review(), 0, attempt())).rejects.toBe(writeError);
      await expect(audit.drain()).rejects.toMatchObject({ errors: [writeError, sinkError] });
      expect(sink).toHaveBeenCalledWith(writeError, 0);
    });
  });

  it('uses only the original ownership and reports a response arriving after release', async () => {
    const input = await fixture(), errors = vi.fn(); let audit!: CheckpointLateAudit, journal!: CheckpointJournal;
    await withNativeTarget(input.commonDir, target, async ownership => {
      journal = await CheckpointJournal.create({ ...input, namespace: 'released', ownership });
      await journal.recordIntent('s0:0', attempt(), ownership); await journal.finalize(ownership);
      audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: errors }); await audit.flushAfterFinalization();
    });
    const before = await exportCheckpointProof(journal);
    await expect(audit.accept(review(), 0, attempt())).rejects.toThrow('native_target_not_owned');
    await expect(audit.drain()).rejects.toThrow('native_target_not_owned');
    expect(errors).toHaveBeenCalledTimes(1); expect(await journal.readLateAudit()).toEqual([]);
    expect(await exportCheckpointProof(journal)).toEqual(before);
  });

  it('refuses a first observation after release even when activation never happened', async () => {
    const input = await fixture(), errors = vi.fn(); let audit!: CheckpointLateAudit, journal!: CheckpointJournal;
    await withNativeTarget(input.commonDir, target, async ownership => {
      journal = await CheckpointJournal.create({ ...input, namespace: 'unactivated', ownership });
      await journal.recordIntent('s0:0', attempt(), ownership); await journal.finalize(ownership);
      audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: errors });
    });
    await expect(audit.accept(review(), 0, attempt())).rejects.toThrow('native_target_not_owned');
    await expect(audit.drain()).rejects.toThrow('native_target_not_owned');
    expect(errors).toHaveBeenCalledTimes(1); expect(await journal.readLateAudit()).toEqual([]);
  });

  it('does not lose an observation racing activation and drains its already-started write', async () => {
    const input = await fixture(), checkingSeal = deferred<void>(), sealRead = deferred<void>(), writeStarted = deferred<void>(), writeGate = deferred<void>();
    await withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'activation-race', ownership });
      await journal.recordIntent('s0:0', attempt(), ownership); await journal.finalize(ownership);
      const audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: vi.fn() });
      const read = journal.read.bind(journal), write = journal.recordLateResult.bind(journal);
      vi.spyOn(journal, 'read').mockImplementationOnce(async () => { checkingSeal.resolve(); await sealRead.promise; return read(); });
      vi.spyOn(journal, 'recordLateResult').mockImplementationOnce(async (...args) => { writeStarted.resolve(); await writeGate.promise; return write(...args); });
      let finished = false;
      const flushing = audit.flushAfterFinalization().then(() => { finished = true; });
      await checkingSeal.promise; await audit.accept(review(), 0, attempt()); sealRead.resolve();
      await writeStarted.promise; expect(finished).toBe(false); expect(await journal.readLateAudit()).toEqual([]);
      writeGate.resolve(); await flushing; await audit.drain();
      expect((await journal.readLateAudit()).map(row => row.reviewBytes)).toEqual([JSON.stringify(review())]);
    });
  });
});

describe('executor late paid-attempt attribution', () => {
  it('requires an error sink before any paid intent, including when the preview needs no dispatch', async () => {
    const input = await fixture(), call = vi.fn();
    await withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'required-sink', ownership });
      const options = { ...input, journal, ownership, auditLateAttempt: vi.fn(),
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: call, ask: vi.fn() }) } as ReviewerRecoveryOptions;
      await expect(recoverReviewerAssignments(options)).rejects.toThrow('Late review audit requires an error sink');
      await expect(recoverReviewerAssignments({ ...options, maxAdditionalCalls: 0 })).rejects.toThrow('Late review audit requires an error sink');
      expect(call).not.toHaveBeenCalled(); expect((await journal.read()).records).toEqual([]);
    });
  });

  it('conserves a late raw finding without waiting for another hanging provider or changing the proof', async () => {
    const input = await fixture(), controller = new AbortController(), started = deferred<void>(), late = deferred<ModelReview>();
    const observed = deferred<void>(), errors = vi.fn(), legacy = vi.fn(); let calls = 0;
    await withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'hanging', ownership });
      const audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: errors });
      const adapter = vi.fn((model: string) => { calls++; if (calls === 3) started.resolve();
        return model === 'fake/model-1' ? late.promise : new Promise<ModelReview>(() => {}); });
      const running = recoverReviewerAssignments({ ...input, journal, ownership, signal: controller.signal,
        auditLateAttempt: async (raw: ModelReview, index: number, paid: PaidAttempt) => { await audit.accept(raw, index, paid); observed.resolve(); },
        auditLateReview: legacy, onLateAuditError: errors,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: adapter, ask: vi.fn() }) } as ReviewerRecoveryOptions);
      await started.promise; controller.abort(); const result = await running;
      expect(result.newAttempts).toBe(3); expect(result.reviews.every(row => row.status === 'canceled')).toBe(true);
      await journal.finalize(ownership); const proof = await exportCheckpointProof(journal);
      await audit.flushAfterFinalization(); await audit.drain(); // Two providers never resolve.
      late.resolve(review(1)); await observed.promise; await audit.drain();
      const rows = await journal.readLateAudit(), intent = proof.state.records.find(row => row.type === 'intent' && row.cell === 's1:0');
      expect(rows).toHaveLength(1); expect(rows[0]?.paidAttempt).toEqual(intent?.paidAttempt);
      expect(rows[0]?.reviewBytes).toBe(JSON.stringify(review(1))); expect(legacy).toHaveBeenCalledWith(review(1), 1);
      expect(await exportCheckpointProof(journal)).toEqual(proof); expect(result.newAttempts).toBe(3); expect(errors).not.toHaveBeenCalled();
    });
  });

  it('attributes a late retry to its own wave intent and preserves the earlier failed paid call', async () => {
    const input = await fixture(), late = deferred<ModelReview>(), thirdStarted = deferred<void>(), observed = deferred<void>();
    const controller = new AbortController(), errors = vi.fn(); let calls = 0;
    await withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'retry-wave', ownership });
      const audit = createCheckpointLateAudit({ commonDir: input.commonDir, journal, ownership, onError: errors });
      const run = recoverReviewerAssignments({ ...input, journal, ownership, concurrency: 1, signal: controller.signal,
        sourceAttempts: [{ id: 'retained', cell: 's0:0', outcome: review() }],
        auditLateAttempt: async (raw: ModelReview, index: number, paid: PaidAttempt) => { await audit.accept(raw, index, paid); observed.resolve(); },
        onLateAuditError: errors, adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(),
          review: async model => { calls++; if (calls === 3) { thirdStarted.resolve(); return late.promise; }
            return { ...review(Number(model.at(-1)), 'error'), error: '503 overloaded' }; } }) } as ReviewerRecoveryOptions);
      await Promise.race([thirdStarted.promise, run.then(() => { throw new Error('Retry fixture stopped before third dispatch'); })]); controller.abort(); const result = await run;
      late.resolve(review(1)); await observed.promise; // Buffered before sealing.
      await journal.finalize(ownership); const proof = await exportCheckpointProof(journal);
      await audit.flushAfterFinalization();
      const intents = proof.state.records.filter(row => row.type === 'intent'), rows = await journal.readLateAudit();
      expect(intents).toHaveLength(3); expect(intents[0]?.cell).toBe('s1:0'); expect(intents[2]?.cell).toBe('s1:0');
      expect(rows[0]?.paidAttempt).toEqual(intents[2]?.paidAttempt); expect(rows[0]?.paidAttempt.id).not.toBe(intents[0]?.paidAttempt?.id);
      expect(proof.state.outcomes).toHaveLength(2); expect(proof.state.uncertain).toHaveLength(1); expect(result.newAttempts).toBe(3);
      expect(await exportCheckpointProof(journal)).toEqual(proof); expect(errors).not.toHaveBeenCalled();
    });
  });

  it('still invokes the isolated legacy callback when the attempt-aware callback fails', async () => {
    const input = await fixture(), late = deferred<ModelReview>(), started = deferred<void>(), observedError = deferred<unknown>();
    const controller = new AbortController(), failure = new Error('attempt audit failed'), legacy = vi.fn();
    await withNativeTarget(input.commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ ...input, namespace: 'legacy-compatible', ownership });
      const run = recoverReviewerAssignments({ ...input, journal, ownership, concurrency: 1, signal: controller.signal,
        auditLateAttempt: (raw, _index, paid) => { raw.findings.length = 0; paid.id = 'mutated callback'; throw failure; },
        auditLateReview: legacy, onLateAuditError: error => observedError.resolve(error),
        adapterFactory: () => ({ name: 'fake', provider: 'fake', ask: vi.fn(),
          review: () => { started.resolve(); return late.promise; } }) });
      await started.promise; controller.abort(); await run;
      await journal.finalize(ownership); const proof = await exportCheckpointProof(journal);
      late.resolve(review()); expect(await observedError.promise).toBe(failure);
      expect(legacy).toHaveBeenCalledExactlyOnceWith(review(), 0); expect(await exportCheckpointProof(journal)).toEqual(proof);
    });
  });
});
