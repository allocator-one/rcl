import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelReview } from '../../src/consensus/types.js';
import type { ReviewAdapter } from '../../src/dispatch/adapter.js';
import type { AsyncDelegate } from '../../src/dispatch/checkpoint-async-store.js';

const checkpoint = vi.hoisted(() => ({ openCapturedAsyncDelegate: vi.fn() }));
vi.mock('../../src/dispatch/checkpoint-async-store.js', () => checkpoint);

import { executeCheckpointAsync } from '../../src/dispatch/checkpoint-async-execution.js';

describe('checkpoint async execution deadline ordering', () => {
  beforeEach(() => { checkpoint.openCapturedAsyncDelegate.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('accepts a provider response completed before the deadline while the claim lock releases', async () => {
    vi.useFakeTimers();
    let releaseClaim!: () => void, releasePersistence!: () => void;
    const claimRelease = new Promise<void>(resolve => { releaseClaim = resolve; });
    const persistence = new Promise<void>(resolve => { releasePersistence = resolve; });
    const intent = { callIndex: 0, attemptId: 'async-11111111-1111-4111-8111-111111111111', startedAtMs: Date.now() };
    const review: ModelReview = { model: 'model', role: 'general', provider: 'fake', status: 'success', findings: [], durationMs: 1 };
    const writer = {
      claim: vi.fn(async (_prompts, afterIntent?: (value: typeof intent) => void) => {
        afterIntent?.(intent); await claimRelease; return intent;
      }),
      recordResult: vi.fn(async () => { await persistence; return 'observed' as const; }),
    };
    checkpoint.openCapturedAsyncDelegate.mockResolvedValue({
      writer, plan: { expiresAtMs: Date.now() + 10_000 }, timeoutMs: 5, opinionCycle: { version: 1, cycleId: null },
      call: {
        ref: { id: 'assignment:0', assignment: 'assignment', chunk: 0, chunkSha256: 'a'.repeat(64),
          provider: 'fake', model: 'model', role: 'general', systemPromptSha256: 'b'.repeat(64), userPromptSha256: 'c'.repeat(64) },
        prompt: { systemPrompt: 'system', userPrompt: 'user' },
      },
    });
    const adapter: ReviewAdapter = { name: 'fake', provider: 'fake', ask: vi.fn(), review: vi.fn(async () => review) };
    let completed = false;
    const running = executeCheckpointAsync({ delegate: {} as AsyncDelegate, adapterFactory: () => adapter,
      onLateAuditError: vi.fn() }).then(result => { completed = true; return result; });

    try {
      await vi.waitFor(() => expect(adapter.review).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(5);
      expect(completed).toBe(false);
      releaseClaim();
      await vi.waitFor(() => expect(writer.recordResult).toHaveBeenCalledOnce());
      expect(completed).toBe(false);
    } finally { releaseClaim(); releasePersistence(); }

    await expect(running).resolves.toEqual({ newPhysicalCalls: 1 });
  });
});
