import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'fs/promises';
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
    // Nothing landed outside the outbox either.
    const parent = await readdir(join(dir, '..'));
    expect(parent).not.toContain('escape');
    expect(parent).not.toContain('id');
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
    // A directory where the file should be fails every read, on every platform and as any user.
    const artifactPath = join(dir, envelope.run.id, 'artifacts', 'report_json.json');
    await rm(artifactPath);
    await mkdir(artifactPath);
    const summary0 = await outbox.flush(fakeSink({}).sink);
    expect(summary0.delivered).toEqual([]);
    expect(summary0.remaining).toEqual([envelope.run.id]);
    expect((await outbox.list())[0]!.meta.last_error).toMatch(/report_json unreadable/);
    await rm(artifactPath, { recursive: true });
    await writeFile(artifactPath, ARTIFACTS.report_json, 'utf8');

    const eventsId = await outbox.spoolEvents([buildEvent({ kind: 'loss' })]);
    await writeFile(join(dir, eventsId, 'events.json'), '{not json', 'utf8');
    const summary = await outbox.flush(fakeSink({}).sink);
    expect(summary.failed).toEqual(expect.arrayContaining([{ id: eventsId, reason: 'events.json malformed' }]));
    expect((await outbox.list()).find((e) => e.id === eventsId)?.failed?.reason).toBe('events.json malformed');
  });

  it('stops spooling artifacts above the cap, keeps the envelope, and reports each loss with a stable id on any later flush', async () => {
    const outbox = new Outbox(dir, { capBytes: 64 });
    const event = buildEvent({ kind: 'round_processed', convergeTarget: 't', round: 1, runId: envelope.run.id, payload: {} });
    const result = await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, events: [event] });
    expect(result.artifactsDropped).toEqual(['report_json', 'report_md']);
    // Envelope and events are always kept; only the artifacts were dropped.
    expect((await outbox.list())[0]).toMatchObject({ artifacts: [], events: 1, meta: { kind: 'run' } });
    expect(JSON.parse(await readFile(join(dir, envelope.run.id, 'envelope.json'), 'utf8')).run.id).toBe(envelope.run.id);
    const [loss] = await outbox.pendingLoss();
    expect(loss).toMatchObject({ kind: 'loss', payload: { reason: 'outbox_over_cap', run_id: envelope.run.id, kinds: ['report_json', 'report_md'] } });

    // The run's own events go through; the server is unreachable for the
    // loss report: it stays, id unchanged, and the flush says so.
    const down = fakeSink({ postEvents: [{ kind: 'ok', value: { inserted: 1, duplicates: 0 }, httpStatus: 201 }, { kind: 'unavailable', reason: 'HTTP 503' }] });
    expect(await outbox.flush(down.sink)).toMatchObject({ delivered: [envelope.run.id], stopped: 'unavailable', lossPending: 1 });
    expect((await outbox.pendingLoss())[0]!.id).toBe(loss!.id);

    // An otherwise empty flush still reports it, with the same id.
    const up = fakeSink({});
    const summary = await outbox.flush(up.sink);
    expect(summary.lossReported).toBe(1);
    // The run's own events go first; the loss report is the last events batch.
    const sent = up.calls.filter((c) => c.method === 'postEvents').at(-1)!.args[0] as WireEvent[];
    expect(sent[0]!.id).toBe(loss!.id);
    expect(await outbox.pendingLoss()).toEqual([]);
  });

  it('spools the artifact that fits when only the next one crosses the cap', async () => {
    // The cap counts the envelope file as written plus what this entry will hold.
    const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope, null, 2), 'utf8');
    const room = 100;
    const outbox = new Outbox(dir, { capBytes: envelopeBytes + Buffer.byteLength(ARTIFACTS.report_json) + room });
    const result = await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: { report_json: ARTIFACTS.report_json, report_md: '#'.repeat(room + 1) } });
    expect(result.artifactsDropped).toEqual(['report_md']);
    expect((await outbox.list())[0]!.artifacts).toEqual(['report_json']);
    expect((await outbox.pendingLoss())[0]!.payload).toMatchObject({ kinds: ['report_md'] });
  });

  it('keeps a loss report the server refuses on disk, uncounted, instead of pretending it was reported', async () => {
    const outbox = new Outbox(dir, { capBytes: 1 });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, envelopeDelivered: true });
    const [loss] = await outbox.pendingLoss();
    const refused = fakeSink({ postEvents: [{ kind: 'rejected', httpStatus: 422, error: 'validation_error', message: 'bad' }] });
    const summary = await outbox.flush(refused.sink);
    expect(summary.lossReported).toBeUndefined();
    expect(await outbox.pendingLoss()).toEqual([]);
    expect(await readdir(join(dir, 'loss'))).toEqual([`${loss!.id}.json.refused`]);

    // An org that switched evidence off has nobody to report to: the file goes, nothing is counted.
    await outbox.spoolRun({ runId: OTHER_RUN, envelope: { ...envelope, run: { ...envelope.run, id: OTHER_RUN } }, artifacts: ARTIFACTS, envelopeDelivered: true });
    const off = fakeSink({ postEvents: [{ kind: 'disabled', reason: 'reviews_disabled', message: 'off' }] });
    expect((await outbox.flush(off.sink)).lossReported).toBeUndefined();
    expect(await outbox.pendingLoss()).toEqual([]);
  });

  it('removes only what it delivered, so events another process queued mid-flush survive', async () => {
    const outbox = new Outbox(dir);
    const first = buildEvent({ kind: 'round_processed', convergeTarget: 't', round: 1, runId: envelope.run.id, payload: {} });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, events: [first] });
    const late = buildEvent({ kind: 'resolution', convergeTarget: 't', round: 1, runId: envelope.run.id, payload: {} });
    const { sink } = fakeSink({});
    // Another process (a second Outbox over the same directory) spools an
    // event for the same run while the events POST is in flight.
    const other = new Outbox(dir);
    const original = sink.postEvents.bind(sink);
    sink.postEvents = async (events: WireEvent[]) => {
      await other.spoolRun({ runId: envelope.run.id, envelope, events: [late], envelopeDelivered: true });
      return original(events);
    };
    // The late event keeps the entry: this pass delivered its snapshot, the entry itself remains.
    expect(await outbox.flush(sink)).toMatchObject({ delivered: [], remaining: [envelope.run.id] });
    const [kept] = await outbox.list();
    expect(kept).toMatchObject({ id: envelope.run.id, events: 1, artifacts: [], meta: { envelope_delivered: true } });
    const remaining = JSON.parse(await readFile(join(dir, envelope.run.id, 'events.json'), 'utf8')) as WireEvent[];
    expect(remaining.map((e) => e.id)).toEqual([late.id]);
  });

  it('counts an entry another process removed mid-flush as delivered, not as a crash', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS });
    const { sink } = fakeSink({});
    const original = sink.postRun.bind(sink);
    sink.postRun = async (posted: RunEnvelope) => {
      await outbox.remove(envelope.run.id);
      return original(posted);
    };
    expect(await outbox.flush(sink)).toEqual({ delivered: [envelope.run.id], remaining: [], failed: [] });
  });

  it('shows an interrupted spool as failed once it is old enough, never hiding its bytes', async () => {
    let clock = Date.now();
    const outbox = new Outbox(dir, { now: () => clock });
    const orphan = join(dir, OTHER_RUN);
    await mkdir(join(orphan, 'artifacts'), { recursive: true });
    await writeFile(join(orphan, 'envelope.json'), JSON.stringify(envelope), 'utf8');
    // Young: a spool in progress, not yet listed.
    expect(await outbox.list()).toEqual([]);
    const old = new Date(clock - 60 * 60 * 1000);
    await utimes(orphan, old, old);
    const [entry] = await outbox.list();
    expect(entry).toMatchObject({ id: OTHER_RUN, failed: { reason: expect.stringContaining('spool interrupted') }, meta: { kind: 'run' } });
    expect(entry!.bytes).toBeGreaterThan(0);
    const { sink, calls } = fakeSink({});
    expect((await outbox.flush(sink)).failed).toEqual([{ id: OTHER_RUN, reason: expect.stringContaining('spool interrupted') }]);
    expect(calls).toEqual([]);
    // Re-spooling the run repairs the entry.
    await outbox.spoolRun({ runId: OTHER_RUN, envelope: { ...envelope, run: { ...envelope.run, id: OTHER_RUN } } });
    clock += 1;
    expect((await outbox.list())[0]!.failed).toBeUndefined();
  });

  it('refuses an envelope whose run id differs from the entry id', async () => {
    const outbox = new Outbox(dir);
    await expect(outbox.spoolRun({ runId: OTHER_RUN, envelope })).rejects.toThrow(/does not match the entry id/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('never turns a crafted loss file into a path, and lists refused reports', async () => {
    const outbox = new Outbox(dir, { capBytes: 1 });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, envelopeDelivered: true });
    const [loss] = await outbox.pendingLoss();
    // A file whose name and id disagree, and one with a traversal id, are ignored.
    await writeFile(join(dir, 'loss', `${OTHER_RUN}.json`), JSON.stringify({ ...loss, id: '../../escape' }), 'utf8');
    await writeFile(join(dir, 'loss', 'escape.json'), JSON.stringify({ ...loss, id: '../escape' }), 'utf8');
    expect((await outbox.pendingLoss()).map((e) => e.id)).toEqual([loss!.id]);

    const refused = fakeSink({ postEvents: [{ kind: 'rejected', httpStatus: 422, error: 'validation_error', message: 'bad' }] });
    const summary = await outbox.flush(refused.sink);
    expect(summary.lossReported).toBeUndefined();
    expect(summary.lossPending).toBeUndefined();
    expect(await outbox.refusedLoss()).toEqual([`${loss!.id}.json.refused`]);
    expect(await readdir(join(dir, '..'))).not.toContain('escape');
    // The ignored files are left exactly where they were.
    expect(await readdir(join(dir, 'loss'))).toEqual(expect.arrayContaining([`${OTHER_RUN}.json`, 'escape.json']));
  });

  it('reports loss delivery that could not finish in the flush summary', async () => {
    const outbox = new Outbox(dir, { capBytes: 1 });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, envelopeDelivered: true });
    await outbox.spoolRun({ runId: OTHER_RUN, envelope: { ...envelope, run: { ...envelope.run, id: OTHER_RUN } }, artifacts: ARTIFACTS, envelopeDelivered: true });
    expect(await outbox.pendingLoss()).toHaveLength(2);

    // Unreachable for the loss report: nothing removed, the flush says so.
    const down = fakeSink({ postEvents: [{ kind: 'unavailable', reason: 'HTTP 503' }] });
    expect(await outbox.flush(down.sink)).toMatchObject({ delivered: [envelope.run.id, OTHER_RUN], stopped: 'unavailable', lossPending: 2 });

    const up = fakeSink({ postEvents: [{ kind: 'ok', value: { inserted: 1, duplicates: 1 }, httpStatus: 201 }] });
    expect(await outbox.flush(up.sink)).toMatchObject({ lossReported: 2 });
    expect(await outbox.pendingLoss()).toEqual([]);
  });

  it('keeps the whole entry, events included, when the server holds the run under a different digest', async () => {
    const outbox = new Outbox(dir);
    const event = buildEvent({ kind: 'round_processed', convergeTarget: 't', round: 1, runId: envelope.run.id, payload: {} });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, artifacts: ARTIFACTS, events: [event] });
    const conflict = fakeSink({ postRun: [{ kind: 'conflict', message: 'different digest' }] });
    const summary = await outbox.flush(conflict.sink);
    expect(summary.failed).toEqual([{ id: envelope.run.id, reason: 'conflict: different digest' }]);
    // The events name that run id too: attaching them to whatever the server holds would corrupt it.
    expect(conflict.calls.map((c) => c.method)).toEqual(['postRun']);
    expect((await outbox.list())[0]).toMatchObject({ events: 1, artifacts: ['report_json', 'report_md'], failed: { reason: 'conflict: different digest' } });
  });

  it('bounds every request by what remains of the flush deadline', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope });
    const timeouts: Array<number | undefined> = [];
    const { sink } = fakeSink({});
    const original = sink.postRun.bind(sink);
    sink.postRun = async (posted: RunEnvelope, options?: { timeoutMs?: number }) => {
      timeouts.push(options?.timeoutMs);
      return original(posted);
    };
    let tick = 0;
    await outbox.flush(sink, { deadlineMs: 5_000, now: () => (tick++ === 0 ? 0 : 1_200) });
    expect(timeouts).toEqual([3_800]);
  });

  it('marks an entry of unknown kind failed instead of deleting it', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope });
    await writeFile(join(dir, envelope.run.id, 'meta.json'), JSON.stringify({ kind: 'mystery', spooled_at: 'x', attempts: 0 }), 'utf8');
    const { sink, calls } = fakeSink({});
    expect((await outbox.flush(sink)).failed).toEqual([{ id: envelope.run.id, reason: expect.stringContaining('unknown entry kind') }]);
    expect(calls).toEqual([]);
    expect(await readdir(join(dir, envelope.run.id))).toContain('envelope.json');
  });

  it('stops at the deadline and leaves the rest for next time', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope });
    const other = buildRunEnvelope(sampleResult({ run: { ...envelope.run, id: OTHER_RUN } }), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    await outbox.spoolRun({ runId: other.run.id, envelope: other });

    let tick = 0;
    const { sink } = fakeSink({});
    // Clock: the flush start, the first entry's loop check and its pre-request check read 0; everything after is past the deadline.
    const summary = await outbox.flush(sink, { deadlineMs: 10, now: () => (tick++ < 3 ? 0 : 1_000) });
    expect(summary.delivered).toHaveLength(1);
    expect(summary.remaining).toHaveLength(1);
    expect(summary.stopped).toBe('deadline');
  });

  it('flushes one run without reading the others, and refuses a malformed id', async () => {
    const outbox = new Outbox(dir);
    await outbox.spoolRun({ runId: envelope.run.id, envelope });
    const other = buildRunEnvelope(sampleResult({ run: { ...envelope.run, id: OTHER_RUN } }), ARTIFACTS, { level: 'full', delivery: { mode: 'direct' } });
    await outbox.spoolRun({ runId: OTHER_RUN, envelope: other });
    const { sink, calls } = fakeSink({});
    expect(await outbox.flush(sink, { runId: OTHER_RUN })).toMatchObject({ delivered: [OTHER_RUN], remaining: [] });
    expect(calls).toHaveLength(1);
    expect((await outbox.list()).map((e) => e.id)).toEqual([envelope.run.id]);
    await expect(outbox.flush(sink, { runId: '../escape' })).rejects.toBeInstanceOf(OutboxError);
  });

  it('finishes an events entry whose events were already delivered instead of failing it', async () => {
    const outbox = new Outbox(dir);
    const id = await outbox.spoolEvents([buildEvent({ kind: 'attempt_claimed', convergeTarget: 't', attempt: 1, payload: { cap: 20 } })]);
    // An earlier pass delivered and dropped events.json but could not remove
    // the directory: a stray file was in it at the time.
    await rm(join(dir, id, 'events.json'));
    await writeFile(join(dir, id, 'stray.tmp'), '');
    const { sink, calls } = fakeSink({});
    expect(await outbox.flush(sink)).toMatchObject({ delivered: [], failed: [] });
    expect(calls).toEqual([]);
    // Once the stray file is gone the entry is finished and counted delivered.
    await rm(join(dir, id, 'stray.tmp'));
    expect(await outbox.flush(sink)).toMatchObject({ delivered: [id], failed: [] });
    expect(await readdir(dir)).not.toContain(id);
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
