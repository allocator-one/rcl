import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessSink, type RequestOptions, type SinkOptions } from '../../src/telemetry/sink.js';
import { createTelemetryRuntime } from '../../src/telemetry/deliver.js';
import { openReadSink } from '../../src/telemetry/read-sink.js';

const credential = { url: 'https://harness.example.test', token: 'local-fixture', source: 'env' as const };
const attested = { ...credential, token: 'rbc_fixture', source: 'attest' as const };
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

/** Real sink/Response/AbortSignal behavior with only transport delay virtualized. */
function transport(delay: number, bytes = 'original evidence') {
  const calls: RequestInit[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    calls.push(init!);
    await new Promise<void>((resolve, reject) => {
      const signal = init!.signal!;
      if (signal.aborted) { reject(signal.reason); return; }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
    return init!.method === 'PUT'
      ? Response.json({ data: { kind: 'report_json', sha256: digest(String(init!.body)) } }, { status: 201 })
      : new Response(bytes, { headers: { 'x-artifact-sha256': digest(bytes) } });
  });
  return { calls, fetchImpl };
}

function sink(fetchImpl: typeof fetch, options: Partial<SinkOptions> = {}) {
  return new HarnessSink({ credential, rclVersion: '4.1.4', fetchImpl, ...options });
}

function transfer(client: HarnessSink, method: 'PUT' | 'GET', options: RequestOptions = {}) {
  return method === 'PUT'
    ? client.putArtifact('same-run', 'report_json', 'original evidence', options)
    : client.getArtifact('same-run', 'report_json', 25_000_000, options);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-09-26T00:00:00.000Z'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded artifact transfer budget', () => {
  it('keeps a far-future attested expiry from aborting a delayed transfer', async () => {
    vi.useRealTimers();
    const t = transport(20);
    const result = await transfer(sink(t.fetchImpl, {
      credential: attested, attestedExpiresAt: '2999-01-01T00:00:00Z',
    }), 'GET');

    expect(result).toMatchObject({ kind: 'ok', value: { sha256: digest('original evidence') } });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.signal!.aborted).toBe(false);
  });

  it('uploads the maximum supported artifact after ten seconds without changing its bytes', async () => {
    const bytes = 'x'.repeat(25_000_000);
    const t = transport(15_000);
    const result = sink(t.fetchImpl).putArtifact('same-run', 'report_json', bytes);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ kind: 'ok', value: { sha256: digest(bytes) } });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ body: bytes, redirect: 'manual' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the ordinary request ten-second default', async () => {
    const t = transport(15_000);
    const result = sink(t.fetchImpl).getJson('/api/v1/reviews/model-stats', () => ({}));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ kind: 'unavailable' });
    expect(t.calls[0]!.signal!.aborted).toBe(true);
  });

  for (const method of ['PUT', 'GET'] as const) {
    it(`${method} allows longer transfers only within a known attested lifetime`, async () => {
      const t = transport(15_000);
      const result = transfer(sink(t.fetchImpl, { credential: attested, attestedExpiresAt: '2026-09-26T00:02:00Z' }), method);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ kind: 'ok' });
    });

    it(`${method} refuses an already cancelled workflow before fetch`, async () => {
      const t = transport(0);
      const result = transfer(sink(t.fetchImpl), method, { signal: AbortSignal.abort() });
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ kind: 'unavailable' });
      expect(t.fetchImpl).not.toHaveBeenCalled();
    });

    it(`${method} completes after ten seconds with matching exact evidence`, async () => {
      const t = transport(15_000);
      const result = transfer(sink(t.fetchImpl), method);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ kind: 'ok', value: { sha256: digest('original evidence') } });
      expect(t.calls[0]!.signal!.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`${method} has a finite 120-second ceiling even if a caller requests longer`, async () => {
      const t = transport(121_000);
      const result = transfer(sink(t.fetchImpl, { timeoutMs: 900_000 }), method, { timeoutMs: 900_000 });
      await vi.advanceTimersByTimeAsync(121_000);
      expect(await result).toMatchObject({ kind: 'unavailable' });
      expect(t.calls[0]!.signal!.aborted).toBe(true);
    });

    it(`${method} honors explicit sink and shorter operation ceilings`, async () => {
      for (const options of [{}, { timeoutMs: 200 }]) {
        const t = transport(1_000);
        const result = transfer(sink(t.fetchImpl, { timeoutMs: 500 }), method, options);
        await vi.advanceTimersByTimeAsync(options.timeoutMs ?? 500);
        expect(t.calls[0]!.signal!.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await result).toMatchObject({ kind: 'unavailable' });
      }
    });

    it(`${method} preserves external workflow cancellation`, async () => {
      const t = transport(1_000);
      const controller = new AbortController();
      const result = transfer(sink(t.fetchImpl), method, { signal: controller.signal });
      controller.abort(new Error('workflow deadline'));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toMatchObject({ kind: 'unavailable' });
      expect(t.calls[0]!.signal!.reason.message).toBe('workflow deadline');
    });

    it(`${method} caps legacy attested credentials with unknown expiry at ten seconds`, async () => {
      const t = transport(15_000);
      const result = transfer(sink(t.fetchImpl, { credential: attested }), method);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ kind: 'unavailable' });
    });

    it(`${method} respects known expiry even when the wall clock moves backwards`, async () => {
      const t = transport(15_000);
      const client = sink(t.fetchImpl, { credential: attested, attestedExpiresAt: '2026-09-26T00:00:01.000Z' });
      await vi.advanceTimersByTimeAsync(600);
      vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
      const result = transfer(client, method);
      await vi.advanceTimersByTimeAsync(400);
      expect(t.calls[0]!.signal!.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ kind: 'unavailable' });
    });

    it(`${method} refuses expired or malformed expiry before transport`, async () => {
      for (const attestedExpiresAt of ['2026-09-25T23:59:59Z', '2026-02-31T00:00:00Z', 'invalid']) {
        const t = transport(0);
        const result = transfer(sink(t.fetchImpl, { credential: attested, attestedExpiresAt }), method);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toMatchObject({ kind: 'unavailable' });
        expect(t.fetchImpl).not.toHaveBeenCalled();
      }
    });
  }

  it('passes known attested expiry through delivery and read-only runtime construction', async () => {
    const t = transport(15_000);
    const options = { credential: attested, attestedExpiresAt: '2026-09-26T00:00:01Z', rclVersion: '4.1.4', fetchImpl: t.fetchImpl, env: {} };
    const runtime = await createTelemetryRuntime({ ...options, config: { harness: { telemetry: 'full' } }, dataDir: '/unused/local-artifact-test', stderr: () => {} });
    const read = await openReadSink(options);
    const upload = transfer(runtime.sink!, 'PUT');
    const download = transfer(read.sink!, 'GET');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.calls.map(call => call.signal!.aborted)).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await upload).toMatchObject({ kind: 'unavailable' });
    expect(await download).toMatchObject({ kind: 'unavailable' });
  });

  it('keeps the readback deadline active until the response body finishes', async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (_url, init) => new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(Buffer.from('original '));
        init!.signal!.addEventListener('abort', () => stream.error(init!.signal!.reason), { once: true });
      },
    }), { headers: { 'x-artifact-sha256': digest('original evidence') } });
    const pending = transfer(sink(fetchImpl), 'GET', { signal: controller.signal, timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ kind: 'unavailable' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
