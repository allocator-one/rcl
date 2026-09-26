import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { executeVerification, type VerificationExecutionOptions } from '../../src/dispatch/verification-execution.js';
import { planGating, replayGating } from '../../src/consensus/gating.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';
import { stableStringify } from '../../src/report/run-header.js';
import { createVerificationLateAudit } from '../../src/dispatch/verification-late-audit.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = 'rcl105-verifier', runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const answer = (text = '[{"id":"F1","verdict":"confirmed"}]') => ({ model: 'openai/verifier', provider: 'openai', status: 'success' as const, text, durationMs: 1 });
async function fixture(count = 9, timeout = 1000, pass = 6000) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'verification-execution-'))); roots.push(commonDir);
  const checkpointPlan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: hash('patch'), configSha256: hash('config'), specSha256: hash('spec'), contextSha256: hash('context'), toolsSha256: hash('tools'), parser: { name: 'findings-json', version: 1 },
    roster: [{ seat: 'one', model: 'reviewer', role: 'general', route: 'openai' }], chunks: [{ index: 0, total: 1, digest: hash('chunk') }], prompts: [{ seat: 'one', chunk: 0, systemSha256: hash('system'), userSha256: hash('user') }] });
  const findings: ConsensusFinding[] = Array.from({ length: count }, (_, i) => ({ id: `f${i}`, file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', title: `claim ${i}`, description: 'guard missing',
    consensus: { score: 1, total: 3, models: ['m1'], roles: ['general'], crossRole: false, crossModel: false, elevated: false, elevation: 'none', confidence: 0.5, confidenceLabel: 'Medium', tier: 'single' } }));
  const plan = planGating(findings, { minModels: 2, verificationModel: 'openai/verifier', verificationTimeoutMs: timeout, verificationPassTimeoutMs: pass,
    diffFiles: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+guard();', language: 'ts' }] });
  const saved = { runId, gatingPlanBytes: stableStringify(plan), model: plan.model, provider: 'openai', batches: plan.batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })),
    startedAtMs: 2000, expiresAtMs: 2000 + pass, verificationTimeoutMs: timeout, verificationPassTimeoutMs: pass, maxPhysicalCalls: plan.batches.length };
  const launch = createOriginalLaunch({ runId, target, planDigest: checkpointPlan.digest, capturedInputsSha256: hash('capture'), originalNativeClaim: { attempt: 1, round: 1 }, startedAtMs: 1000, expiresAtMs: 100000, maxPhysicalCalls: 1, maxAttemptsPerCell: 1 });
  let journal!: CheckpointJournal;
  await withNativeTarget(commonDir, target, async owner => {
    journal = await CheckpointJournal.create({ commonDir, namespace: 'verifier', plan: checkpointPlan, ownership: owner });
    await journal.bind('captured-inputs', 'capture', owner); await journal.bind('launch', encodeOriginalLaunch(launch), owner);
    await journal.recordIntent('one:0', { id: 'reviewer-intent', kind: 'unknown' }, owner); await journal.finalize(owner);
  });
  const auditLateAnswer = vi.fn(async () => {}), onLateAuditError = vi.fn(), beforeLaunch = vi.fn(async () => {});
  const factory = vi.fn(() => vi.fn(async () => answer()));
  const execute = (overrides: Partial<VerificationExecutionOptions> = {}) => withNativeTarget(commonDir, target, ownership => executeVerification({ commonDir, ownership, journal,
    regeneratedPlan: plan, retainedPlan: saved, otherPhysicalCalls: 0, askFactory: factory, beforeLaunch,
    nowMs: () => 2000, monotonicNow: () => 0, auditLateAnswer, onLateAuditError, ...overrides }));
  return { commonDir, journal, plan, saved, execute, factory, beforeLaunch, auditLateAnswer, onLateAuditError };
}

