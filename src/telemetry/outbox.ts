import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
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
 * each affected run as a `loss` event of its own (stable id), reported on
 * the next flush that reaches the server. A file that cannot be read is
 * never treated as delivered: a torn file marks its entry failed, a
 * transient read error leaves it for the next flush.
 *
 * Concurrency: two rcl processes may touch the outbox at once (a review
 * finishing while another command flushes). Files are written atomically
 * (temp + rename) and re-read before use; the size cap is best-effort
 * across processes, which is what a client-side courtesy cap needs to be.
 */

export const OUTBOX_DIR = 'outbox';
export const DEFAULT_OUTBOX_CAP_BYTES = 1024 * 1024 * 1024;
const META_FILE = 'meta.json';
const ENVELOPE_FILE = 'envelope.json';
const EVENTS_FILE = 'events.json';
const ARTIFACTS_DIR = 'artifacts';
const LOSS_DIR = 'loss';
const FAILED_MARKER = 'failed.json';

const ARTIFACT_FILES: Record<ArtifactKind, string> = { report_json: 'report_json.json', report_md: 'report_md.md' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRY_ID = /^(?:events-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxError';
  }
}

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
  /** The artifacts still to upload; when given, files of kinds not listed are removed (they were delivered). */
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
  /** Pending loss reports delivered in this flush. */
  lossReported?: number;
}

type ReadResult<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'malformed' } | { kind: 'error'; reason: string };

async function readJson<T>(path: string): Promise<ReadResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { kind: 'ok', value: JSON.parse(raw) as T };
  } catch {
    return { kind: 'malformed' };
  }
}

async function readOptionalJson<T>(path: string): Promise<T | undefined> {
  const result = await readJson<T>(path);
  return result.kind === 'ok' ? result.value : undefined;
}

