import { describe, expect, it, vi } from 'vitest';
import { RecoveryRequestBudget, type RecoveryClock } from '../../src/telemetry/recovery-request-budget.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { sampleResult } from './fixtures.js';

function clock(onSleep: (ms: number) => void = () => {}) {
  let time = 0;
  const waits: number[] = [];
  return { now: () => time, wallTime: () => Date.UTC(2026, 8, 23) + time, waits,
    sleep: async (ms: number) => { waits.push(ms); time += ms; onSleep(ms); } };
}
const credential = { url: 'https://synthetic.example.test', token: 'synthetic', source: 'login' as const };
const event = { id: '00000000-0000-7000-8000-000000000001', kind: 'finding_claim_split' as const,
  run_id: '00000000-0000-7000-8000-000000000002', occurred_at: '2026-09-23T00:00:00Z', payload: {} };

describe('recovery transport budget', () => {
  it.each(['run', 'events'] as const)('negotiates %s capability without consuming the reserved POST permit', async kind => {
    const budget = new RecoveryRequestBudget(clock());
    const methods: string[] = [];
    const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: budget, fetchImpl: async (_url, init) => {
      methods.push(init!.method!);
      if (init!.method === 'GET') return Response.json({ data: [], meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } });
      const body = JSON.parse(init!.body as string);
      return Response.json(kind === 'run'
        ? { data: { id: body.run.id, url: `${credential.url}/run`, artifacts_expected: [] } }
        : { data: { inserted: 1, duplicates: 0 } }, { status: 201 });
    } });
    const permit = await sink.reserveRecoveryWrite();
    const options = { recoveryWritePermit: permit };
    const report = sampleResult({ findings: [], belowThresholdFindings: [] });
    const envelope = buildRunEnvelope(report, { report_json: JSON.stringify(report) }, { level: 'full', delivery: { mode: 'direct' } });
    envelope.run.gating.bound_classification_protocol = 1;
    const outcome = kind === 'run' ? await sink.postRun(envelope, options)
      : await sink.postEvents([buildEvent({ kind: 'round_processed', round: 1,
        payload: { classification_version: 1, report_json_sha256: 'a'.repeat(64), identities: [] } })], options);
    expect(outcome).toMatchObject({ kind: 'ok', httpStatus: 201 });
    expect(methods).toEqual(['GET', 'POST']);
    expect(() => budget.consumeWrite(permit!)).toThrow('recovery_write_permit_invalid');
  });

  it('preserves the POST permit and sends no write when capability is unsupported', async () => {
    const budget = new RecoveryRequestBudget(clock());
    const methods: string[] = [];
    const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: budget, fetchImpl: async (_url, init) => {
      methods.push(init!.method!);
      return Response.json({ data: [], meta: { evidence_protocol_version: 1 } });
    } });
    const permit = await sink.reserveRecoveryWrite();
    const outcome = await sink.postEvents([buildEvent({ kind: 'round_processed', round: 1,
      payload: { classification_version: 1, report_json_sha256: 'a'.repeat(64), identities: [] } })], { recoveryWritePermit: permit });
    expect(outcome).toMatchObject({ kind: 'rejected', error: 'unsupported_bound_classification_protocol' });
    expect(methods).toEqual(['GET']);
    expect(() => budget.consumeWrite(permit!)).not.toThrow();
  });

  it('keeps a reserved POST slot available while arbitrarily many proof reads cross windows', async () => {
    const time = clock(); const budget = new RecoveryRequestBudget(time);
    const starts: number[] = [];
    for (let i = 0; i < 240; i++) { await budget.acquire(); starts.push(time.now()); }
    const permit = await budget.reserveWrite();
    expect(time.now()).toBeGreaterThanOrEqual(60_000);
    for (let i = 0; i < 700; i++) { await budget.acquire(); starts.push(time.now()); }
    const proofAt = time.now(); const waits = time.waits.length;
    budget.consumeWrite(permit); starts.push(time.now());
    expect(time.now()).toBe(proofAt);
    expect(time.waits).toHaveLength(waits);
    for (const at of starts) expect(starts.filter(start => start > at - 60_000 && start <= at).length).toBeLessThanOrEqual(240);
    expect(() => budget.consumeWrite(permit)).toThrow('recovery_write_permit_invalid');
  });

  it('serializes concurrent admissions against the same finite quota', async () => {
    const time = clock(); const budget = new RecoveryRequestBudget(time);
    let completed = 0;
    await Promise.all(Array.from({ length: 750 }, async () => { await budget.acquire(); completed++; }));
    expect(completed).toBe(750);
    expect(time.now()).toBeGreaterThanOrEqual(180_000);
  });

  it.each(['json', 'artifact'])('waits for actual Retry-After on %s GET before constructing the network signal', async path => {
    const time = clock(); let requests = 0;
    const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: new RecoveryRequestBudget(time), fetchImpl: async (_url, init) => {
      expect(init?.signal?.aborted).toBe(false);
      if (++requests === 1) return Response.json({ error: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '13' } });
      expect(time.now()).toBeGreaterThanOrEqual(13_000);
      return path === 'json' ? Response.json({ data: { verified: true }, meta: {} }) : new Response('source', {
        headers: { 'x-artifact-sha256': '41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d' },
      });
    } });
    const result = path === 'json' ? await sink.getJson('/read', data => data, { requireCompleteRead: true }) : await sink.getArtifact(event.run_id, 'report_json', 100);
    expect(result).toMatchObject({ kind: 'ok' });
    expect(requests).toBe(2);
    expect(time.waits).toEqual([13_000]);
  });

  it.each([null, '-1', 'Infinity', '99999999999999999999', 'invalid', '61'])('refuses invalid or over-bound Retry-After %s without another request', async retryAfter => {
    const time = clock(); let requests = 0;
    const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: new RecoveryRequestBudget(time), fetchImpl: async () => {
      requests++; return Response.json({}, { status: 429, headers: retryAfter === null ? {} : { 'Retry-After': retryAfter } });
    } });
    expect(await sink.getJson('/read', data => data)).toMatchObject({ kind: 'unavailable', httpStatus: 429 });
    expect(requests).toBe(1); expect(time.waits).toEqual([]);
  });

  it('honors an HTTP-date using the response Date and stops sustained competing traffic within a fixed allowance', async () => {
    const time = clock(); let requests = 0;
    const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: new RecoveryRequestBudget(time), fetchImpl: async () => {
      requests++; return Response.json({}, { status: 429, headers: {
        Date: new Date(time.wallTime()).toUTCString(), 'Retry-After': new Date(time.wallTime() + 10_000).toUTCString(),
      } });
    } });
    expect(await sink.getJson('/read', data => data)).toMatchObject({ kind: 'unavailable', httpStatus: 429 });
    expect(requests).toBe(4); expect(time.waits).toEqual([10_000, 10_000, 10_000]);
  });

  it('reports a rate-limited POST once and delays the next proof read without retrying the write', async () => {
    const time = clock(); const methods: string[] = [];
    const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: new RecoveryRequestBudget(time), fetchImpl: async (_url, init) => {
      methods.push(init!.method!);
      if (init!.method === 'POST') return Response.json({}, { status: 429, headers: { 'Retry-After': '13' } });
      expect(time.now()).toBeGreaterThanOrEqual(13_000);
      return Response.json({ data: [], meta: {} });
    } });
    const permit = await sink.reserveRecoveryWrite();
    expect(await sink.postEvents([event], { recoveryWritePermit: permit })).toMatchObject({ kind: 'unavailable', httpStatus: 429, retryAfterMs: 13_000 });
    expect(await sink.getJson('/receipt', data => data)).toMatchObject({ kind: 'ok' });
    expect(methods).toEqual(['POST', 'GET']);
  });

  it('leaves ordinary transport unpaced and does not retry its 429', async () => {
    let requests = 0;
    const sink = new HarnessSink({ credential, rclVersion: 'test', fetchImpl: async () => {
      requests++; return Response.json({}, { status: 429, headers: { 'Retry-After': '13' } });
    } });
    expect(await sink.getJson('/read', data => data)).toEqual({ kind: 'unavailable', reason: 'HTTP 429' });
    expect(requests).toBe(1);
    expect(await sink.reserveRecoveryWrite()).toBeUndefined();
  });

  it('creates its ten-second network timeout only after quota admission', async () => {
    const sequence: string[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const time = clock(ms => { sequence.push('quota wait'); vi.advanceTimersByTime(ms); });
    const budget = new RecoveryRequestBudget(time);
    for (let i = 0; i < 240; i++) await budget.acquire();
    try {
      const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: budget,
        fetchImpl: async (_url, init) => {
          sequence.push('fetch');
          expect(init?.signal?.aborted).toBe(false);
          return Response.json({ data: [] });
        } });
      expect(await sink.getJson('/read', data => data)).toMatchObject({ kind: 'ok' });
      expect(sequence).toEqual(['quota wait', 'fetch']);
      expect(time.now()).toBeGreaterThanOrEqual(60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('cancels the default scheduler timer during artifact quota admission', async () => {
    // Use the production timers/promises scheduler, not an injected sleep that
    // immediately advances time. One real second bounds cleanup on a failing run.
    const budget = new RecoveryRequestBudget();
    budget.rateLimited('1', null);
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('cancelled admission reached transport'); });
    const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: budget, fetchImpl });
    const activeTimers = () => process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
    const before = activeTimers();
    const pending = sink.getArtifact(event.run_id, 'report_json', 100, { signal: controller.signal });
    try {
      expect(activeTimers()).toBe(before + 1);
      controller.abort(new Error('workflow stopped while quota was waiting'));
      await expect(pending).resolves.toMatchObject({ kind: 'unavailable' });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(activeTimers()).toBe(before);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it('does not perform I/O if its quota wait is interrupted', async () => {
    const time = clock(); const interrupted: RecoveryClock = { ...time, sleep: async () => { throw new Error('cancelled'); } };
    const budget = new RecoveryRequestBudget(interrupted);
    for (let i = 0; i < 240; i++) await budget.acquire();
    let requests = 0;
    const sink = new HarnessSink({ credential, rclVersion: 'test', requestBudget: budget,
      fetchImpl: async () => { requests++; return Response.json({ data: {} }); } });
    expect(await sink.getJson('/read', data => data)).toMatchObject({ kind: 'unavailable' });
    expect(requests).toBe(0);
  });
});
