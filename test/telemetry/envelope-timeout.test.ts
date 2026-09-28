import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTelemetryRuntime, flushOutbox } from '../../src/telemetry/deliver.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { HarnessSink, type SinkOptions } from '../../src/telemetry/sink.js';
import { sampleResult } from './fixtures.js';

const credential = { url: 'https://synthetic.invalid', token: 'fixture-token', source: 'login' as const };
const report = sampleResult({ findings: [], belowThresholdFindings: [] });
const artifacts = { report_json: JSON.stringify(report), report_md: '# Original report\n' };
const envelope = buildRunEnvelope(report, artifacts, { level: 'full', delivery: { mode: 'direct' } });
const dirs: string[] = [];
type EnvelopeOptions = Partial<SinkOptions> & { envelopeTimeoutMs?: number };

function transport(delay: number, status = 200) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let started!: () => void;
  const firstRequest = new Promise<void>(resolve => { started = resolve; });
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    started();
    await new Promise<void>((resolve, reject) => {
      const signal = init!.signal!;
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const body = String(init!.body);
    const data = init!.method === 'PUT'
      ? { kind: String(url).split('/').at(-1), sha256: createHash('sha256').update(body).digest('hex') }
      : { id: envelope.run.id, url: `${credential.url}/run`, artifacts_expected: ['report_json', 'report_md'] };
    return Response.json(status === 200 ? { data, meta: { status: 'existing' } } : { error: 'refused' }, { status });
  });
  return { fetchImpl, requests, firstRequest };
}

function sink(fetchImpl: typeof fetch, options: EnvelopeOptions = {}) {
  return new HarnessSink({ credential, rclVersion: '4.4.2', fetchImpl, ...options });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it('keeps the default envelope ceiling at ten seconds', async () => {
  const t = transport(15_000);
  const pending = sink(t.fetchImpl).postRun(envelope);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(t.requests[0]!.init.signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ kind: 'unavailable' });
  expect(t.requests[0]!.init.signal!.aborted).toBe(true);
});

it('accepts a delayed idempotent receipt with an envelope-only override', async () => {
  const t = transport(15_000);
  const pending = sink(t.fetchImpl, { envelopeTimeoutMs: 30_000 }).postRun(envelope);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toMatchObject({ kind: 'ok', value: { id: envelope.run.id, status: 'existing' } });
  expect(t.requests[0]!.init.body).toBe(JSON.stringify(envelope));
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['read', 'events'] as const)('does not extend the ordinary %s ceiling', async kind => {
  const t = transport(15_000);
  const client = sink(t.fetchImpl, { envelopeTimeoutMs: 30_000 });
  const pending = kind === 'read' ? client.getJson('/api/v1/reviews/runs', () => ({}))
    : client.postEvents([buildEvent({ kind: 'attempt_claimed', attempt: 1 })]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toMatchObject({ kind: 'unavailable' });
  expect(t.requests[0]!.init.signal!.aborted).toBe(true);
});

it('keeps artifact transfers at their separate 120-second ceiling', async () => {
  const t = transport(119_000);
  const client = sink(t.fetchImpl, { envelopeTimeoutMs: 30_000 });
  const pending = client.putArtifact(envelope.run.id, 'report_md', artifacts.report_md);
  await vi.advanceTimersByTimeAsync(119_000);
  expect(await pending).toMatchObject({ kind: 'ok' });
  const slow = transport(121_000);
  const expired = sink(slow.fetchImpl, { envelopeTimeoutMs: 30_000 })
    .putArtifact(envelope.run.id, 'report_md', artifacts.report_md);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await expired).toMatchObject({ kind: 'unavailable' });
});

it.each(['sink', 'operation', 'attested', 'legacy-attested'] as const)('honors a shorter %s limit', async limit => {
  const t = transport(15_000);
  const client = sink(t.fetchImpl, {
    envelopeTimeoutMs: 30_000,
    ...(limit === 'sink' ? { timeoutMs: 500 } : {}),
    ...(limit.includes('attested') ? { credential: { ...credential, token: 'rbc_fixture', source: 'attest' as const } } : {}),
    ...(limit === 'attested' ? { attestedExpiresAt: '2026-09-28T00:00:00.500Z' } : {}),
  });
  const pending = client.postRun(envelope, limit === 'operation' ? { timeoutMs: 500 } : {});
  await vi.advanceTimersByTimeAsync(limit === 'legacy-attested' ? 10_000 : 500);
  expect(t.requests[0]!.init.signal!.aborted).toBe(true);
  expect(await pending).toMatchObject({ kind: 'unavailable' });
});

it('keeps the remaining operation budget after capability preflight', async () => {
  const t = transport(450);
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await t.fetchImpl(url, init);
    return init!.method === 'GET'
      ? Response.json({ data: [], meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } }) : response;
  };
  const bound = structuredClone(envelope);
  bound.run.gating.bound_classification_protocol = 1;
  const pending = sink(fetchImpl, { envelopeTimeoutMs: 30_000 }).postRun(bound, { timeoutMs: 500 });
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({ kind: 'unavailable' });
  expect(t.requests.map(r => r.init.method)).toEqual(['GET', 'POST']);
  expect(t.requests[1]!.init.signal!.aborted).toBe(true);
});