describe('bounded durable verifier execution', () => {
  it('persists each intent before one SDK call, retains answers and replays a completed phase with zero calls', async () => {
    const f = await fixture(), main = await f.journal.exportProof();
    const ask = vi.fn(async (model, system, user, options) => {
      const state = (await f.journal.readVerification())!;
      expect(state.intents.some(row => state.plan.batches[row.batchIndex]!.userPrompt === user)).toBe(true);
      expect(options.maxRetries).toBe(0); expect(options.timeoutMs).toBeGreaterThan(0); expect(options.timeoutMs).toBeLessThanOrEqual(1000);
      expect(model).toBe(f.plan.model); expect(system).toBe(f.plan.batches[0]!.systemPrompt);
      return answer();
    });
    const first = await f.execute({ askFactory: () => ask });
    expect(first.ok).toBe(true); expect(first.newPhysicalCalls).toBe(2); expect(ask).toHaveBeenCalledTimes(2);
    expect(first.findings[0]!.gating?.reason).toBe('verified'); expect(first.findings[8]!.gating?.reason).toBe('verified');
    expect(first.findings[1]!.gating?.verification?.verdict).toBe('unavailable');
    const phase = (await f.journal.readVerification())!;
    expect(phase.terminal?.status).toBe('complete'); expect(phase.uncertain).toEqual([]);
    expect(first.findings).toEqual(replayGating(f.plan, [0, 1].map(batchIndex => ({ batchIndex, kind: 'answer', answer: answer() })), 0).findings);
    const replay = await f.execute({ nowMs: () => 999999 });
    expect(replay.ok).toBe(true); expect(replay.findings).toEqual(first.findings); expect(replay.proof).toEqual(first.proof); expect(replay.newPhysicalCalls).toBe(0);
    expect(f.factory).not.toHaveBeenCalled(); expect(await f.journal.exportProof()).toEqual(main);
  });

  it('resumes observed batches and launches only batches with no previous intent', async () => {
    const f = await fixture();
    await withNativeTarget(f.commonDir, target, async owner => {
      await f.journal.beginVerification(f.saved, owner);
      await f.journal.recordVerificationIntent({ batchIndex: 1, attemptId: 'already-paid', startedAtMs: 2000 }, owner);
      await f.journal.recordVerificationResult({ batchIndex: 1, attemptId: 'already-paid', finishedAtMs: 2000, answerBytes: JSON.stringify(answer()) }, owner);
    });
    const result = await f.execute();
    expect(result.ok).toBe(true); expect(result.newPhysicalCalls).toBe(1); expect(f.factory.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    expect((await f.journal.readVerification())!.intents.map(x => x.batchIndex)).toEqual([1, 0]);
  });

  it('seals interrupted intents as a failed phase without resampling or spending on unstarted batches', async () => {
    const f = await fixture();
    await withNativeTarget(f.commonDir, target, async owner => {
      await f.journal.beginVerification(f.saved, owner); await f.journal.recordVerificationIntent({ batchIndex: 0, attemptId: 'unknown', startedAtMs: 2000 }, owner);
    });
    const result = await f.execute(); expect(result.ok).toBe(false); expect(result.findings).toEqual(f.plan.findings);
    expect(result.newPhysicalCalls).toBe(0); expect(f.factory).not.toHaveBeenCalled();
    expect((await f.journal.readVerification())!.uncertain).toHaveLength(1);
    expect((await f.execute()).proof).toEqual(result.proof);
  });

  it.each(['plan', 'call cap', 'combined cap', 'deadline'])('refuses %s before provider construction', async reason => {
    const f = await fixture();
    if (reason === 'plan') {
      const changed = structuredClone(f.plan); changed.findings[0]!.title = 'untrusted replacement';
      await expect(f.execute({ regeneratedPlan: changed })).rejects.toThrow('verification_execution_plan_mismatch');
      expect(await f.journal.readVerification()).toBeUndefined();
    } else {
      const result = await f.execute(reason === 'call cap' ? { retainedPlan: { ...f.saved, maxPhysicalCalls: 1 } }
        : reason === 'combined cap' ? { otherPhysicalCalls: 498 } : { nowMs: () => 9000 });
      expect(result.ok).toBe(false); expect(result.newPhysicalCalls).toBe(0);
    }
    expect(f.factory).not.toHaveBeenCalled();
  });

  it('does not launch when the durable intent acknowledgment uses the remaining pass budget', async () => {
    const f = await fixture(1); let now = 2000;
    const original = f.journal.recordVerificationIntent.bind(f.journal);
    vi.spyOn(f.journal, 'recordVerificationIntent').mockImplementation(async (...args) => { const value = await original(...args); now = f.saved.expiresAtMs; return value; });
    const ask = vi.fn(async () => answer()), result = await f.execute({ nowMs: () => now, askFactory: () => ask });
    expect(result.ok).toBe(false); expect(ask).not.toHaveBeenCalled(); expect(result.newPhysicalCalls).toBe(1);
    expect((await f.journal.readVerification())!.uncertain).toHaveLength(1);
  });

  it('bounds an adapter that ignores abort and audits its later response without changing the sealed proof', async () => {
    const f = await fixture(1, 15); let resolve!: (value: ReturnType<typeof answer>) => void;
    const ask = vi.fn(() => new Promise<ReturnType<typeof answer>>(done => { resolve = done; }));
    const result = await f.execute({ askFactory: () => ask });
    expect(result.ok).toBe(false); expect(result.newPhysicalCalls).toBe(1); expect(ask).toHaveBeenCalledTimes(1);
    resolve(answer('late')); await vi.waitFor(() => expect(f.auditLateAnswer).toHaveBeenCalledTimes(1));
    expect(f.auditLateAnswer.mock.calls[0]![0]).toMatchObject({ batchIndex: 0, answerBytes: JSON.stringify(answer('late')) });
    expect(await f.journal.exportVerificationProof()).toEqual(result.proof); expect(f.onLateAuditError).not.toHaveBeenCalled();
  });

  it('records actual timeout answers as unavailable, but never invents an observed answer for a rejected request', async () => {
    const f = await fixture(1), result = await f.execute({ askFactory: () => async () => ({ ...answer(), status: 'timeout', error: 'request timeout' }) });
    expect(result.ok).toBe(true); expect(result.findings[0]!.gating?.verification?.verdict).toBe('unavailable');
    const failed = await fixture(1), failure = await failed.execute({ askFactory: () => async () => { throw new Error('provider rejection'); } });
    expect(failure.ok).toBe(false); expect((await failed.journal.readVerification())!.outcomes).toEqual([]);
    expect((await failed.journal.readVerification())!.uncertain).toHaveLength(1);
  });

  it('runs at most three physical verifier calls concurrently', async () => {
    const f = await fixture(33); let active = 0, max = 0, launched = 0;
    const waiting: Array<() => void> = [];
    const result = await f.execute({ askFactory: () => async () => {
      active++; launched++; max = Math.max(active, max);
      if (launched <= 3) await new Promise<void>(resolve => { waiting.push(resolve); if (waiting.length === 3) waiting.forEach(done => done()); });
      active--; return answer();
    } });
    expect(result.ok).toBe(true); expect(result.newPhysicalCalls).toBe(5); expect(max).toBe(3);
  });

  it('cancels outstanding requests, seals their uncertainty and does not renew the saved deadline', async () => {
    const f = await fixture(1), controller = new AbortController();
    const result = await f.execute({ signal: controller.signal, askFactory: () => async (_m, _s, _u, options) => {
      controller.abort(); expect(options.signal?.aborted).toBe(true); return new Promise(() => {});
    } });
    expect(result.ok).toBe(false); expect((await f.journal.readVerification())!.plan.expiresAtMs).toBe(f.saved.expiresAtMs);
    await expect(f.execute({ retainedPlan: { ...f.saved, expiresAtMs: f.saved.expiresAtMs + 1 } })).rejects.toThrow();
  });

  it('retains outcomes but refuses approval when the adapter returns after the pass deadline', async () => {
    const f = await fixture(1); let now = 0, calls = 0;
    const result = await f.execute({ monotonicNow: () => { calls++; return now; }, askFactory: () => async () => { now = 6000; return answer(); } });
    expect(result.ok).toBe(false); expect(calls).toBeGreaterThan(0); expect(result.findings).toEqual(f.plan.findings);
  });

  it('includes interpretation in the unchanged whole-pass deadline', async () => {
    const f = await fixture(1); let now = 0;
    const text = answer().text, parse = JSON.parse;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((bytes, reviver) => {
      const value = parse(bytes, reviver); if (bytes === text) now = 6000; return value;
    });
    try {
      const result = await f.execute({ monotonicNow: () => now });
      expect(result.ok).toBe(false); expect(result.findings).toEqual(f.plan.findings);
      expect((await f.journal.readVerification())!.outcomes).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('does not spend after a lost intent acknowledgment', async () => {
    const f = await fixture(1), original = f.journal.recordVerificationIntent.bind(f.journal), ask = vi.fn(async () => answer());
    const spy = vi.spyOn(f.journal, 'recordVerificationIntent').mockImplementation(async (...args) => { await original(...args); throw new Error('lost ack'); });
    await expect(f.execute({ askFactory: () => ask })).rejects.toThrow(); expect(ask).not.toHaveBeenCalled(); spy.mockRestore();
    const resumed = await f.execute(); expect(resumed.ok).toBe(false); expect(resumed.newPhysicalCalls).toBe(0);
    expect((await f.journal.readVerification())!.uncertain).toHaveLength(1); expect(f.factory).not.toHaveBeenCalled();
  });

  it('does not reinterpret a completed phase when cancellation arrives during its final persistence', async () => {
    const f = await fixture(1), controller = new AbortController(), seal = f.journal.finalizeVerification.bind(f.journal);
    let sealed = false;
    vi.spyOn(f.journal, 'finalizeVerification').mockImplementation(async (...args) => { await seal(...args); sealed = true; controller.abort(); });
    const parse = JSON.parse, spy = vi.spyOn(JSON, 'parse').mockImplementation((bytes, reviver) => {
      if (sealed && bytes === answer().text) throw new Error('unexpected interpretation after sealing');
      return parse(bytes, reviver);
    });
    try {
      const result = await f.execute({ signal: controller.signal });
      expect(result.ok).toBe(true); expect(result.findings[0]!.gating?.reason).toBe('verified');
      expect((await f.journal.readVerification())!.terminal?.status).toBe('complete');
    } finally { spy.mockRestore(); }
  });

  it('persists a real late response through the caller-owned audit after execution returns', async () => {
    const f = await fixture(1, 15), errors: unknown[] = []; let resolve!: (value: ReturnType<typeof answer>) => void;
    await withNativeTarget(f.commonDir, target, async ownership => {
      const audit = createVerificationLateAudit({ commonDir: f.commonDir, journal: f.journal, ownership, onError: error => errors.push(error) });
      const result = await executeVerification({ commonDir: f.commonDir, ownership, journal: f.journal,
        regeneratedPlan: f.plan, retainedPlan: f.saved, otherPhysicalCalls: 0, beforeLaunch: async () => {},
        askFactory: () => () => new Promise(done => { resolve = done; }), nowMs: () => 2000, monotonicNow: () => 0,
        auditLateAnswer: audit.accept, onLateAuditError: error => errors.push(error) });
      expect(result.ok).toBe(false); await audit.flushAfterFinalization();
      resolve(answer('actual late answer'));
      await vi.waitFor(async () => expect(await f.journal.readLateVerificationAudit()).toHaveLength(1));
      await audit.drain(); expect(errors).toEqual([]);
      expect((await f.journal.readLateVerificationAudit())[0]!.result.answerBytes).toBe(JSON.stringify(answer('actual late answer')));
      expect(await f.journal.exportVerificationProof()).toEqual(result.proof);
    });
  });
});
