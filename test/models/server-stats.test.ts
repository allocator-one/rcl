import { describe, expect, it } from 'vitest';
import { fetchServerModelStats, loadMergedWeights, mergeWeights } from '../../src/models/server-stats.js';
import type { ModelStats } from '../../src/models/stats-store.js';
import { fakeFetch } from '../telemetry/fixtures.js';

const ENV = { HARNESS_API_TOKEN: 'aone_TESTTOKEN0123456789', HARNESS_API_URL: 'https://harness.example.test' };

function local(model: string, outcomes: number, precision?: number): ModelStats {
  return {
    model,
    outcomes,
    fixed: Math.round(outcomes * (precision ?? 0)),
    ...(precision !== undefined ? { precision } : {}),
    calls: 10,
    dead: 0,
    weight: outcomes >= 20 && precision !== undefined ? Math.min(1.5, Math.max(0.5, 0.5 + precision)) : 1,
  };
}

function serverStats(models: Array<Record<string, unknown>>) {
  return { window_days: 90, computed_at: '2026-09-08T10:00:00Z', min_outcomes_for_weight: 20, models };
}

function serverRow(model: string, outcomes: number, weight: number) {
  return { model, outcomes, fixed: Math.round(outcomes * (weight - 0.5)), precision: outcomes ? weight - 0.5 : null, calls: 50, dead: 1, dead_rate: 0.02, p50_ms: 1200, weight };
}

describe('mergeWeights', () => {
  it('prefers the server weight at or above the outcome floor and the local one below it', () => {
    const merged = mergeWeights(
      [local('anthropic/claude', 30, 0.9), local('openai/gpt', 40, 0.6), local('only/local', 25, 0.7)],
      serverStats([serverRow('anthropic/claude', 200, 1.35), serverRow('openai/gpt', 5, 1.2), serverRow('only/server', 3, 1.4)])
    );
    const by = new Map(merged.map((m) => [m.model, m]));
    expect(by.get('anthropic/claude')).toMatchObject({ weight: 1.35, source: 'server', serverOutcomes: 200 });
    expect(by.get('openai/gpt')).toMatchObject({ weight: 1.1, source: 'local' });
    expect(by.get('only/local')).toMatchObject({ weight: 1.2, source: 'local' });
    // A model the server knows only thinly and this machine not at all keeps the neutral weight.
    expect(by.get('only/server')).toMatchObject({ weight: 1, source: 'neutral' });
  });

  it('lets the server raise the outcome floor but never lower it below 20', () => {
    const strict = { ...serverStats([serverRow('a', 30, 1.3)]), min_outcomes_for_weight: 50 };
    expect(mergeWeights([local('a', 40, 0.9)], strict)).toEqual([expect.objectContaining({ model: 'a', weight: 1.4, source: 'local' })]);
    const lenient = { ...serverStats([serverRow('b', 10, 1.3)]), min_outcomes_for_weight: 5 };
    expect(mergeWeights([], lenient)).toEqual([expect.objectContaining({ model: 'b', weight: 1, source: 'neutral' })]);
  });

  it('refuses a model name carrying control characters', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { data: serverStats([serverRow('evil\u001b[31m/model', 30, 1)]) } }));
    expect(await fetchServerModelStats({ windowDays: 90, rclVersion: '3.1.0', fetchImpl: fetch, env: ENV, cwd: '/nowhere', credentialsPath: '/nowhere/credentials.json' })).toMatchObject({ kind: 'none' });
  });

  it('is the local view when the server has nothing to say', () => {
    const merged = mergeWeights([local('a', 30, 0.9)], undefined);
    expect(merged).toEqual([expect.objectContaining({ model: 'a', weight: 1.4, source: 'local' })]);
    // Below the floor the local store's weight is neutral and the row says so.
    expect(mergeWeights([local('thin', 3, 1)], undefined)).toEqual([expect.objectContaining({ model: 'thin', weight: 1, source: 'neutral' })]);
  });
});

