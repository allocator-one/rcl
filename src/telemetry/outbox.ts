import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { resolveDataDir } from '../models/stats-store.js';
import type { ArtifactKind, RunEnvelope } from './envelope.js';
import { buildEvent, type WireEvent } from './events.js';
import type { HarnessSink } from './sink.js';

/**
 * Failed deliveries wait here (epic IO-12475, section 8.4): one directory
 * per run under `<data dir>/outbox/`, holding the envelope, the artifacts
 * and any events that could not be sent. Flushed at the start of every rcl
 * command (bounded) and by `rcl telemetry flush` (to completion). Retried
 * deliveries carry `delivery: {mode: retried, spooled_at}` and keep their
 * original ids, so the server dedupes them.
 *
 * Nothing is evicted silently. Above the size cap the outbox stops spooling
 * artifacts — envelopes and events are small and always kept — and records
 * the runs affected in `loss.json`; the next successful flush reports them
 * as one `loss` event.
 */

export const OUTBOX_DIR = 'outbox';
export const DEFAULT_OUTBOX_CAP_BYTES = 1024 * 1024 * 1024;
const META_FILE = 'meta.json';
const ENVELOPE_FILE = 'envelope.json';
const EVENTS_FILE = 'events.json';
const ARTIFACTS_DIR = 'artifacts';
const LOSS_FILE = 'loss.json';
const FAILED_MARKER = 'failed.json';

const ARTIFACT_EXTENSION: Record<ArtifactKind, string> = { report_json: 'json', report_md: 'md' };

export interface OutboxMeta {
  kind: 'run' | 'events';
  spooled_at: string;
  attempts: number;
  /** The envelope was acknowledged; only artifacts/events remain. */
  envelope_delivered?: boolean;
  run_url?: string;
  last_error?: string;
}

export interface OutboxEntry {
  id: string;
  meta: OutboxMeta;
  bytes: number;
  artifacts: ArtifactKind[];
  events: number;
  failed?: { at: string; reason: string };
}

export interface SpoolRunInput {
  runId: string;
  envelope: RunEnvelope;
  artifacts?: Partial<Record<ArtifactKind, string>>;
  events?: WireEvent[];
  /** The envelope already landed; spool artifacts/events only. */
  envelopeDelivered?: boolean;
  runUrl?: string;
}

export interface SpoolResult {
  spooled: boolean;
  /** Artifacts were not spooled because the outbox is over its cap. */
  artifactsDropped: ArtifactKind[];
}

export interface FlushOptions {
  /** Stop starting new requests after this many milliseconds. */
  deadlineMs?: number;
  /** Flush one entry only. */
  runId?: string;
  now?: () => number;
}

export interface FlushSummary {
  delivered: string[];
  remaining: string[];
  /** Entries the server refused for good, left in place with a marker. */
  failed: Array<{ id: string; reason: string }>;
  /** Flushing stopped early: the server was unreachable or the deadline passed. */
  stopped?: 'unavailable' | 'deadline';
}

interface LossRecord {
  runs: Array<{ run_id: string; kinds: ArtifactKind[]; at: string }>;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (!info) continue;
    total += info.isDirectory() ? await directorySize(path) : info.size;
  }
  return total;
}

export class Outbox {
  readonly dir: string;
  private readonly capBytes: number;

  constructor(dir: string = join(resolveDataDir(), OUTBOX_DIR), options: { capBytes?: number } = {}) {
    this.dir = dir;
    this.capBytes = options.capBytes ?? DEFAULT_OUTBOX_CAP_BYTES;
  }

  async totalBytes(): Promise<number> {
    return directorySize(this.dir);
  }

  private entryDir(id: string): string {
    return join(this.dir, id);
  }

  /** Spool a run whose delivery failed (or whose artifacts could not be uploaded). */
  async spoolRun(input: SpoolRunInput): Promise<SpoolResult> {
    const dir = this.entryDir(input.runId);
    await mkdir(join(dir, ARTIFACTS_DIR), { recursive: true, mode: 0o700 });
    const existing = await readJson<OutboxMeta>(join(dir, META_FILE));
    const meta: OutboxMeta = {
      kind: 'run',
      spooled_at: existing?.spooled_at ?? new Date().toISOString(),
      attempts: existing?.attempts ?? 0,
      ...(input.envelopeDelivered ? { envelope_delivered: true } : {}),
      ...(input.runUrl !== undefined ? { run_url: input.runUrl } : {}),
    };
    await writeJson(join(dir, ENVELOPE_FILE), input.envelope);
    if (input.events && input.events.length > 0) await writeJson(join(dir, EVENTS_FILE), input.events);

    const artifactsDropped: ArtifactKind[] = [];
    const artifacts = input.artifacts ?? {};
    let used = await this.totalBytes();
    for (const [kind, bytes] of Object.entries(artifacts) as Array<[ArtifactKind, string | undefined]>) {
      if (bytes === undefined) continue;
      const size = Buffer.byteLength(bytes, 'utf8');
      if (used + size > this.capBytes) {
        artifactsDropped.push(kind);
        continue;
      }
      await writeFile(join(dir, ARTIFACTS_DIR, `${kind}.${ARTIFACT_EXTENSION[kind]}`), bytes, {
        encoding: 'utf8',
        mode: 0o600,
      });
      used += size;
    }
    if (artifactsDropped.length > 0) await this.recordLoss(input.runId, artifactsDropped);
    await writeJson(join(dir, META_FILE), meta);
    return { spooled: true, artifactsDropped };
  }

