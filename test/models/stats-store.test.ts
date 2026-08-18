import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOutcomes,
  appendCalls,
  loadModelStats,
  computeWeight,
  resolveDataDir,
} from '../../src/models/stats-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rcl-stats-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-18T12:00:00Z');

function outcome(model: string, verdict: 'fixed' | 'dismissed', ts = '2026-08-10T00:00:00Z') {
  return { ts, verdict, models: [model], severity: 'important' };
}

describe('stats store (RCL-27)', () => {
  it('does not live under a tmp directory by default', () => {
    const resolved = resolveDataDir({});
    expect(resolved).not.toContain(tmpdir());
    expect(resolved).not.toMatch(/^\/tmp\//);
  });

  it('honors the RCL_DATA_DIR override', () => {
    expect(resolveDataDir({ RCL_DATA_DIR: dir })).toBe(dir);
  });

  it('accumulates outcomes across separate appends (runs) and computes precision', async () => {
    await appendOutcomes([outcome('m1', 'fixed'), outcome('m1', 'dismissed')], dir);
    await appendOutcomes([outcome('m1', 'fixed'), outcome('m2', 'dismissed')], dir);
    const stats = await loadModelStats({ dir, now: NOW });
    const m1 = stats.find((s) => s.model === 'm1')!;
    expect(m1.outcomes).toBe(3);
    expect(m1.fixed).toBe(2);
    expect(m1.precision).toBeCloseTo(2 / 3);
    expect(stats.find((s) => s.model === 'm2')!.precision).toBe(0);
  });

  it('ignores outcomes outside the trailing window', async () => {
    await appendOutcomes(
      [outcome('m1', 'fixed', '2026-01-01T00:00:00Z'), outcome('m1', 'dismissed')],
      dir
    );
    const stats = await loadModelStats({ dir, windowDays: 90, now: NOW });
    expect(stats.find((s) => s.model === 'm1')!.outcomes).toBe(1);
  });

  it('aggregates call volume, dead-call rate, and p50 latency', async () => {
    await appendCalls(
      [
        { ts: '2026-08-10T00:00:00Z', model: 'm1', durationMs: 100, status: 'success' },
        { ts: '2026-08-10T00:00:00Z', model: 'm1', durationMs: 300, status: 'success' },
        { ts: '2026-08-10T00:00:00Z', model: 'm1', durationMs: 900, status: 'timeout' },
        { ts: '2026-08-10T00:00:00Z', model: 'm1', durationMs: 50, status: 'error' },
      ],
      dir
    );
    const stats = await loadModelStats({ dir, now: NOW });
    const m1 = stats.find((s) => s.model === 'm1')!;
    expect(m1.calls).toBe(4);
    expect(m1.deadRate).toBeCloseTo(0.5);
    expect(m1.p50Ms).toBe(300);
  });

  it('returns empty on a missing store instead of throwing', async () => {
    const stats = await loadModelStats({ dir: join(dir, 'nope'), now: NOW });
    expect(stats).toEqual([]);
  });

  it('skips corrupt lines without losing the rest', async () => {
    await appendOutcomes([outcome('m1', 'fixed')], dir);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'outcomes.jsonl'), '{corrupt\n');
    await appendOutcomes([outcome('m1', 'dismissed')], dir);
    const stats = await loadModelStats({ dir, now: NOW });
    expect(stats.find((s) => s.model === 'm1')!.outcomes).toBe(2);
  });
});

describe('computeWeight', () => {
  it('is neutral (1) when the sample is too small', () => {
    expect(computeWeight(0.9, 5)).toBe(1);
    expect(computeWeight(undefined, 0)).toBe(1);
  });

  it('maps precision monotonically into [0.5, 1.5] with enough samples', () => {
    expect(computeWeight(0, 50)).toBe(0.5);
    expect(computeWeight(0.5, 50)).toBe(1);
    expect(computeWeight(1, 50)).toBe(1.5);
    expect(computeWeight(0.27, 50)).toBeCloseTo(0.77);
  });
});

describe('idempotency (round-1 review findings)', () => {
  it('last verdict wins per (target, findingKey) — re-recording never inflates history', async () => {
    const rec = {
      ts: '2026-08-10T00:00:00Z',
      verdict: 'dismissed' as const,
      models: ['m1'],
      target: 't1',
      findingKey: 'k1',
    };
    await appendOutcomes([rec], dir);
    await appendOutcomes([rec], dir); // converge re-run
    await appendOutcomes([{ ...rec, ts: '2026-08-11T00:00:00Z', verdict: 'fixed' }], dir);
    const stats = await loadModelStats({ dir, now: NOW });
    const m1 = stats.find((s) => s.model === 'm1')!;
    expect(m1.outcomes).toBe(1);
    expect(m1.fixed).toBe(1);
  });

  it('re-seeded call records collapse; live call records never do', async () => {
    const seedCall = {
      ts: '2026-08-10T00:00:00Z',
      model: 'm1',
      role: 'general',
      durationMs: 100,
      status: 'success',
      source: 'seed' as const,
    };
    await appendCalls([seedCall, seedCall], dir); // double seed
    await appendCalls(
      [
        { ts: '2026-08-10T01:00:00Z', model: 'm1', durationMs: 50, status: 'success', source: 'live' as const },
        { ts: '2026-08-10T01:00:00Z', model: 'm1', durationMs: 50, status: 'success', source: 'live' as const },
      ],
      dir
    );
    const stats = await loadModelStats({ dir, now: NOW });
    expect(stats.find((s) => s.model === 'm1')!.calls).toBe(3);
  });
});
