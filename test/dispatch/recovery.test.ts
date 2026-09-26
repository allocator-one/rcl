import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { recoverCapturedAssignments, recoverReviewerAssignments } from '../../src/dispatch/recovery.js';
import { captureReviewerInputs } from '../../src/dispatch/captured-inputs.js';
import { createRecoveryOperation, encodeRecoveryOperation } from '../../src/dispatch/recovery-operation.js';
import type { RecoveryAttempt } from '../../src/dispatch/recovery-policy.js';
import type { ModelReview } from '../../src/consensus/types.js';
import type { ReviewAssignment } from '../../src/roles/types.js';

const writeGate = vi.hoisted(() => ({ active: false, started: () => {}, wait: Promise.resolve() }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const path = String(args[0]);
    if (!writeGate.active || !(path.endsWith('/events/00000001.json') || path.includes('/.staging/')) ||
      (Number(args[1]) & 1) !== 1) return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === 'writeFile') return async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        writeGate.started(); await writeGate.wait; return handle.writeFile(...writeArgs);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
  }};
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const target = 'allocator-one/rcl#105';
function fixture() {
  const assignments: ReviewAssignment[] = Array.from({ length: 3 }, (_, index) => ({
    model: `fake/model-${index}`, provider: 'fake',
    role: { name: 'general', systemPrompt: 'system', focus: [], description: 'fixture', isSpecialized: false },
  }));
  const prompts = assignments.map(() => ({ systemPrompt: 'system', userPrompt: 'patch' }));
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40),
    patchSha256: hash('patch'), configSha256: hash('config'), specSha256: hash('spec'),
    contextSha256: hash('context'), toolsSha256: hash('tools'), parser: { name: 'findings-json', version: 1 },
    roster: assignments.map((assignment, index) => ({ seat: `s${index}`, model: assignment.model, role: 'general', route: 'fake' })),
    chunks: [{ index: 0, total: 1, digest: hash('patch') }],
    prompts: assignments.map((_, index) => ({ seat: `s${index}`, chunk: 0, systemSha256: hash('system'), userSha256: hash('patch') })),
  });
  const review = (model: string, status: ModelReview['status'] = 'success'): ModelReview => ({ model,
    role: 'general', provider: 'fake', status, durationMs: 1, findings: [],
    ...(status === 'error' ? { error: '503 overloaded' } : {}) });
  const sourceAttempts: RecoveryAttempt[] = [{ id: 'original-s0', cell: 's0:0', outcome: review(assignments[0]!.model) }];
  return { assignments, prompts, plan, expectedPlan: plan, sourceAttempts, review };
}
async function runFixture(work: (input: ReturnType<typeof fixture>, commonDir: string) => Promise<void>) {
  const commonDir = await mkdtemp(join(tmpdir(), 'rcl-recovery-executor-')); roots.push(commonDir);
  await work(fixture(), commonDir);
}

function capturedFixture(input: ReturnType<typeof fixture>) {
  const configBytes = JSON.stringify({ concurrency: 1, quorumFraction: 2 / 3, reasoningEffort: 'high', timeout: 1000 });
  const contextBytes = '[]';
  const toolsBytes = '{"aggregation":{"name":"consensus","version":1},"parser":{"name":"findings-json","version":1}}';
  const plan = freezeCheckpointPlan({ ...input.plan, configSha256: hash(configBytes),
    contextSha256: hash(contextBytes), toolsSha256: hash(toolsBytes) });
  return captureReviewerInputs({ ...input, plan, policy: { version: 1, fraction: 2 / 3 },
    patchBytes: 'patch', configBytes, specBytes: 'spec', contextBytes, toolsBytes, chunkBytes: ['patch'] });
}

function recoveryOperation(planDigest: string, capturedInputsSha256: string) {
  return createRecoveryOperation({ operationId: '11111111-1111-4111-8111-111111111111',
    sourceRunId: '01a0daa6-b575-759b-942c-e879460be5bf', successorRunId: '22222222-2222-4222-8222-222222222222',
    sourceReportSha256: hash('source report'), sourceCheckpointSha256: hash('source checkpoint'),
    capturedInputsSha256, planDigest, target, originalNativeClaim: { attempt: 1, round: 1 },
    startedAtMs: 1000, expiresAtMs: 3000, maxAdditionalCalls: 1, maxAttemptsPerCell: 3 });
}