  /** Spool events that belong to no run delivery of their own (converge commands). */
  async spoolEvents(events: WireEvent[]): Promise<string> {
    const id = `events-${events[0]?.id ?? Date.now()}`;
    const dir = this.entryDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeJson(join(dir, EVENTS_FILE), events);
    await writeJson(join(dir, META_FILE), { kind: 'events', spooled_at: new Date().toISOString(), attempts: 0 } satisfies OutboxMeta);
    return id;
  }

  private async recordLoss(runId: string, kinds: ArtifactKind[]): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, LOSS_FILE);
    const record = (await readJson<LossRecord>(path)) ?? { runs: [] };
    record.runs.push({ run_id: runId, kinds, at: new Date().toISOString() });
    await writeJson(path, record);
  }

  async pendingLoss(): Promise<LossRecord['runs']> {
    return (await readJson<LossRecord>(join(this.dir, LOSS_FILE)))?.runs ?? [];
  }

  async list(): Promise<OutboxEntry[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    const entries: OutboxEntry[] = [];
    for (const id of names.sort()) {
      const dir = this.entryDir(id);
      const meta = await readJson<OutboxMeta>(join(dir, META_FILE));
      if (!meta) continue;
      const artifactNames = await readdir(join(dir, ARTIFACTS_DIR)).catch(() => [] as string[]);
      const events = (await readJson<WireEvent[]>(join(dir, EVENTS_FILE))) ?? [];
      const failed = await readJson<{ at: string; reason: string }>(join(dir, FAILED_MARKER));
      entries.push({
        id,
        meta,
        bytes: await directorySize(dir),
        artifacts: artifactNames
          .map((name) => name.replace(/\.[a-z]+$/, '') as ArtifactKind)
          .filter((kind): kind is ArtifactKind => kind === 'report_json' || kind === 'report_md'),
        events: events.length,
        ...(failed ? { failed } : {}),
      });
    }
    return entries;
  }

  /**
   * Deliver what waits. Stops at the first unreachable response (the server
   * is down; hammering it helps nobody) or when the deadline passes. Entries
   * the server refuses for good are marked and skipped afterwards.
   */
  async flush(sink: HarnessSink, options: FlushOptions = {}): Promise<FlushSummary> {
    const now = options.now ?? Date.now;
    const started = now();
    const pastDeadline = () => options.deadlineMs !== undefined && now() - started >= options.deadlineMs;
    const summary: FlushSummary = { delivered: [], remaining: [], failed: [] };

    const entries = (await this.list()).filter((e) => options.runId === undefined || e.id === options.runId);
    for (const entry of entries) {
      if (entry.failed) {
        summary.failed.push({ id: entry.id, reason: entry.failed.reason });
        continue;
      }
      if (summary.stopped) {
        summary.remaining.push(entry.id);
        continue;
      }
      if (pastDeadline()) {
        summary.stopped = 'deadline';
        summary.remaining.push(entry.id);
        continue;
      }
      const result = await this.flushEntry(sink, entry, pastDeadline);
      switch (result.kind) {
        case 'delivered':
          summary.delivered.push(entry.id);
          break;
        case 'failed':
          summary.failed.push({ id: entry.id, reason: result.reason });
          break;
        case 'unavailable':
          summary.stopped = 'unavailable';
          summary.remaining.push(entry.id);
          break;
        case 'deadline':
          summary.stopped = 'deadline';
          summary.remaining.push(entry.id);
          break;
      }
    }

    if (summary.delivered.length > 0 && !summary.stopped) await this.reportLoss(sink);
    return summary;
  }

  private async flushEntry(
    sink: HarnessSink,
    entry: OutboxEntry,
    pastDeadline: () => boolean
  ): Promise<{ kind: 'delivered' } | { kind: 'failed'; reason: string } | { kind: 'unavailable' } | { kind: 'deadline' }> {
    const dir = this.entryDir(entry.id);
    const meta: OutboxMeta = { ...entry.meta, attempts: entry.meta.attempts + 1 };
    await writeJson(join(dir, META_FILE), meta);

    if (meta.kind === 'run' && !meta.envelope_delivered) {
      const envelope = await readJson<RunEnvelope>(join(dir, ENVELOPE_FILE));
      if (!envelope) return this.markFailed(dir, 'envelope.json unreadable');
      envelope.delivery = { mode: 'retried', spooled_at: meta.spooled_at };
      const outcome = await sink.postRun(envelope);
      switch (outcome.kind) {
        case 'ok':
          meta.envelope_delivered = true;
          meta.run_url = outcome.value.url;
          await writeJson(join(dir, META_FILE), meta);
          break;
        case 'unavailable':
          meta.last_error = outcome.reason;
          await writeJson(join(dir, META_FILE), meta);
          return { kind: 'unavailable' };
        case 'disabled':
          // The organization switched evidence off; there is nothing to keep waiting for.
          await rm(dir, { recursive: true, force: true });
          return { kind: 'failed', reason: outcome.message || outcome.reason };
        case 'conflict':
          return this.markFailed(dir, `conflict: ${outcome.message}`);
        case 'rejected':
          return this.markFailed(dir, `HTTP ${outcome.httpStatus} ${outcome.error} ${outcome.message}`.trim());
      }
    }

    if (meta.kind === 'run') {
      const runId = entry.id;
      for (const kind of entry.artifacts) {
        if (pastDeadline()) return { kind: 'deadline' };
        const path = join(dir, ARTIFACTS_DIR, `${kind}.${ARTIFACT_EXTENSION[kind]}`);
        const bytes = await readFile(path, 'utf8').catch(() => undefined);
        if (bytes === undefined) continue;
        const outcome = await sink.putArtifact(runId, kind, bytes);
        switch (outcome.kind) {
          case 'ok':
            await rm(path, { force: true });
            break;
          case 'disabled':
            // Artifacts are capped for the org; the envelope stands.
            await rm(path, { force: true });
            break;
          case 'unavailable':
            meta.last_error = outcome.reason;
            await writeJson(join(dir, META_FILE), meta);
            return { kind: 'unavailable' };
          case 'conflict':
          case 'rejected':
            return this.markFailed(dir, `artifact ${kind}: ${outcome.kind === 'conflict' ? outcome.message : `HTTP ${outcome.httpStatus} ${outcome.error}`}`);
        }
      }
    }

    const events = await readJson<WireEvent[]>(join(dir, EVENTS_FILE));
    if (events && events.length > 0) {
      if (pastDeadline()) return { kind: 'deadline' };
      const outcome = await sink.postEvents(events);
      switch (outcome.kind) {
        case 'ok':
          break;
        case 'unavailable':
          meta.last_error = outcome.reason;
          await writeJson(join(dir, META_FILE), meta);
          return { kind: 'unavailable' };
        case 'disabled':
          await rm(dir, { recursive: true, force: true });
          return { kind: 'failed', reason: outcome.message || outcome.reason };
        case 'conflict':
        case 'rejected':
          return this.markFailed(dir, `events: ${outcome.kind === 'conflict' ? outcome.message : `HTTP ${outcome.httpStatus} ${outcome.error} ${outcome.message}`.trim()}`);
      }
    }

    await rm(dir, { recursive: true, force: true });
    return { kind: 'delivered' };
  }

  private async markFailed(dir: string, reason: string): Promise<{ kind: 'failed'; reason: string }> {
    await writeJson(join(dir, FAILED_MARKER), { at: new Date().toISOString(), reason });
    return { kind: 'failed', reason };
  }

  /** After a successful flush, tell the server which runs lost their artifacts to the cap. */
  private async reportLoss(sink: HarnessSink): Promise<void> {
    const runs = await this.pendingLoss();
    if (runs.length === 0) return;
    const event = buildEvent({
      kind: 'loss',
      payload: { reason: 'outbox_over_cap', runs },
    });
    const outcome = await sink.postEvents([event]);
    if (outcome.kind === 'ok' || outcome.kind === 'disabled' || outcome.kind === 'rejected') {
      await rm(join(this.dir, LOSS_FILE), { force: true });
    }
  }

  /** Remove one entry (used by `telemetry status --drop`-style tooling and tests). */
  async remove(id: string): Promise<void> {
    await rm(this.entryDir(id), { recursive: true, force: true });
  }
}
