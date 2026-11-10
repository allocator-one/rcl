import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TIMER_DELAY_MS } from '../../src/config/schema.js';
import {
  applyGating,
  effectiveVerificationPassTimeoutMs,
  planGating,
  VerificationPassTimeoutError,
  type AskFn,
  type GatingOptions,
} from '../../src/consensus/gating.js';
import type { ConsensusFinding, ModelReview } from '../../src/consensus/types.js';
import { assembleCompletedReview } from '../../src/report/assembly.js';
import type { FileChange } from '../../src/resolver/types.js';
import type { Role } from '../../src/roles/types.js';

/** `count` single-model important claims, one per changed file: each needs the verifier. */
function review(count: number): { findings: ConsensusFinding[]; diffFiles: FileChange[] } {
  const diffFiles: FileChange[] = Array.from({ length: count }, (_, i) => ({
    filename: `src/candidate-${i}.ts`, status: 'modified', language: 'typescript', additions: 1, deletions: 1,
    patch: '@@ -1 +1 @@\n-guard();\n+execute();',
  }));
  const findings: ConsensusFinding[] = diffFiles.map((file, i) => ({
    id: `f${i}`, file: file.filename, startLine: 1, endLine: 1, severity: 'important', category: 'correctness',
    title: `Missing guard ${i}`, description: 'Execution bypasses the required guard.',
    consensus: {
      score: 1, total: 8, models: ['openai/reviewer'], roles: ['general'], crossRole: false, crossModel: false,
      elevated: false, elevation: 'none', confidence: 0.5, confidenceLabel: 'Medium', tier: 'single',
    },
  }));
  return { findings, diffFiles };
}

function options(diffFiles: FileChange[], passTimeoutMs: number, ask?: AskFn): GatingOptions {
  return {
    minModels: 2, verificationModel: 'openai/synthetic-verifier', verificationTimeoutMs: 60_000,
    verificationPassTimeoutMs: passTimeoutMs, diffFiles, ...(ask ? { ask } : {}),
  };
}

