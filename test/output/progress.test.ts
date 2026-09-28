import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelReview } from '../../src/consensus/types.js';
import {
  assertReviewWorkWithinLimit,
  buildCouncilRunPlan,
  CouncilProgressReporter,
  formatCouncilRunPlan,
} from '../../src/output/progress.js';

function review(status: ModelReview['status'] = 'success'): ModelReview {
  return {
    model: 'model-a',
    role: 'general',
    provider: 'test',
    findings: [],
    durationMs: 1,
    status,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('council run planning', () => {
  it('fails before blocking call fanout exceeds the paid-work bound', () => {
    expect(() => assertReviewWorkWithinLimit(18, 17)).not.toThrow();
    expect(() => assertReviewWorkWithinLimit(31, 17)).toThrow(
      /527 blocking calls.*safety limit of 512/i
    );
  });

  it('makes the 18 reviewer × 6 chunk queue and timeout bound explicit', () => {
    const plan = buildCouncilRunPlan({
      totalCalls: 108,
      reviewers: 18,
      chunks: 6,
      concurrency: 6,
      timeoutMs: 600_000,
    });

    expect(plan).toMatchObject({ waves: 18, timeoutBoundMs: 10_800_000 });
    expect(formatCouncilRunPlan(plan)).toBe(
      'Review plan: 108 calls (18 reviewers × 6 chunk(s)), concurrency 6 → 18 wave(s); ' +
        '10m per-call timeout, 3h timeout-bound queue estimate'
    );
  });

  it('bounds retained original waves by the captured effective provider policy', () => {
    const options = {
      totalCalls: 25,
      reviewers: 25,
      chunks: 1,
      concurrency: 9,
      timeoutMs: 540_000,
      providers: Array.from({ length: 25 }, () => 'anthropic'),
      providerConcurrency: { anthropic: 2, openai: 1 },
    };
    expect(buildCouncilRunPlan(options)).toMatchObject({
      concurrency: 9,
      waves: 13,
      timeoutBoundMs: 7_020_000,
    });
    expect(buildCouncilRunPlan({ ...options, providers: Array(25).fill('google') }))
      .toMatchObject({ waves: 3, timeoutBoundMs: 1_620_000 });
    expect(buildCouncilRunPlan({ ...options,
      providers: [...Array(24).fill('google'), 'openai'],
      providerConcurrency: { openai: 1 },
    })).toMatchObject({ waves: 3, timeoutBoundMs: 1_620_000 });
    expect(buildCouncilRunPlan({ ...options, totalCalls: 9, reviewers: 9, concurrency: 3,
      providers: ['anthropic', 'anthropic', 'anthropic', 'openai', 'openai', 'openai', 'openai', 'openai', 'openai'],
      providerConcurrency: { anthropic: 3, openai: 2 },
    })).toMatchObject({ waves: 4, timeoutBoundMs: 2_160_000 });
    expect(() => buildCouncilRunPlan({ ...options, providers: options.providers.slice(1) }))
      .toThrow('Invalid retained provider matrix');
    for (const cap of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildCouncilRunPlan({ ...options, providerConcurrency: { anthropic: cap } }))
        .toThrow('Invalid retained provider concurrency');
    }
  });
});

describe('CouncilProgressReporter', () => {
  it('emits heartbeats and status checkpoints when output is redirected', () => {
    vi.useFakeTimers();
    let current = 0;
    const lines: string[] = [];
    const reporter = new CouncilProgressReporter({
      totalCalls: 108,
      interactive: false,
      updateInteractive: () => {
        throw new Error('interactive output should not be used');
      },
      writeLine: (line) => lines.push(line),
      now: () => current,
      heartbeatMs: 60_000,
    });

    reporter.start();
    current = 60_000;
    vi.advanceTimersByTime(60_000);
    expect(lines).toEqual([
      'Reviews 0/108 (success 0, timeout 0, error 0, parse_failed 0) · elapsed 1m',
    ]);

    reporter.complete(review('timeout'));
    for (let i = 0; i < 5; i++) reporter.complete(review('success'));
    expect(lines.at(-1)).toBe(
      'Reviews 6/108 (success 5, timeout 1, error 0, parse_failed 0) · elapsed 1m'
    );
    reporter.stop();
  });

  it('bounds completion logging for a 108-call run', () => {
    const lines: string[] = [];
    const reporter = new CouncilProgressReporter({
      totalCalls: 108,
      interactive: false,
      updateInteractive: () => undefined,
      writeLine: (line) => lines.push(line),
      now: () => 0,
    });

    for (let i = 0; i < 108; i++) reporter.complete(review());

    expect(lines[0]).toContain('Reviews 1/108');
    expect(lines.at(-1)).toContain('Reviews 108/108');
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it('updates only the spinner for interactive output', () => {
    const spinnerUpdates: string[] = [];
    const lines: string[] = [];
    const reporter = new CouncilProgressReporter({
      totalCalls: 2,
      interactive: true,
      updateInteractive: (line) => spinnerUpdates.push(line),
      writeLine: (line) => lines.push(line),
      now: () => 1_000,
    });

    reporter.start();
    reporter.complete(review('parse_failed'));
    reporter.stop();

    expect(spinnerUpdates).toHaveLength(1);
    expect(spinnerUpdates[0]).toContain('⚠ model-a/general');
    expect(lines).toEqual([]);
  });
});