describe('owned missing-review executor', () => {
  it('refuses legacy journals without captured inputs before any paid dispatch', async () => runFixture(async (input, commonDir) => {
    const called = vi.fn();
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'no-capture', plan: input.plan, ownership });
      await expect(recoverCapturedAssignments({ commonDir, ownership, journal, expectedPlan: input.plan,
        sourceAttempts: input.sourceAttempts, operation: recoveryOperation(input.plan.digest, hash('missing')),
        nowMs: () => 1500,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) })).rejects.toThrow('recovery_missing_bindings');
      expect(called).not.toHaveBeenCalled();
      expect((await journal.read()).records).toEqual([]);
    })).rejects.toThrow('recovery_missing_bindings');
  }));

  it('uses saved inputs and spends only the saved remaining call budget across reopen', async () => runFixture(async (input, commonDir) => {
    const captured = capturedFixture(input);
    const operation = recoveryOperation(captured.plan.digest, captured.digest);
    const called = vi.fn(async (model: string) => input.review(model, 'error'));
    const run = async (create: boolean) => withNativeTarget(commonDir, target, async ownership => {
      const open = { commonDir, namespace: 'captured-restart', plan: captured.plan, ownership };
      const journal = await (create ? CheckpointJournal.create(open) : CheckpointJournal.openWrite(open));
      if (create) {
        await journal.bind('captured-inputs', captured.bytes, ownership);
        await journal.bind('operation', encodeRecoveryOperation(operation), ownership);
      }
      return recoverCapturedAssignments({ commonDir, ownership, journal, expectedPlan: captured.plan,
        sourceAttempts: input.sourceAttempts, operation, nowMs: () => 1500,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
    });
    expect((await run(true)).preview.nextAction).toBe('call_limit');
    expect((await run(false)).preview.nextAction).toBe('call_limit');
    expect(called).toHaveBeenCalledTimes(1);
    expect(called.mock.calls[0]!.slice(2, 4)).toEqual(['system', 'patch']);
    expect((called.mock.calls[0] as unknown[])[4]).toMatchObject({ maxRetries: 0, timeoutMs: 1000 });
  }));

  it('does not renew an expired saved operation or accept a changed source binding', async () => runFixture(async (input, commonDir) => {
    const captured = capturedFixture(input), operation = recoveryOperation(captured.plan.digest, captured.digest);
    const called = vi.fn();
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'expired', plan: captured.plan, ownership });
      await journal.bind('captured-inputs', captured.bytes, ownership);
      await journal.bind('operation', encodeRecoveryOperation(operation), ownership);
      const options = { commonDir, ownership, journal, expectedPlan: captured.plan,
        sourceAttempts: input.sourceAttempts, operation, nowMs: () => operation.expiresAtMs + 1,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) };
      expect((await recoverCapturedAssignments(options)).preview.nextAction).toBe('time_limit');
      await expect(recoverCapturedAssignments({ ...options,
        operation: { ...operation, sourceReportSha256: hash('substitution') } })).rejects.toThrow('recovery_operation_mismatch');
      expect(called).not.toHaveBeenCalled();
      expect((await journal.read()).records.filter(record => record.type === 'intent')).toEqual([]);
    })).rejects.toThrow('recovery_operation_mismatch');
  }));

  it('uses one new call from M-1, retains the original finding and does no work on repeat', async () => runFixture(async (input, commonDir) => {
    const finding = { id: 'original', file: 'x.ts', startLine: 1, endLine: 1, severity: 'critical' as const,
      category: 'security' as const, title: 'Retained concern', description: 'Do not drop me.' };
    input.sourceAttempts[0]!.outcome!.findings.push(finding);
    const sourceBytes = JSON.stringify(input.sourceAttempts);
    const called = vi.fn(async (model: string) => input.review(model));
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'successor', plan: input.plan, ownership });
      const options = { ...input, commonDir, ownership, journal, fraction: 2 / 3,
        maxAdditionalCalls: 5, maxAttemptsPerCell: 3, remainingMs: 5_000, timeoutMs: 1_000, concurrency: 1,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) };
      const recovered = await recoverReviewerAssignments(options);
      expect(called).toHaveBeenCalledTimes(1);
      expect(called.mock.calls[0]![0]).toBe('fake/model-1');
      expect(recovered.preview.successfulSeats).toBe(2);
      expect(recovered.reviews[0]!.findings).toEqual([finding]);
      expect(recovered.newAttempts).toBe(1);
      await recoverReviewerAssignments(options);
      expect(called).toHaveBeenCalledTimes(1);
      expect((await journal.read()).successes).toHaveLength(1);
    });
    expect(JSON.stringify(input.sourceAttempts)).toBe(sourceBytes);
  }));

  it('bounds retries while retaining every failed paid attempt and disabling hidden adapter retries', async () => runFixture(async (input, commonDir) => {
    const called = vi.fn(async (model: string) => input.review(model, 'error'));
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'bounded', plan: input.plan, ownership });
      const result = await recoverReviewerAssignments({ ...input, commonDir, ownership, journal, fraction: 2 / 3,
        maxAdditionalCalls: 2, maxAttemptsPerCell: 3, remainingMs: 5_000, timeoutMs: 1_000, concurrency: 2,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
      expect(called).toHaveBeenCalledTimes(2);
      expect(called.mock.calls.every(call => (call as unknown[])[4] && ((call as unknown[])[4] as { maxRetries: number }).maxRetries === 0)).toBe(true);
      expect(result.preview.nextAction).toBe('call_limit');
      expect(result.newAttempts).toBe(2);
      expect((await journal.read()).outcomes).toHaveLength(2);
    });
  }));

  it('refuses a changed effective prompt before intent persistence or any provider call', async () => runFixture(async (input, commonDir) => {
    const called = vi.fn();
    input.prompts[1]!.userPrompt = 'different patch';
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'mismatch', plan: input.plan, ownership });
      await expect(recoverReviewerAssignments({ ...input, commonDir, ownership, journal, fraction: 2 / 3,
        maxAdditionalCalls: 2, maxAttemptsPerCell: 3, remainingMs: 5_000, timeoutMs: 1_000, concurrency: 1,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) })).rejects.toThrow('recovery_prompt_mismatch');
      expect((await journal.read()).records).toEqual([]);
    });
    expect(called).not.toHaveBeenCalled();
  }));

  it('does not cancel the last affordable call while refusing a concurrent extra launch', async () => runFixture(async (input, commonDir) => {
    const called = vi.fn(async (model: string) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return input.review(model);
    });
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'one-call', plan: input.plan, ownership });
      const result = await recoverReviewerAssignments({ ...input, commonDir, ownership, journal, fraction: 2 / 3,
        maxAdditionalCalls: 1, maxAttemptsPerCell: 3, remainingMs: 5_000, timeoutMs: 1_000, concurrency: 2,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
      expect(called).toHaveBeenCalledTimes(1);
      expect(result.preview.nextAction).toBe('build_report');
      expect((await journal.read()).uncertain).toEqual([]);
    });
  }));

  it('allows concurrent owned pending calls to complete an all-seat policy', async () => runFixture(async (input, commonDir) => {
    const called = vi.fn(async (model: string) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return input.review(model);
    });
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'all-seat', plan: input.plan, ownership });
      const result = await recoverReviewerAssignments({ ...input, commonDir, ownership, journal, fraction: 1,
        maxAdditionalCalls: 2, maxAttemptsPerCell: 3, remainingMs: 5_000, timeoutMs: 1_000, concurrency: 2,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
      expect(called).toHaveBeenCalledTimes(2);
      expect(result.preview.successfulSeats).toBe(3);
      expect(result.preview.nextAction).toBe('build_report');
    });
  }));

  it('reopens a persisted successor under new ownership without repeating its successful call', async () => runFixture(async (input, commonDir) => {
    const called = vi.fn(async (model: string) => input.review(model));
    const run = async (create: boolean) => withNativeTarget(commonDir, target, async ownership => {
      const open = { commonDir, namespace: 'restart', plan: input.plan, ownership };
      const journal = await (create ? CheckpointJournal.create(open) : CheckpointJournal.openWrite(open));
      return recoverReviewerAssignments({ ...input, commonDir, ownership, journal, fraction: 2 / 3,
        maxAdditionalCalls: 1, maxAttemptsPerCell: 3, remainingMs: 5_000, timeoutMs: 1_000, concurrency: 1,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
    });
    await run(true);
    expect((await run(false)).preview.nextAction).toBe('build_report');
    expect(called).toHaveBeenCalledTimes(1);
  }));

  it('serializes duplicate resumes sharing the same valid ownership without duplicate paid calls', async () => runFixture(async (input, commonDir) => {
    const called = vi.fn(async (model: string) => input.review(model));
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'duplicate', plan: input.plan, ownership });
      const options = { ...input, commonDir, ownership, journal, fraction: 2 / 3,
        maxAdditionalCalls: 2, maxAttemptsPerCell: 3, remainingMs: 5_000, timeoutMs: 1_000, concurrency: 1,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) };
      const results = await Promise.all([recoverReviewerAssignments(options), recoverReviewerAssignments(options)]);
      expect(results.map(result => result.preview.nextAction)).toEqual(['build_report', 'build_report']);
      expect(called).toHaveBeenCalledTimes(1);
      expect((await journal.read()).successes).toHaveLength(1);
    });
  }));

  it('ends on deadline despite a noncooperative provider and preserves its uncertain cost', async () => runFixture(async (input, commonDir) => {
    let providerStarted!: () => void;
    const started = new Promise<void>(resolve => { providerStarted = resolve; });
    const called = vi.fn(() => { providerStarted(); return new Promise<ModelReview>(() => {}); });
    await withNativeTarget(commonDir, target, async ownership => {
      const journal = await CheckpointJournal.create({ commonDir, namespace: 'deadline', plan: input.plan, ownership });
      // Advance the unchanged 50 ms budget only after the durable intent reaches
      // the provider. Real filesystem scheduling must not turn this hanging-call
      // regression into the separate pre-dispatch-expiry case.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      try {
        const running = recoverReviewerAssignments({ ...input, commonDir, ownership, journal, fraction: 2 / 3,
          maxAdditionalCalls: 2, maxAttemptsPerCell: 3, remainingMs: 50, timeoutMs: 1_000, concurrency: 1,
          adapterFactory: () => ({ name: 'fake', provider: 'fake', review: called, ask: vi.fn() }) });
        await started;
        await vi.advanceTimersByTimeAsync(50);
        const result = await running;
        expect(called).toHaveBeenCalledTimes(1);
        expect(result.preview.successfulSeats).toBe(1);
        expect(result.preview.nextAction).toBe('time_limit');
        expect((await journal.read()).uncertain).toHaveLength(1);
      } finally { vi.useRealTimers(); }
    });
  }));
});