/** Write via a temp file and rename, so a reader never sees a torn file. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

async function directorySize(dir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const sizes = await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      if (!info) return 0;
      return info.isDirectory() ? directorySize(path) : info.size;
    })
  );
  return sizes.reduce((total, size) => total + size, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validEvents(value: unknown): value is WireEvent[] {
  return Array.isArray(value) && value.every((e) => isRecord(e) && typeof e['id'] === 'string' && typeof e['kind'] === 'string');
}

export class Outbox {
  readonly dir: string;
  private readonly capBytes: number;

  constructor(dir: string = join(resolveDataDir(), OUTBOX_DIR), options: { capBytes?: number } = {}) {
    this.dir = resolve(dir);
    this.capBytes = options.capBytes ?? DEFAULT_OUTBOX_CAP_BYTES;
  }

  async totalBytes(): Promise<number> {
    return directorySize(this.dir);
  }

  /** Entry ids are run UUIDs or `events-<uuid>`; nothing else becomes a path. */
  private entryDir(id: string): string {
    if (!ENTRY_ID.test(id)) throw new OutboxError(`Not an outbox entry id: ${JSON.stringify(id)}`);
    const dir = resolve(this.dir, id);
    if (!dir.startsWith(`${this.dir}/`)) throw new OutboxError(`Entry escapes the outbox: ${id}`);
    return dir;
  }

  /** Spool a run whose delivery failed (or whose artifacts could not be uploaded). */
  async spoolRun(input: SpoolRunInput): Promise<SpoolResult> {
    if (!UUID.test(input.runId)) throw new OutboxError(`Not a run id: ${JSON.stringify(input.runId)}`);
    const dir = this.entryDir(input.runId);
    await mkdir(join(dir, ARTIFACTS_DIR), { recursive: true, mode: 0o700 });
    const existing = await readOptionalJson<OutboxMeta>(join(dir, META_FILE));
    const meta: OutboxMeta = {
      kind: 'run',
      spooled_at: existing?.spooled_at ?? new Date().toISOString(),
      attempts: existing?.attempts ?? 0,
      ...(input.envelopeDelivered || existing?.envelope_delivered ? { envelope_delivered: true } : {}),
      ...(input.runUrl !== undefined ? { run_url: input.runUrl } : existing?.run_url ? { run_url: existing.run_url } : {}),
    };
    await writeJsonAtomic(join(dir, ENVELOPE_FILE), input.envelope);

    // Events queued earlier for this run are kept; a re-spool merges by id.
    if (input.events && input.events.length > 0) {
      const previous = await readOptionalJson<unknown>(join(dir, EVENTS_FILE));
      const merged = new Map<string, WireEvent>();
      for (const event of validEvents(previous) ? previous : []) merged.set(event.id, event);
      for (const event of input.events) merged.set(event.id, event);
      await writeJsonAtomic(join(dir, EVENTS_FILE), [...merged.values()]);
    }

    const artifactsDropped: ArtifactKind[] = [];
    if (input.artifacts) {
      const wanted = new Set(Object.keys(input.artifacts) as ArtifactKind[]);
      // Kinds no longer pending were delivered; their stale copies go.
      for (const [kind, file] of Object.entries(ARTIFACT_FILES) as Array<[ArtifactKind, string]>) {
        if (!wanted.has(kind)) await rm(join(dir, ARTIFACTS_DIR, file), { force: true });
      }
      // The cap counts everything else in the outbox plus what this entry will hold.
      let used = (await this.totalBytes()) - (await directorySize(join(dir, ARTIFACTS_DIR)));
      for (const [kind, bytes] of Object.entries(input.artifacts) as Array<[ArtifactKind, string | undefined]>) {
        if (bytes === undefined) continue;
        const size = Buffer.byteLength(bytes, 'utf8');
        if (used + size > this.capBytes) {
          artifactsDropped.push(kind);
          await rm(join(dir, ARTIFACTS_DIR, ARTIFACT_FILES[kind]), { force: true });
          continue;
        }
        await writeTextAtomic(join(dir, ARTIFACTS_DIR, ARTIFACT_FILES[kind]), bytes);
        used += size;
      }
    }
    if (artifactsDropped.length > 0) await this.recordLoss(input.runId, artifactsDropped);
    await writeJsonAtomic(join(dir, META_FILE), meta);
    return { spooled: true, artifactsDropped };
  }

  /** Spool events that belong to no run delivery of their own (converge commands). */
  async spoolEvents(events: WireEvent[]): Promise<string> {
    const first = events[0];
    if (!first || !UUID.test(first.id)) throw new OutboxError('Events to spool must carry UUID ids.');
    const id = `events-${first.id}`;
    const dir = this.entryDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(dir, EVENTS_FILE), events);
    await writeJsonAtomic(join(dir, META_FILE), {
      kind: 'events',
      spooled_at: new Date().toISOString(),
      attempts: 0,
    } satisfies OutboxMeta);
    return id;
  }

  /** One file per loss, holding the event that will report it (stable id, no read-modify-write). */
  private async recordLoss(runId: string, kinds: ArtifactKind[]): Promise<void> {
    const event = buildEvent({ kind: 'loss', payload: { reason: 'outbox_over_cap', run_id: runId, kinds } });
    await mkdir(join(this.dir, LOSS_DIR), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(this.dir, LOSS_DIR, `${event.id}.json`), event);
  }

  /** The loss events still to report. */
  async pendingLoss(): Promise<WireEvent[]> {
    let names: string[];
    try {
      names = (await readdir(join(this.dir, LOSS_DIR))).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const events: WireEvent[] = [];
    for (const name of names) {
      const read = await readJson<WireEvent>(join(this.dir, LOSS_DIR, name));
      if (read.kind === 'ok' && isRecord(read.value) && typeof read.value['id'] === 'string') events.push(read.value);
    }
    return events;
  }

  async list(): Promise<OutboxEntry[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && ENTRY_ID.test(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
    const entries: OutboxEntry[] = [];
    for (const id of names.sort()) {
      const dir = this.entryDir(id);
      const meta = await readOptionalJson<OutboxMeta>(join(dir, META_FILE));
      if (!meta) continue;
      const files = new Set(await readdir(join(dir, ARTIFACTS_DIR)).catch(() => [] as string[]));
      const events = await readOptionalJson<unknown>(join(dir, EVENTS_FILE));
      const failed = await readOptionalJson<{ at: string; reason: string }>(join(dir, FAILED_MARKER));
      entries.push({
        id,
        meta,
        bytes: await directorySize(dir),
        artifacts: (Object.entries(ARTIFACT_FILES) as Array<[ArtifactKind, string]>)
          .filter(([, file]) => files.has(file))
          .map(([kind]) => kind),
        events: validEvents(events) ? events.length : 0,
        ...(failed ? { failed } : {}),
      });
    }
    return entries;
  }

  /**
   * Deliver what waits. Stops at the first unreachable response (the server
   * is down; hammering it helps nobody) or when the deadline passes. Entries
   * the server refuses for good are marked and skipped afterwards. Pending
   * loss reports go out on every flush that reached the server.
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
        case 'retry':
          summary.remaining.push(entry.id);
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

    if (summary.stopped !== 'unavailable' && options.runId === undefined) {
      const reported = await this.reportLoss(sink, pastDeadline);
      if (reported > 0) summary.lossReported = reported;
    }
    return summary;
  }

  private async flushEntry(
    sink: HarnessSink,
    entry: OutboxEntry,
    pastDeadline: () => boolean
  ): Promise<
    | { kind: 'delivered' }
    | { kind: 'failed'; reason: string }
    | { kind: 'retry' }
    | { kind: 'unavailable' }
    | { kind: 'deadline' }
  > {
    const dir = this.entryDir(entry.id);
    const meta: OutboxMeta = { ...entry.meta, attempts: entry.meta.attempts + 1 };
    const remember = async (error?: string) => {
      if (error !== undefined) meta.last_error = error;
      await writeJsonAtomic(join(dir, META_FILE), meta);
    };
    await remember();

    if (meta.kind === 'run' && !meta.envelope_delivered) {
      const read = await readJson<RunEnvelope>(join(dir, ENVELOPE_FILE));
      if (read.kind === 'error') {
        await remember(`envelope unreadable: ${read.reason}`);
        return { kind: 'retry' };
      }
      if (read.kind !== 'ok' || !isRecord(read.value) || !isRecord(read.value['run'])) {
        return this.markFailed(dir, 'envelope.json missing or malformed');
      }
      const envelope = read.value;
      envelope.delivery = { mode: 'retried', spooled_at: meta.spooled_at };
      const outcome = await sink.postRun(envelope);
      switch (outcome.kind) {
        case 'ok':
          meta.envelope_delivered = true;
          meta.run_url = outcome.value.url;
          await remember();
          break;
        case 'unavailable':
          await remember(outcome.reason);
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
      for (const kind of entry.artifacts) {
        if (pastDeadline()) return { kind: 'deadline' };
        const path = join(dir, ARTIFACTS_DIR, ARTIFACT_FILES[kind]);
        let bytes: string;
        try {
          bytes = await readFile(path, 'utf8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // delivered by a concurrent flush
          await remember(`artifact ${kind} unreadable: ${err instanceof Error ? err.message : String(err)}`);
          return { kind: 'retry' };
        }
        const outcome = await sink.putArtifact(entry.id, kind, bytes);
        switch (outcome.kind) {
          case 'ok':
            await rm(path, { force: true });
            break;
          case 'disabled':
            if (outcome.reason === 'reviews_disabled') {
              await rm(dir, { recursive: true, force: true });
              return { kind: 'failed', reason: outcome.message || outcome.reason };
            }
            // Artifacts are capped for the org; the envelope stands.
            await rm(path, { force: true });
            break;
          case 'unavailable':
            await remember(outcome.reason);
            return { kind: 'unavailable' };
          case 'conflict':
          case 'rejected':
            return this.markFailed(
              dir,
              `artifact ${kind}: ${outcome.kind === 'conflict' ? outcome.message : `HTTP ${outcome.httpStatus} ${outcome.error}`}`
            );
        }
      }
    }

    const events = await readJson<unknown>(join(dir, EVENTS_FILE));
    if (events.kind === 'error') {
      await remember(`events unreadable: ${events.reason}`);
      return { kind: 'retry' };
    }
    if (events.kind === 'malformed' || (events.kind === 'ok' && !validEvents(events.value))) {
      return this.markFailed(dir, 'events.json malformed');
    }
    if (events.kind === 'missing' && meta.kind === 'events') {
      return this.markFailed(dir, 'events.json missing');
    }
    if (events.kind === 'ok' && validEvents(events.value) && events.value.length > 0) {
      if (pastDeadline()) return { kind: 'deadline' };
      const outcome = await sink.postEvents(events.value);
      switch (outcome.kind) {
        case 'ok':
          break;
        case 'unavailable':
          await remember(outcome.reason);
          return { kind: 'unavailable' };
        case 'disabled':
          await rm(dir, { recursive: true, force: true });
          return { kind: 'failed', reason: outcome.message || outcome.reason };
        case 'conflict':
        case 'rejected':
          return this.markFailed(
            dir,
            `events: ${outcome.kind === 'conflict' ? outcome.message : `HTTP ${outcome.httpStatus} ${outcome.error} ${outcome.message}`.trim()}`
          );
      }
    }

    await rm(dir, { recursive: true, force: true });
    return { kind: 'delivered' };
  }

  private async markFailed(dir: string, reason: string): Promise<{ kind: 'failed'; reason: string }> {
    await writeJsonAtomic(join(dir, FAILED_MARKER), { at: new Date().toISOString(), reason });
    return { kind: 'failed', reason };
  }

  /** Report pending losses with their stable ids; each file goes once the server has taken it. */
  private async reportLoss(sink: HarnessSink, pastDeadline: () => boolean): Promise<number> {
    const events = await this.pendingLoss();
    if (events.length === 0 || pastDeadline()) return 0;
    const outcome = await sink.postEvents(events);
    if (outcome.kind === 'ok' || outcome.kind === 'disabled' || outcome.kind === 'rejected') {
      for (const event of events) await rm(join(this.dir, LOSS_DIR, `${event.id}.json`), { force: true });
      return events.length;
    }
    return 0;
  }

  /** Remove one entry by id (validated like every other id). */
  async remove(id: string): Promise<void> {
    await rm(this.entryDir(id), { recursive: true, force: true });
  }
}