it('does not extend attested validity when the wall clock moves backwards', async () => {
  const t = transport(15_000);
  const client = sink(t.fetchImpl, { envelopeTimeoutMs: 30_000,
    credential: { ...credential, token: 'rbc_fixture', source: 'attest' },
    attestedExpiresAt: '2026-09-28T00:00:01Z' });
  await vi.advanceTimersByTimeAsync(600);
  vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
  const pending = client.postRun(envelope);
  await vi.advanceTimersByTimeAsync(400);
  expect(await pending).toMatchObject({ kind: 'unavailable' });
  expect(t.requests[0]!.init.signal!.aborted).toBe(true);
});

it.each(['2026-09-27T00:00:00Z', 'invalid'])('refuses an unusable attested expiry %s before transport', async attestedExpiresAt => {
  const t = transport(0);
  const client = sink(t.fetchImpl, { envelopeTimeoutMs: 30_000,
    credential: { ...credential, token: 'rbc_fixture', source: 'attest' }, attestedExpiresAt });
  expect(await client.postRun(envelope)).toMatchObject({ kind: 'unavailable' });
  expect(t.fetchImpl).not.toHaveBeenCalled();
});

it('rechecks credential expiry after capability preflight when the wall clock advances', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    requests.push(init!.method!);
    vi.setSystemTime(new Date('2026-09-28T00:00:02Z'));
    return Response.json({ data: { models: [] }, meta: { evidence_protocol_version: 2, bound_classification_protocol: 1 } });
  };
  const client = sink(fetchImpl, { envelopeTimeoutMs: 30_000,
    credential: { ...credential, token: 'rbc_fixture', source: 'attest' },
    attestedExpiresAt: '2026-09-28T00:00:01Z' });
  const bound = structuredClone(envelope);
  bound.run.gating.bound_classification_protocol = 1;
  expect(await client.postRun(bound)).toMatchObject({ kind: 'unavailable' });
  expect(requests).toEqual(['GET']);
});

it.each([409, 422])('keeps HTTP %s as a failed delivery after the longer wait', async status => {
  const t = transport(15_000, status);
  const pending = sink(t.fetchImpl, { envelopeTimeoutMs: 30_000 }).postRun(envelope);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toMatchObject({ kind: status === 409 ? 'conflict' : 'rejected' });
  expect(t.requests).toHaveLength(1);
});

it.each([0, -1, NaN, Infinity, 0.5, 120_001])('rejects invalid runtime timeout %s before reading runtime inputs', async envelopeTimeoutMs => {
  const fetchImpl = vi.fn<typeof fetch>();
  const cwd = vi.fn(() => { throw new Error('runtime was opened'); });
  const options = { rclVersion: '4.4.2', envelopeTimeoutMs, fetchImpl, get cwd(): string { return cwd(); } };
  await expect(createTelemetryRuntime(options)).rejects.toThrow(/envelope.*timeout.*120000/i);
  expect(cwd).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(() => sink(fetchImpl, { envelopeTimeoutMs })).toThrow(/envelope.*timeout.*120000/i);
});

it.each(['supplied', 'resolved'] as const)('threads the override through %s runtime credentials and delivers exact spooled artifacts', async source => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcl-envelope-timeout-'));
  dirs.push(dataDir);
  const t = transport(0);
  const post = transport(15_000);
  const fetchImpl: typeof fetch = (url, init) => init?.method === 'POST' ? post.fetchImpl(url, init) : t.fetchImpl(url, init);
  const options = { rclVersion: '4.4.2', dataDir, cwd: dataDir, config: {}, requireRepo: false, stderr: () => {},
    envelopeTimeoutMs: 30_000, fetchImpl, env: source === 'resolved'
      ? { HARNESS_API_URL: credential.url, HARNESS_API_TOKEN: credential.token } : {},
    ...(source === 'supplied' ? { credential } : {}) };
  const runtime = await createTelemetryRuntime(options);
  await runtime.outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts });
  const pending = flushOutbox(runtime, { runId: envelope.run.id });
  await post.firstRequest;
  await vi.advanceTimersByTimeAsync(15_000);
  // The outbox reads retained artifact files between requests.
  await vi.waitFor(() => expect(t.requests).toHaveLength(2));
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ delivered: [envelope.run.id], remaining: [], failed: [] });
  expect(t.requests.map(r => r.init.body)).toEqual([artifacts.report_json, artifacts.report_md]);
  const posted = JSON.parse(String(post.requests[0]!.init.body));
  expect(posted.run).toEqual(envelope.run);
  expect(posted.calls).toEqual(envelope.calls);
  expect(posted.artifacts_declared).toEqual(envelope.artifacts_declared);
});

it('retains the original envelope, artifacts and native accounting when the extended request times out', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcl-envelope-timeout-'));
  dirs.push(dataDir);
  const t = transport(31_000);
  const options = { rclVersion: '4.4.2', dataDir, config: {}, env: {}, credential, stderr: () => {},
    envelopeTimeoutMs: 30_000, fetchImpl: t.fetchImpl };
  const runtime = await createTelemetryRuntime(options);
  await runtime.outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts });
  const files = ['envelope.json', 'artifacts/report_json.json', 'artifacts/report_md.md'];
  const snapshot = () => Promise.all(files.map(file => readFile(join(dataDir, 'outbox', envelope.run.id, file), 'utf8')));
  const original = await snapshot();
  const pending = flushOutbox(runtime, { runId: envelope.run.id });
  await t.firstRequest;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await pending).toMatchObject({ delivered: [], remaining: [envelope.run.id], failed: [] });
  expect(await snapshot()).toEqual(original);
  expect(t.requests).toHaveLength(1);
});