describe('fetchServerModelStats', () => {
  function fetchWith(handler: Parameters<typeof fakeFetch>[0], env: Record<string, string> = ENV) {
    const { fetch, requests } = fakeFetch(handler);
    return { outcome: fetchServerModelStats({ windowDays: 90, rclVersion: '3.1.0', fetchImpl: fetch, env, cwd: '/nowhere', credentialsPath: '/nowhere/credentials.json' }), requests };
  }

  it('asks the credential host for the window and returns the parsed stats', async () => {
    const data = serverStats([serverRow('anthropic/claude', 200, 1.35)]);
    const { outcome, requests } = fetchWith(() => ({ status: 200, body: { data } }));
    expect(await outcome).toMatchObject({ kind: 'ok', value: { window_days: 90, models: [{ model: 'anthropic/claude', weight: 1.35 }] }, host: 'harness.example.test' });
    expect(requests[0]!.url).toBe('https://harness.example.test/api/v1/reviews/model-stats?window_days=90');
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${ENV.HARNESS_API_TOKEN}`);
  });

  it('refuses rows outside the documented ranges rather than voting with them', async () => {
    for (const bad of [
      serverRow('a', -1, 1),
      { ...serverRow('a', 30, 1), weight: 5 },
      { ...serverRow('a', 30, 1), weight: 0 },
      { ...serverRow('a', 30, 1), precision: 2 },
      { ...serverRow('a', 30, 1), calls: 1.5 },
    ]) {
      expect(await fetchWith(() => ({ status: 200, body: { data: serverStats([bad]) } })).outcome, JSON.stringify(bad)).toMatchObject({ kind: 'none', reason: expect.stringMatching(/malformed/) });
    }
  });

  it('reports why there are no server stats: no credential, evidence off, malformed, unreachable', async () => {
    expect(await fetchWith(() => ({ status: 200, body: {} }), {}).outcome).toMatchObject({ kind: 'none' });
    expect(await fetchWith(() => ({ status: 403, body: { error: 'reviews_disabled', message: 'off' } })).outcome).toMatchObject({ kind: 'none', reason: expect.stringMatching(/not enabled/) });
    expect(await fetchWith(() => ({ status: 200, body: { data: { models: 'nope' } } })).outcome).toMatchObject({ kind: 'none', reason: expect.stringMatching(/malformed/) });
    expect(await fetchWith(() => new Error('ECONNREFUSED')).outcome).toMatchObject({ kind: 'none', reason: expect.stringMatching(/unreachable/) });
  });
});

describe('loadMergedWeights', () => {
  it('falls back to the local weights when the server cannot be read', async () => {
    const { fetch } = fakeFetch(() => new Error('ECONNREFUSED'));
    const weights = await loadMergedWeights({
      rclVersion: '3.1.0',
      fetchImpl: fetch,
      env: ENV,
      cwd: '/nowhere',
      credentialsPath: '/nowhere/credentials.json',
      localStats: async () => [local('a', 30, 0.9)],
    });
    expect(weights.get('a')).toBe(1.4);
  });

  it('asks nothing of the server when it is switched off, and gives up on a slow one', async () => {
    const { fetch, requests } = fakeFetch(() => ({ status: 200, body: { data: serverStats([serverRow('a', 200, 0.7)]) } }));
    const off = await loadMergedWeights({
      rclVersion: '3.1.0',
      fetchImpl: fetch,
      env: ENV,
      cwd: '/nowhere',
      credentialsPath: '/nowhere/credentials.json',
      serverEnabled: false,
      localStats: async () => [local('a', 30, 0.9)],
    });
    expect(off.get('a')).toBe(1.4);
    expect(requests).toHaveLength(0);

    const slow = fakeFetch(() => 'hang');
    const bounded = await loadMergedWeights({
      rclVersion: '3.1.0',
      fetchImpl: slow.fetch,
      env: ENV,
      cwd: '/nowhere',
      credentialsPath: '/nowhere/credentials.json',
      timeoutMs: 50,
      localStats: async () => [local('a', 30, 0.9)],
    });
    expect(bounded.get('a')).toBe(1.4);
  });

  it('takes the server weight for a model with enough outcomes there', async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { data: serverStats([serverRow('a', 200, 0.7)]) } }));
    const weights = await loadMergedWeights({
      rclVersion: '3.1.0',
      fetchImpl: fetch,
      env: ENV,
      cwd: '/nowhere',
      credentialsPath: '/nowhere/credentials.json',
      localStats: async () => [local('a', 30, 0.9)],
    });
    expect(weights.get('a')).toBe(0.7);
  });
});
