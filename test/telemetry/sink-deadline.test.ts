import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildEvent } from '../../src/telemetry/events.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { HarnessSink, type RequestOptions } from '../../src/telemetry/sink.js';
import { sampleResult } from './fixtures.js';

const credential = { url: 'https://synthetic.invalid', token: 'synthetic-token', source: 'login' as const };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  // Native AbortSignal timers are not controlled by fake timers. Drive real
  // AbortSignals with the same fake clock as the transport, including rejection.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function reply(method: string, body?: string): Response {
  return Response.json(method === 'GET'
    ? { data: [], meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } }
    : body && 'run' in JSON.parse(body)
      ? { data: { id: JSON.parse(body).run.id, url: 'https://synthetic.invalid/run', artifacts_expected: [] } }
      : { data: { inserted: 1, duplicates: 0 } }, { status: method === 'GET' ? 200 : 201 });
}

function transport(getMs: number, postMs: number) {
  const requests: { method: string; started: number; aborted?: number }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const method = init!.method!;
    const request = { method, started: performance.now() } as (typeof requests)[number];
    requests.push(request);
    return new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!;
      const abort = () => {
        request.aborted = performance.now();
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve(reply(method, init!.body as string | undefined));
      }, method === 'GET' ? getMs : postMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  return { requests, fetchImpl };
}

function deliver(kind: 'run' | 'events', fetchImpl: typeof fetch, options: RequestOptions) {
  const sink = new HarnessSink({ credential, rclVersion: '3.8.0', fetchImpl });
  if (kind === 'run') {
    const report = sampleResult({ findings: [], belowThresholdFindings: [] });
    const envelope = buildRunEnvelope(report, { report_json: JSON.stringify(report) },
      { level: 'full', delivery: { mode: 'direct' } });
    envelope.run.gating.bound_classification_protocol = 1;
    return sink.postRun(envelope, options);
  }
  return sink.postEvents([buildEvent({ kind: 'round_processed', round: 1,
    payload: { classification_version: 1, report_json_sha256: 'a'.repeat(64), identities: [] } })], options);
}

it.each(['run', 'events'] as const)('aborts a %s POST at the remaining operation deadline after a slow capability GET', async kind => {
  const fake = transport(4500, 1000);
  let outcome: unknown;
  void deliver(kind, fake.fetchImpl, { timeoutMs: 5000 }).then(value => { outcome = value; });
  await vi.advanceTimersByTimeAsync(4500);
  expect(fake.requests).toEqual([{ method: 'GET', started: 0 }, { method: 'POST', started: 4500 }]);
  await vi.advanceTimersByTimeAsync(499);
  expect(outcome).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(outcome).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('TimeoutError') });
  expect(fake.requests[1]!.aborted).toBe(5000);
  expect(vi.mocked(AbortSignal.timeout).mock.calls.map(([ms]) => ms)).toEqual([5000, 500]);
});

it.each(['run', 'events'] as const)('does not start a %s POST after a late successful capability read exhausts the allowance', async kind => {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    methods.push(init!.method!);
    // An injected transport can settle successfully after its signal expires.
    // The delivery must still enforce its deadline before starting a write.
    if (init!.method === 'GET') vi.advanceTimersByTime(5001);
    return reply(init!.method!, init!.body as string | undefined);
  };
  expect(await deliver(kind, fetchImpl, { timeoutMs: 5000 })).toMatchObject({
    kind: 'unavailable', reason: 'delivery_deadline_exceeded',
  });
  expect(methods).toEqual(['GET']);
});

it.each(['run', 'events'] as const)('keeps normal per-request timeout behavior for %s without an explicit operation budget', async kind => {
  const fake = transport(4500, 4500);
  let outcome: unknown;
  void deliver(kind, fake.fetchImpl, {}).then(value => { outcome = value; });
  await vi.advanceTimersByTimeAsync(9000);
  expect(outcome).toMatchObject({ kind: 'ok' });
  expect(fake.requests).toEqual([{ method: 'GET', started: 0 }, { method: 'POST', started: 4500 }]);
  expect(vi.mocked(AbortSignal.timeout).mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000]);
});

it('still bounds an ungated event POST by the supplied allowance', async () => {
  const fake = transport(0, 6000);
  const sink = new HarnessSink({ credential, rclVersion: '3.8.0', fetchImpl: fake.fetchImpl });
  let outcome: unknown;
  void sink.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1 })], { timeoutMs: 5000 })
    .then(value => { outcome = value; });
  await vi.advanceTimersByTimeAsync(5000);
  expect(outcome).toMatchObject({ kind: 'unavailable' });
  expect(fake.requests).toEqual([{ method: 'POST', started: 0, aborted: 5000 }]);
});