/** A verifier that answers every candidate of its batch after `delayMs`, refuting each. */
function answeringAfter(delayMs: number): AskFn {
  return vi.fn<AskFn>((_model, _system, user) => new Promise((resolve) => {
    const ids = [...user.matchAll(/^### (F\d+)$/gm)].map((match) => match[1]);
    const text = JSON.stringify(ids.map((id) => ({ id, verdict: 'refuted', reason: 'The guard is still called.' })));
    setTimeout(() => resolve({ model: 'openai/synthetic-verifier', provider: 'openai', text, durationMs: delayMs, status: 'success' }), delayMs);
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the whole verification pass deadline scales with its workload (RCL-206)', () => {
  const bound = (candidates: number, configured: number) =>
    effectiveVerificationPassTimeoutMs(planGating(review(candidates).findings, options(review(candidates).diffFiles, configured)));

  it('keeps the configured bound for up to two waves of batches', () => {
    // 48 candidates: six batches of eight, two waves of three.
    expect(bound(48, 600_000)).toBe(600_000);
    expect(bound(1, 600_000)).toBe(600_000);
    expect(bound(0, 600_000)).toBe(600_000);
  });

  it('grows in proportion to the waves past two', () => {
    // 116 candidates, as on allocator-one#13363: fifteen batches, five waves.
    expect(bound(116, 600_000)).toBe(1_500_000);
    expect(bound(49, 600_000)).toBe(900_000);
  });

  it('keeps a fractional configured bound exactly when it does not scale', () => {
    expect(bound(48, 600_000.5)).toBe(600_000.5);
  });

  it('lets a defaulted per-call bound follow the scaled pass, and keeps an explicit shorter one', async () => {
    const { findings, diffFiles } = review(144);
    const calls = (verificationTimeoutMs: number) => {
      const ask = answeringAfter(1);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pass = applyGating(findings, { ...options(diffFiles, 100, ask), verificationTimeoutMs, monotonicNow: () => 0 });
      return { ask, pass };
    };
    const defaulted = calls(100);
    await vi.advanceTimersByTimeAsync(20);
    await defaulted.pass;
    expect(defaulted.ask.mock.calls[0]![3].timeoutMs).toBe(300);
    vi.useRealTimers();
    const explicit = calls(50);
    await vi.advanceTimersByTimeAsync(20);
    await explicit.pass;
    expect(explicit.ask.mock.calls[0]![3].timeoutMs).toBe(50);
  });

  it('caps at four times the configured bound and at the timer maximum', () => {
    expect(bound(400, 600_000)).toBe(2_400_000);
    expect(bound(400, MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS);
  });

  it('verifies a large review whose batches answer in time, past the configured deadline', async () => {
    // 144 candidates: eighteen batches, six waves, against a 100 ms configured bound.
    const { findings, diffFiles } = review(144);
    const ask = answeringAfter(40);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    const pass = applyGating(findings, { ...options(diffFiles, 100, ask), monotonicNow: () => now });
    for (let elapsed = 0; elapsed < 300; elapsed += 10) {
      now += 10;
      await vi.advanceTimersByTimeAsync(10);
    }
    const result = await pass;

    expect(ask).toHaveBeenCalledTimes(18);
    expect(result.verification).toMatchObject({ candidates: 144, refuted: 144, unavailable: 0 });
    expect(result.verification!.durationMs).toBeGreaterThan(100);
    expect(result.findings.every((f) => f.gating?.reason === 'none' && f.gating.verification?.verdict === 'refuted')).toBe(true);
  });

  it('still fails a pass that overruns the scaled bound', async () => {
    const { findings, diffFiles } = review(144);
    const ask = answeringAfter(80);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    const pass = applyGating(findings, { ...options(diffFiles, 100, ask), monotonicNow: () => now });
    const settled = pass.then(() => 'resolved', (error: unknown) => error);
    for (let elapsed = 0; elapsed < 400; elapsed += 10) {
      now += 10;
      await vi.advanceTimersByTimeAsync(10);
    }

    const failure = await settled;
    expect(failure).toBeInstanceOf(VerificationPassTimeoutError);
    expect((failure as VerificationPassTimeoutError).timeoutMs).toBe(300);
  });

  it('verifies a large council in assembly and records the bound it applied, without a fallback', async () => {
    const { findings, diffFiles } = review(144);
    const role: Role = { name: 'general', systemPrompt: '', description: '', focus: [], isSpecialized: false };
    const chunkReviews: ModelReview[] = [{
      model: 'openai/reviewer', role: role.name, provider: 'openai', durationMs: 20, status: 'success',
      findings: findings.map(({ id, file, startLine, endLine, title, description, severity, category }) =>
        ({ id, file, startLine, endLine, title, description, severity, category })),
    }];
    const ask = answeringAfter(40);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-10-21T13:00:00.000Z'));
    const startTime = Date.now();
    const assembly = assembleCompletedReview({
      chunkReviews, arrivedAsync: [], asyncLaunched: 0, startTime, roleMap: new Map([[role.name, role]]),
      diff: { source: 'local', files: diffFiles },
      config: { thresholds: { minConfidence: 0, minConsensusScore: 0 } },
      gatingConfig: {
        mode: 'verified-consensus', minModels: 2, verificationModel: 'openai/synthetic-verifier',
        verificationTimeoutMs: 60_000, verificationPassTimeoutMs: 100,
      },
      run: {
        id: '019a15eb-0000-7000-8000-000000000206', rclVersion: '4.5.19', command: 'review',
        target: { kind: 'patch', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
        roster: [{ model: 'openai/reviewer', role: role.name, provider: 'openai', lane: 'blocking' }],
        runner: { kind: 'agent', agent: 'synthetic-regression' }, startedAt: new Date(startTime),
      },
    }, { ask, monotonicNow: () => Date.now() - startTime, onWarning: (warning) => { throw new Error(warning); } });
    await vi.advanceTimersByTimeAsync(300);
    const result = await assembly;

    expect(result.run.gating).toMatchObject({ verification_pass_timeout_ms: 100, verification_pass_effective_timeout_ms: 300 });
    expect(result.run.gating).not.toHaveProperty('strict_fallback');
    expect(result.stats.verification).toMatchObject({ candidates: 144, refuted: 144 });
    expect(result.run.ci_exit_code).toBe(0);
  });
});

