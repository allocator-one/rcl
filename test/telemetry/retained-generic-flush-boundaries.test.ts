import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent, type WireEvent } from '../../src/telemetry/events.js';
import { flushOutbox, type TelemetryRuntime } from '../../src/telemetry/deliver.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { ReviewerDeliveryQueue } from '../../src/telemetry/reviewer-delivery.js';
import type { HarnessSink } from '../../src/telemetry/sink.js';
import { sampleResult } from './fixtures.js';

const RUN_ID = '019921a0-0000-7000-8000-000000000001';
const OTHER_RUN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const roots: string[] = [];
const lockControl = vi.hoisted(() => ({
  expireReviewer: false,
  identity: undefined as string | undefined,
  permitFirst: false,
  calls: 0,
}));
vi.mock('../../src/evidence/original-run/lock.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/evidence/original-run/lock.js')>(
    '../../src/evidence/original-run/lock.js');
  const withRecoveryLock: typeof actual.withRecoveryLock = (root, identity, work, hooks = {}) => {
    if (!lockControl.expireReviewer || !root.includes('/reviewer-outbox/locks') ||
        identity.toLowerCase() !== lockControl.identity?.toLowerCase()) {
      return actual.withRecoveryLock(root, identity, work, hooks);
    }
    if (lockControl.permitFirst && lockControl.calls++ === 0) return actual.withRecoveryLock(root, identity, work, hooks);
    let clock = 0;
    return actual.withRecoveryLock(root, identity, work, {
      ...hooks,
      now: () => { clock += 6_000; return clock; },
      wait: async () => undefined,
    });
  };
  return { ...actual, withRecoveryLock };
});
afterEach(async () => {
  lockControl.expireReviewer = false;
  lockControl.identity = undefined;
  lockControl.permitFirst = false;
  lockControl.calls = 0;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function transport(eventOutcome?: (events: WireEvent[]) => unknown) {
  const eventBatches: WireEvent[][] = [], runs: string[] = [];
  const sink = {
    baseUrl: 'https://harness.example.test', credentialSource: 'login',
    async postRun(envelope: { run: { id: string } }) {
      runs.push(envelope.run.id);
      return { kind: 'ok', httpStatus: 201, value: { id: envelope.run.id, url: `u/${envelope.run.id}`,
        artifacts_expected: [], status: 'created' } } as const;
    },
    async putArtifact() {
      return { kind: 'ok', httpStatus: 201,
        value: { kind: 'report_json', sha256: 'x', status: 'created' } } as const;
    },
    async postEvents(events: WireEvent[]) {
      eventBatches.push(structuredClone(events));
      return eventOutcome?.(events) ?? { kind: 'ok', httpStatus: 201,
        value: { inserted: events.length, duplicates: 0 } as const };
    },
  } as unknown as HarnessSink;
  return { sink, eventBatches, runs };
}

async function runtime(sink: HarnessSink): Promise<TelemetryRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'rcl-generic-flush-boundary-')); roots.push(dataDir);
  return { level: 'findings', repoManaged: true, parseFailures: false,
    credential: { url: 'https://harness.example.test', token: 'token', source: 'login' },
    sink, outbox: new Outbox(join(dataDir, 'outbox')), dataDir, rclVersion: 'test', stderr: vi.fn() };
}

async function arm(dataDir: string, runId = RUN_ID): Promise<void> {
  const directory = join(dataDir, 'reviewer-outbox', runId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'activation-intent.json'), '{"activation":true}', { mode: 0o600 });
}

function expireContendedAcquisition(identity = RUN_ID, permitFirst = false) {
  lockControl.expireReviewer = true;
  lockControl.identity = identity;
  lockControl.permitFirst = permitFirst;
  lockControl.calls = 0;
  return { mockRestore: () => {
    lockControl.expireReviewer = false;
    lockControl.identity = undefined;
    lockControl.permitFirst = false;
    lockControl.calls = 0;
  } };
}

