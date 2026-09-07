import { chmod, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRunEnvelope, type RunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent, type WireEvent } from '../../src/telemetry/events.js';
import { Outbox, OutboxError } from '../../src/telemetry/outbox.js';
import type { HarnessSink, SinkOutcome } from '../../src/telemetry/sink.js';
import { sampleResult } from './fixtures.js';

const ARTIFACTS = { report_json: '{"r":1}', report_md: '# r' };
const OTHER_RUN = '019921a0-0000-7000-8000-000000000002';

/** A sink double recording every call; each method's outcomes are queued per call. */
function fakeSink(script: {
  postRun?: Array<SinkOutcome<{ id: string; url: string; artifacts_expected: string[]; status: 'created' | 'existing' }>>;
  putArtifact?: Array<SinkOutcome<{ kind: string; sha256: string; status: 'created' | 'existing' }>>;
  postEvents?: Array<SinkOutcome<{ inserted: number; duplicates: number }>>;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const next = <T>(queue: T[] | undefined, fallback: T): T => (queue && queue.length > 0 ? queue.shift()! : fallback);
  const ok = <T>(value: T): SinkOutcome<T> => ({ kind: 'ok', value, httpStatus: 201 });
  const sink = {
    baseUrl: 'https://harness.example.test',
    async postRun(envelope: RunEnvelope) {
      calls.push({ method: 'postRun', args: [envelope] });
      return next(script.postRun, ok({ id: envelope.run.id, url: `u/${envelope.run.id}`, artifacts_expected: ['report_json', 'report_md'], status: 'created' as const }));
    },
    async putArtifact(runId: string, kind: string, bytes: string) {
      calls.push({ method: 'putArtifact', args: [runId, kind, bytes] });
      return next(script.putArtifact, ok({ kind, sha256: 'x', status: 'created' as const }));
    },
    async postEvents(events: WireEvent[]) {
      calls.push({ method: 'postEvents', args: [events] });
      return next(script.postEvents, ok({ inserted: events.length, duplicates: 0 }));
    },
  };
  return { sink: sink as unknown as HarnessSink, calls };
}

describe('Outbox', () => {
  let dir: string;
  let envelope: RunEnvelope;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rcl-outbox-'));
    envelope = buildRunEnvelope(sampleResult(), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('spools a run and delivers it later as a retried delivery with its original id', async () => {
    const outbox = new Outbox(dir);
    const events = [buildEvent({ kind: 'round_processed', convergeTarget: 't', round: 1, runId: envelope.run.id, payload: {} })];
    expect(await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, events })).toEqual({ spooled: true, artifactsDropped: [] });

    const listed = await outbox.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: envelope.run.id, meta: { kind: 'run', attempts: 0 }, artifacts: ['report_json', 'report_md'], events: 1 });

    const { sink, calls } = fakeSink({});
    const summary = await outbox.flush(sink);
    expect(summary).toEqual({ delivered: [envelope.run.id], remaining: [], failed: [] });
    expect(calls.map((c) => c.method)).toEqual(['postRun', 'putArtifact', 'putArtifact', 'postEvents']);

    const retried = calls[0]!.args[0] as RunEnvelope;
    expect(retried.run.id).toBe(envelope.run.id);
    expect(retried.delivery.mode).toBe('retried');
    expect(retried.delivery.spooled_at).toBe(listed[0]!.meta.spooled_at);
    expect(calls[1]!.args).toEqual([envelope.run.id, 'report_json', ARTIFACTS.report_json]);
    expect((calls[3]!.args[0] as WireEvent[])[0]!.id).toBe(events[0]!.id);
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses ids that are not run or event entry ids, so no id becomes a path', async () => {
    const outbox = new Outbox(dir);
    await expect(outbox.spoolRun({ runId: '../../escape', envelope })).rejects.toBeInstanceOf(OutboxError);
    await expect(outbox.remove('..')).rejects.toBeInstanceOf(OutboxError);
    await expect(outbox.remove('events-not-a-uuid')).rejects.toBeInstanceOf(OutboxError);
    await expect(outbox.spoolEvents([{ ...buildEvent({ kind: 'loss' }), id: 'evil/../id' }])).rejects.toBeInstanceOf(OutboxError);
    expect(await readdir(dir)).toEqual([]);
  });

  it('merges events by id when a run is spooled again and drops artifacts already delivered', async () => {
    const outbox = new Outbox(dir);
    const first = buildEvent({ kind: 'round_processed', convergeTarget: 't', round: 1, runId: envelope.run.id, payload: {} });
    const second = buildEvent({ kind: 'resolution', convergeTarget: 't', round: 1, runId: envelope.run.id, payload: {} });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, events: [first] });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: { report_md: ARTIFACTS.report_md }, events: [second, first], envelopeDelivered: true });

    const [entry] = await outbox.list();
    expect(entry!.events).toBe(2);
    expect(entry!.artifacts).toEqual(['report_md']);
    expect(entry!.meta.envelope_delivered).toBe(true);

    const { sink, calls } = fakeSink({});
    await outbox.flush(sink);
    expect(calls.map((c) => c.method)).toEqual(['putArtifact', 'postEvents']);
    expect((calls[1]!.args[0] as WireEvent[]).map((e) => e.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('keeps an entry, its envelope marked delivered, when the artifacts cannot be uploaded yet', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS });
    const first = fakeSink({ putArtifact: [{ kind: 'unavailable', reason: 'HTTP 503' }] });
    expect(await outbox.flush(first.sink)).toMatchObject({ delivered: [], remaining: [envelope.run.id], stopped: 'unavailable' });

    const [entry] = await outbox.list();
    expect(entry!.meta.envelope_delivered).toBe(true);
    expect(entry!.meta.attempts).toBe(1);
    expect(entry!.meta.last_error).toBe('HTTP 503');
    expect(entry!.artifacts).toEqual(['report_json', 'report_md']);

    const second = fakeSink({});
    expect(await outbox.flush(second.sink)).toMatchObject({ delivered: [envelope.run.id] });
    expect(second.calls.map((c) => c.method)).toEqual(['putArtifact', 'putArtifact']);
  });

  it('marks an entry the server refuses for good and skips it afterwards', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS });
    const refused = fakeSink({ postRun: [{ kind: 'conflict', message: 'different digest' }] });
    expect(await outbox.flush(refused.sink)).toMatchObject({ failed: [{ id: envelope.run.id, reason: 'conflict: different digest' }] });

    const again = fakeSink({});
    expect(await outbox.flush(again.sink)).toMatchObject({ delivered: [], failed: [{ id: envelope.run.id }] });
    expect(again.calls).toEqual([]);
    expect((await outbox.list())[0]!.failed?.reason).toContain('different digest');
  });

  it('drops an entry the organization has switched off, at the envelope or an artifact', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope });
    await outbox.flush(fakeSink({ postRun: [{ kind: 'disabled', reason: 'reviews_disabled', message: 'off' }] }).sink);
    expect(await outbox.list()).toEqual([]);

    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, envelopeDelivered: true });
    await outbox.flush(fakeSink({ putArtifact: [{ kind: 'disabled', reason: 'reviews_disabled', message: 'off' }] }).sink);
    expect(await outbox.list()).toEqual([]);

    // A capped org keeps the entry going: the artifact is dropped, the rest delivers.
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, envelopeDelivered: true });
    const capped = fakeSink({ putArtifact: [{ kind: 'disabled', reason: 'artifacts_disabled', message: 'capped' }] });
    expect(await outbox.flush(capped.sink)).toMatchObject({ delivered: [envelope.run.id] });
  });

  it('never treats an unreadable or malformed file as delivered', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, envelopeDelivered: true });
    const artifactPath = join(dir, envelope.run.id, 'artifacts', 'report_json.json');
    await chmod(artifactPath, 0o000);
    try {
      const summary = await outbox.flush(fakeSink({}).sink);
      expect(summary.delivered).toEqual([]);
      expect(summary.remaining).toEqual([envelope.run.id]);
      expect((await outbox.list())[0]!.meta.last_error).toMatch(/report_json unreadable/);
    } finally {
      await chmod(artifactPath, 0o600);
    }

    const eventsId = await outbox.spoolEvents([buildEvent({ kind: 'loss' })]);
    await writeFile(join(dir, eventsId, 'events.json'), '{not json', 'utf8');
    const summary = await outbox.flush(fakeSink({}).sink);
    expect(summary.failed).toEqual(expect.arrayContaining([{ id: eventsId, reason: 'events.json malformed' }]));
    expect((await outbox.list()).find((e) => e.id === eventsId)?.failed?.reason).toBe('events.json malformed');
  });

  it('stops spooling artifacts above the cap, keeps the envelope, and reports each loss with a stable id on any later flush', async () => {
    const outbox = new Outbox(dir, { capBytes: 64 });
    const result = await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS });
    expect(result.artifactsDropped).toEqual(['report_json', 'report_md']);
    expect((await outbox.list())[0]!.artifacts).toEqual([]);
    const [loss] = await outbox.pendingLoss();
    expect(loss).toMatchObject({ kind: 'loss', payload: { reason: 'outbox_over_cap', run_id: envelope.run.id, kinds: ['report_json', 'report_md'] } });

    // The server is unreachable for the loss report: it stays, id unchanged.
    const down = fakeSink({ postEvents: [{ kind: 'unavailable', reason: 'HTTP 503' }] });
    await outbox.flush(down.sink);
    expect((await outbox.pendingLoss())[0]!.id).toBe(loss!.id);

    // An otherwise empty flush still reports it, with the same id.
    const up = fakeSink({});
    const summary = await outbox.flush(up.sink);
    expect(summary.lossReported).toBe(1);
    const sent = up.calls.find((c) => c.method === 'postEvents')!.args[0] as WireEvent[];
    expect(sent[0]!.id).toBe(loss!.id);
    expect(await outbox.pendingLoss()).toEqual([]);
  });

  it('stops at the deadline and leaves the rest for next time', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope });
    const other = buildRunEnvelope(sampleResult({ run: { ...envelope.run, id: OTHER_RUN } }), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    await outbox.spoolRun({ runId: other.run.id, envelope: other });

    let tick = 0;
    const { sink } = fakeSink({});
    // Clock: the flush start and the first entry's deadline check read 0; everything after is past the deadline.
    const summary = await outbox.flush(sink, { deadlineMs: 10, now: () => (tick++ < 2 ? 0 : 1_000) });
    expect(summary.delivered).toHaveLength(1);
    expect(summary.remaining).toHaveLength(1);
    expect(summary.stopped).toBe('deadline');
  });

  it('spools event batches of their own and delivers them', async () => {
    const outbox = new Outbox(dir);
    const events = [buildEvent({ kind: 'attempt_claimed', convergeTarget: 't', attempt: 3, payload: { cap: 20 } })];
    const id = await outbox.spoolEvents(events);
    expect(id).toBe(`events-${events[0]!.id}`);
    const { sink, calls } = fakeSink({});
    expect(await outbox.flush(sink)).toMatchObject({ delivered: [id] });
    expect(calls).toEqual([{ method: 'postEvents', args: [events] }]);
  });
});