it('same-owner recovery does not read an append before its write completes', async () => runFixture(async (input, commonDir) => {
  await withNativeTarget(commonDir, target, async ownership => {
    const journal = await CheckpointJournal.create({ commonDir, namespace: 'read-race', plan: input.plan, ownership });
    let release!: () => void;
    const started = new Promise<void>(resolve => { writeGate.started = resolve; });
    writeGate.wait = new Promise<void>(resolve => { release = resolve; });
    writeGate.active = true;
    const writing = journal.recordIntent('s1:0', { id: 'prior-owned-intent', kind: 'paid' }, ownership);
    await started;
    const execution = recoverReviewerAssignments({ ...input, commonDir, ownership, journal, fraction: 2 / 3,
        maxAdditionalCalls: 2, maxAttemptsPerCell: 3, remainingMs: 5000, timeoutMs: 1000, concurrency: 1,
        adapterFactory: () => ({ name: 'fake', provider: 'fake', review: vi.fn(async (model: string) => input.review(model)), ask: vi.fn() }) }).then(() => undefined, (error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 30));
    writeGate.active = false; release(); await writing;
    const failure = await execution;
    expect((await journal.read()).records[0]).toMatchObject({ type: 'intent', cell: 's1:0', paidAttempt: { id: 'prior-owned-intent', kind: 'paid' } });
    expect(failure).toBeUndefined();
  });
}));

it('retains pre-dispatch adapter failure without charging a paid call', async () => runFixture(async (input, commonDir) => {
  const adapterFactory = vi.fn(() => { throw new Error('OPENAI_API_KEY is missing'); });
  await withNativeTarget(commonDir, target, async ownership => {
    const journal = await CheckpointJournal.create({ commonDir, namespace: 'setup-error', plan: input.plan, ownership });
    const result = await recoverReviewerAssignments({ ...input, commonDir, ownership, journal, fraction: 2 / 3,
      maxAdditionalCalls: 2, maxAttemptsPerCell: 3, remainingMs: 5000, timeoutMs: 1000, concurrency: 1, adapterFactory });
    expect(result.newAttempts).toBe(0);
    expect((await journal.read()).records).toEqual([]);
    expect(adapterFactory).toHaveBeenCalledTimes(2);
    expect(result.reviews.some(review => review.error?.includes('OPENAI_API_KEY is missing'))).toBe(true);
  });
}));