describe('generic flush retained-run boundaries', () => {
  it('retains an armed run event while delivering unrelated records from the same event entry', async () => {
    const sent = transport(), rt = await runtime(sent.sink); await arm(rt.dataDir);
    const protectedEvent = buildEvent({ kind: 'resolution', convergeTarget: 'rcl-183', runId: RUN_ID, round: 1 });
    const unrelatedEvent = buildEvent({ kind: 'attempt_claimed', convergeTarget: 'other', attempt: 1 });
    const entryId = await rt.outbox.spoolEvents([protectedEvent, unrelatedEvent]);

    await expect(flushOutbox(rt)).resolves.toMatchObject({
      delivered: [], remaining: [entryId],
      failed: [{ id: entryId, reason: 'reviewer_delivery_explicit_activation_required' }],
    });
    expect(sent.eventBatches).toEqual([[unrelatedEvent]]);
    expect(JSON.parse(await readFile(join(rt.dataDir, 'outbox', entryId, 'events.json'), 'utf8'))).toEqual([protectedEvent]);
  });


  it('canonicalizes case-variant run bindings before acquiring one event lock', async () => {
    const sent = transport(), rt = await runtime(sent.sink);
    const event = buildEvent({ kind: 'loss', runId: RUN_ID.toUpperCase(),
      payload: { reason: 'outbox_over_cap', run_id: RUN_ID } });
    const entryId = await rt.outbox.spoolEvents([event]);
    const timer = expireContendedAcquisition(RUN_ID, true);
    try {
      await expect(flushOutbox(rt)).resolves.toMatchObject({ delivered: [entryId], failed: [] });
    } finally {
      timer.mockRestore();
    }
    expect(sent.eventBatches).toEqual([[event]]);
  });

  it('retains a malformed loss run binding while continuing unrelated events, but selected flush remains strict', async () => {
    const sent = transport(), rt = await runtime(sent.sink);
    const malformed = buildEvent({ kind: 'loss', payload: { reason: 'outbox_over_cap', run_id: 'not-a-uuid' } });
    const unrelated = buildEvent({ kind: 'attempt_claimed', convergeTarget: 'other', attempt: 1 });
    const entryId = await rt.outbox.spoolEvents([malformed, unrelated]);

    await expect(flushOutbox(rt)).resolves.toMatchObject({
      delivered: [], remaining: [entryId],
      failed: [{ id: entryId, reason: 'reviewer_delivery_invalid_event_run_id' }],
    });
    expect(sent.eventBatches).toEqual([[unrelated]]);
    expect(JSON.parse(await readFile(join(rt.dataDir, 'outbox', entryId, 'events.json'), 'utf8'))).toEqual([malformed]);
    await expect(flushOutbox(rt, { runId: entryId })).rejects.toThrow('reviewer_delivery_invalid_event_run_id');
  });

  it('does not bind an arbitrary non-loss payload run_id', async () => {
    const sent = transport(), rt = await runtime(sent.sink); await arm(rt.dataDir);
    const event = buildEvent({ kind: 'attempt_claimed', convergeTarget: 'other', attempt: 1, payload: { run_id: RUN_ID } });
    const entryId = await rt.outbox.spoolEvents([event]);

    await expect(flushOutbox(rt)).resolves.toMatchObject({ delivered: [entryId], failed: [] });
    expect(sent.eventBatches).toEqual([[event]]);
  });

  it.each([
    ['conflict', { kind: 'conflict', message: 'different event identity' }],
    ['rejected', { kind: 'rejected', httpStatus: 422, error: 'validation_error', message: 'bad event' }],
  ] as const)('retains a protected peer when an unrelated event is permanently %s', async (_case, refused) => {
    const protectedEvent = buildEvent({ kind: 'resolution', convergeTarget: 'rcl-183', runId: RUN_ID, round: 1 });
    const unrelatedEvent = buildEvent({ kind: 'attempt_claimed', convergeTarget: 'other', attempt: 1 });
    const sent = transport(events => events[0]!.id === unrelatedEvent.id ? refused :
      { kind: 'ok', httpStatus: 201, value: { inserted: events.length, duplicates: 0 } });
    const rt = await runtime(sent.sink); await arm(rt.dataDir);
    const entryId = await rt.outbox.spoolEvents([protectedEvent, unrelatedEvent]);

    await expect(flushOutbox(rt)).resolves.toMatchObject({
      remaining: [entryId], failed: [{ id: entryId, reason: 'reviewer_delivery_explicit_activation_required' }],
    });
    const entryDir = join(rt.dataDir, 'outbox', entryId);
    expect(JSON.parse(await readFile(join(entryDir, 'events.json'), 'utf8'))).toEqual([protectedEvent, unrelatedEvent]);
    await expect(readFile(join(entryDir, 'failed.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(entryDir, 'failed-events.json'), 'utf8'))).toEqual({
      [unrelatedEvent.id]: expect.stringContaining(_case === 'conflict' ? 'different event identity' : 'HTTP 422'),
    });

    await rm(join(rt.dataDir, 'reviewer-outbox', RUN_ID, 'activation-intent.json'));
    sent.eventBatches.length = 0;
    await expect(flushOutbox(rt)).resolves.toMatchObject({
      remaining: [entryId], failed: [{ id: entryId, reason: expect.stringContaining('events:') }],
    });
    expect(sent.eventBatches).toEqual([[protectedEvent]]);
    expect(JSON.parse(await readFile(join(entryDir, 'events.json'), 'utf8'))).toEqual([unrelatedEvent]);
  });

  it('retains an armed loss event while reporting unrelated loss records from the same batch', async () => {
    const sent = transport(), rt = await runtime(sent.sink); await arm(rt.dataDir);
    const lossDir = join(rt.dataDir, 'outbox', 'loss'); await mkdir(lossDir, { recursive: true });
    const protectedLoss = { ...buildEvent({ kind: 'loss', payload: { reason: 'outbox_over_cap', run_id: RUN_ID } }),
      id: '00000000-0000-4000-8000-000000000101' };
    const unrelatedLoss = { ...buildEvent({ kind: 'loss', payload: { reason: 'other' } }),
      id: '00000000-0000-4000-8000-000000000102' };
    await writeFile(join(lossDir, `${protectedLoss.id}.json`), JSON.stringify(protectedLoss));
    await writeFile(join(lossDir, `${unrelatedLoss.id}.json`), JSON.stringify(unrelatedLoss));

    await expect(flushOutbox(rt)).resolves.toMatchObject({ lossReported: 1, lossPending: 1 });
    expect(sent.eventBatches).toEqual([[unrelatedLoss]]);
    expect(await readdir(lossDir)).toEqual([`${protectedLoss.id}.json`]);
  });

  it('localizes bare run-lock contention and continues unrelated entries while a selected flush stays strict', async () => {
    const sent = transport(), rt = await runtime(sent.sink); rt.level = 'full';
    await mkdir(join(rt.dataDir, 'reviewer-outbox', RUN_ID), { recursive: true });
    const result = sampleResult(); result.run!.id = RUN_ID;
    const envelope = buildRunEnvelope(result, { report_json: '{}' },
      { level: 'full', delivery: { mode: 'direct' } });
    await rt.outbox.spoolRun({ runId: RUN_ID, envelope, envelopeDelivered: true });
    const otherEnvelope = structuredClone(envelope); otherEnvelope.run.id = OTHER_RUN;
    await rt.outbox.spoolRun({ runId: OTHER_RUN, envelope: otherEnvelope, envelopeDelivered: true });

    const queue = new ReviewerDeliveryQueue(rt.dataDir);
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const holder = queue.withGenericDeliveryAllowed(RUN_ID, async () => { entered(); await held; });
    await acquired;
    try {
      let timer = expireContendedAcquisition();
      await expect(flushOutbox(rt)).resolves.toMatchObject({
        delivered: [OTHER_RUN], remaining: [RUN_ID],
        failed: [{ id: RUN_ID, reason: 'reviewer_delivery_recovery_run_locked' }],
      });
      timer.mockRestore();
      expect(sent.runs).toEqual([]);

      timer = expireContendedAcquisition();
      await expect(flushOutbox(rt, { runId: RUN_ID })).rejects.toThrow('recovery_run_locked');
      timer.mockRestore();
      expect((await rt.outbox.list()).map(row => row.id)).toEqual([RUN_ID]);
    } finally {
      release(); await holder;
    }
  });
});
