import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { withRecoveryLock } from '../../src/evidence/original-run/lock.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import type { HarnessSink } from '../../src/telemetry/sink.js';
import { sampleResult } from './fixtures.js';

const renameControl = vi.hoisted(() => ({
  hook: undefined as undefined | ((from: string, to: string) => Promise<void>),
}));
const lockControl = vi.hoisted(() => ({
  expireEntryWaiter: false,
  entryWaiter: undefined as undefined | (() => void),
}));
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, rename: async (from: string, to: string) => {
    await renameControl.hook?.(String(from), String(to));
    return actual.rename(from, to);
  } };
});

vi.mock('../../src/evidence/original-run/lock.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/evidence/original-run/lock.js')>(
    '../../src/evidence/original-run/lock.js');
  const withRecoveryLock: typeof actual.withRecoveryLock = (root, identity, work, hooks = {}) => {
    if (lockControl.expireEntryWaiter && root.endsWith('-entry-locks')) {
      let clock = 0;
      return actual.withRecoveryLock(root, identity, work, {
        ...hooks,
        now: () => clock,
        wait: async () => { clock += 1_000; },
      });
    }
    if (lockControl.entryWaiter && root.endsWith('-entry-locks')) {
      return actual.withRecoveryLock(root, identity, work, {
        ...hooks,
        wait: async () => {
          lockControl.entryWaiter?.();
          await new Promise<void>(resolve => setTimeout(resolve, 5));
        },
      });
    }
    return actual.withRecoveryLock(root, identity, work, hooks);
  };
  return { ...actual, withRecoveryLock };
});

const roots: string[] = [];
afterEach(async () => {
  renameControl.hook = undefined;
  lockControl.expireEntryWaiter = false;
  lockControl.entryWaiter = undefined;
  await Promise.all(roots.splice(0).flatMap(root => [root, `${root}-entry-locks`]
    .map(path => rm(path, { recursive: true, force: true }))));
});

describe('outbox event mutation concurrency', () => {
  it('does not resurrect a delivered event or lose a concurrently spooled event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rcl-outbox-event-concurrency-')); roots.push(root);
    const outbox = new Outbox(root);
    const result = sampleResult(); result.run!.gating.mode = 'all-findings';
    const envelope = buildRunEnvelope(result, { report_json: JSON.stringify(result) },
      { level: 'full', delivery: { mode: 'direct' } });
    const first = buildEvent({ kind: 'round_processed', convergeTarget: 'rcl-183', round: 1, runId: envelope.run.id });
    const second = buildEvent({ kind: 'round_processed', convergeTarget: 'rcl-183', round: 2, runId: envelope.run.id });
    await outbox.spoolRun({ runId: envelope.run.id, envelope, envelopeDelivered: true, events: [first] });

    let releasePost!: () => void;
    let reachedPost!: () => void;
    const postHeld = new Promise<void>(resolve => { releasePost = resolve; });
    const postReached = new Promise<void>(resolve => { reachedPost = resolve; });
    const sink = { baseUrl: 'https://harness.example.test', postEvents: vi.fn(async (events: unknown[]) => {
      reachedPost();
      await postHeld;
      return { kind: 'ok', httpStatus: 201, value: { inserted: events.length, duplicates: 0 } } as const;
    }) } as unknown as HarnessSink;
    const flushing = new Outbox(root).flush(sink);
    await postReached;

    let releaseRename!: () => void;
    let reachedRename!: () => void;
    const renameHeld = new Promise<void>(resolve => { releaseRename = resolve; });
    const renameReached = new Promise<void>(resolve => { reachedRename = resolve; });
    renameControl.hook = async (_from, to) => {
      if (!to.endsWith('/events.json')) return;
      renameControl.hook = undefined;
      reachedRename();
      await renameHeld;
    };
    const spooling = outbox.spoolRun({ runId: envelope.run.id, envelope, envelopeDelivered: true, events: [second] });
    await renameReached;
    let reachedWaiter!: () => void;
    const waiterReached = new Promise<void>(resolve => { reachedWaiter = resolve; });
    lockControl.entryWaiter = reachedWaiter;
    releasePost();
    await waiterReached;
    releaseRename();
    await spooling;
    const summary = await flushing;

    expect(summary.remaining).toEqual([envelope.run.id]);
    expect(JSON.parse(await readFile(join(root, envelope.run.id, 'events.json'), 'utf8'))).toEqual([second]);
  });

  it('retains an entry when its local mutation lock is contended without classifying it as a reviewer lock failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rcl-outbox-entry-lock-contention-')); roots.push(root);
    const outbox = new Outbox(root);
    const event = buildEvent({ kind: 'attempt_claimed', convergeTarget: 'rcl-183', attempt: 1 });
    const entryId = await outbox.spoolEvents([event]);
    const sink = { baseUrl: 'https://harness.example.test', postEvents: vi.fn() } as unknown as HarnessSink;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const holder = withRecoveryLock(`${root}-entry-locks`, entryId, async () => { entered(); await held; });
    try {
      await ready;
      lockControl.expireEntryWaiter = true;
      await expect(outbox.flush(sink)).resolves.toEqual({
        delivered: [], remaining: [entryId], failed: [], dropped: [],
      });
      expect(sink.postEvents).not.toHaveBeenCalled();
    } finally {
      lockControl.expireEntryWaiter = false;
      release();
      await holder;
    }
  });
});
