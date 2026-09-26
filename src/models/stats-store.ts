import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { syncNativeDirectory, withNativeLock } from '../converge/native-lock.js';

/**
 * Per-model triage history (RCL-27). The converge ledgers always recorded
 * fixed/dismissed per finding — this store finally makes rcl learn from
 * them: outcomes and call stats accumulate ACROSS runs, and trailing
 * precision weights each model's consensus vote so persistently noisy
 * models lose gating power automatically.
 *
 * Location: `~/.rcl` (or RCL_DATA_DIR) — deliberately not under /tmp or the
 * repository's converge dirs, so the history survives converge-state
 * cleanup, repo re-clones, and tmp sweepers.
 */

export interface OutcomeRecord {
  /** Original retained operation and record ordinal; reuse exactly on retry. */
  recordId?: string;
  /**
   * Allocated by the owning native operation, never by this auxiliary store.
   * Sequences compare only within one scope; scopes and legacy rows share no
   * logical clock and retain physical JSONL order when compared to each other.
   */
  order?: { scope: string; sequence: number };
  ts: string;
  verdict: 'fixed' | 'dismissed';
  /** Distinct models that supported the finding when it was triaged. */
  models: string[];
  severity?: string;
  target?: string;
  findingKey?: string;
  source?: 'live' | 'seed';
}

export interface CallRecord {
  /** Distinct original calls need distinct IDs, even with equal visible fields. */
  recordId?: string;
  ts: string;
  model: string;
  durationMs: number;
  status: string;
  role?: string;
  source?: 'live' | 'seed';
}

export interface ModelStats {
  model: string;
  /** Triaged findings this model supported in the window. */
  outcomes: number;
  fixed: number;
  /** fixed / outcomes; undefined when the model has no outcomes. */
  precision?: number;
  calls: number;
  /** Calls that returned nothing (timeout or error). */
  dead: number;
  deadRate?: number;
  p50Ms?: number;
  weight: number;
}

export const DEFAULT_WINDOW_DAYS = 90;

/**
 * Below this many triaged outcomes, precision is noise — the model keeps a
 * neutral weight instead of being punished or promoted on a handful of
 * verdicts.
 */
export const MIN_OUTCOMES_FOR_WEIGHT = 20;

const OUTCOMES_FILE = 'outcomes.jsonl';
const CALLS_FILE = 'calls.jsonl';

import { resolveDataDir } from '../config/data-dir.js';

export { resolveDataDir };

/**
 * Bound write buffers at record boundaries. The shared lock serializes this
 * version's writers; interrupted records remain as audit bytes and readers
 * skip their torn line. Retained record IDs make partial-batch retry safe.
 */
const APPEND_CHUNK_BYTES = 64 * 1024;

type PrecisionRecord = OutcomeRecord | CallRecord;
type IdentityIndex = { byId: Map<string, PrecisionRecord>; byOrder: Map<string, OutcomeRecord> };

function validateMetadata(record: PrecisionRecord): void {
  if (record.recordId !== undefined && (typeof record.recordId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(record.recordId))) throw new Error('invalid_precision_record_id');
  if ('order' in record && record.order !== undefined && (!record.recordId ||
      !record.order || typeof record.order.scope !== 'string' || record.order.scope.length === 0 ||
      record.order.scope.length > 1024 || !Number.isSafeInteger(record.order.sequence) || record.order.sequence < 1 ||
      !record.target || !record.findingKey)) throw new Error('invalid_precision_order');
}

function parseJsonl<T>(raw: string): T[] {
  const result: T[] = [];
  for (const line of raw.split('\n')) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) result.push(value as T);
    } catch { /* Retain and skip a torn or corrupt line. */ }
  }
  return result;
}

function identityIndex(records: PrecisionRecord[]): IdentityIndex {
  const byId = new Map<string, PrecisionRecord>();
  const byOrder = new Map<string, OutcomeRecord>();
  for (const record of records) {
    validateMetadata(record);
    if ('order' in record && record.order) {
      const key = JSON.stringify([record.target, record.findingKey, record.order.scope, record.order.sequence]);
      const prior = byOrder.get(key);
      if (prior && !isDeepStrictEqual(prior, record)) throw new Error('precision_order_conflict');
      byOrder.set(key, record);
    }
    if (record.recordId === undefined) continue;
    const prior = byId.get(record.recordId);
    if (prior && !isDeepStrictEqual(prior, record)) throw new Error('precision_record_conflict');
    byId.set(record.recordId, record);
  }
  return { byId, byOrder };
}

/** Existing history can contain torn or older malformed rows; preserve bytes and use valid first-seen records. */
function readableRecords<T extends PrecisionRecord>(records: T[]): T[] {
  const accepted: T[] = [];
  const seen = { byId: new Map<string, PrecisionRecord>(), byOrder: new Map<string, OutcomeRecord>() };
  for (const record of records) {
    try {
      validateMetadata(record);
    } catch { /* Existing corrupt metadata loses one record, never the store. */
      continue;
    }
    if ('order' in record && record.order) {
      const key = JSON.stringify([record.target, record.findingKey, record.order.scope, record.order.sequence]);
      const prior = seen.byOrder.get(key);
      if (prior && !isDeepStrictEqual(prior, record)) throw new Error('precision_order_conflict');
      seen.byOrder.set(key, record);
    }
    if (record.recordId !== undefined) {
      const prior = seen.byId.get(record.recordId);
      if (prior && !isDeepStrictEqual(prior, record)) throw new Error('precision_record_conflict');
      seen.byId.set(record.recordId, record);
    }
    accepted.push(record);
  }
  return accepted;
}

// Legacy writes retain their original fast directory preparation. Retained writes
// use a durable intent so a cooperating process can repair a creator crash.
const pendingDirectorySyncs = new Map<string, string[]>();
type DurableIntent = { version: 1; target: string; anchor: string; phase: 'creating' | 'published' };

async function retainedProtocolTestEvent(event: string, path?: string): Promise<void> {
  const pauseAt = process.env['RCL_TEST_STATS_STORE_PAUSE_AT'];
  const trace = process.env['RCL_TEST_STATS_STORE_TRACE'] === '1';
  if (!trace && pauseAt !== event) return;
  if (process.env.NODE_ENV !== 'test') throw new Error('test_only_stats_store_protocol_hook');
  if (!process.send) throw new Error('stats_store_protocol_ipc_required');
  process.send({ type: 'rcl-stats-store-protocol', event, ...(path ? { path } : {}) });
  if (pauseAt !== event) return;
  await new Promise<void>((resolvePause, reject) => {
    const timeout = setTimeout(() => {
      cleanup(); reject(new Error(`stats_store_protocol_barrier_timeout:${event}`));
    }, 10_000);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as { type?: unknown; event?: unknown };
      if (value.type !== 'rcl-stats-store-protocol-continue' || value.event !== event) return;
      cleanup(); resolvePause();
    };
    const onDisconnect = () => { cleanup(); reject(new Error(`stats_store_protocol_ipc_closed:${event}`)); };
    const cleanup = () => {
      clearTimeout(timeout); process.off('message', onMessage); process.off('disconnect', onDisconnect);
    };
    process.on('message', onMessage); process.once('disconnect', onDisconnect);
  });
}

function intentDirectory(anchor: string, target: string): string {
  const id = createHash('sha256').update(target).digest('hex');
  return join(anchor, `.rcl-model-stats-intent-${id}`);
}

function validIntent(value: unknown, target: string): value is DurableIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Partial<DurableIntent>;
  return intent.version === 1 && intent.target === target && typeof intent.anchor === 'string' &&
    (intent.phase === 'creating' || intent.phase === 'published');
}

async function readIntent(path: string, target: string): Promise<DurableIntent | undefined> {
  let raw: string;
  try { raw = await readFile(join(path, 'intent.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('unsafe_precision_intent'); }
  if (!validIntent(value, target)) throw new Error('unsafe_precision_intent');
  return value;
}

async function writeIntent(path: string, value: DurableIntent): Promise<void> {
  const destination = join(path, 'intent.json');
  const temporary = join(path, `.intent-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, destination); }
  finally { await unlink(temporary).catch(() => undefined); }
  await syncNativeDirectory(path);
}

async function nearestExistingAncestor(target: string): Promise<string> {
  for (let path = target; ; path = dirname(path)) {
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe_precision_store');
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (dirname(path) === path) throw new Error('durable_precision_anchor_required');
    }
  }
}

async function discoverIntent(target: string): Promise<{ root: string; intent: DurableIntent } | undefined> {
  for (let path = target; ; path = dirname(path)) {
    const root = intentDirectory(path, target);
    const intent = await readIntent(root, target);
    if (intent) {
      if (intent.anchor !== path) throw new Error('unsafe_precision_intent');
      return { root, intent };
    }
    if (dirname(path) === path) return undefined;
  }
}

async function syncCreatedChain(target: string, anchor: string): Promise<void> {
  for (let path = target; ; path = dirname(path)) {
    if (dirname(path) === path) throw new Error('durable_precision_anchor_required');
    await syncNativeDirectory(path);
    await retainedProtocolTestEvent('created-chain-synced', path);
    if (path === anchor) return;
  }
}

async function createRetainedChain(target: string, anchor: string): Promise<void> {
  const missing: string[] = [];
  for (let path = target; path !== anchor; path = dirname(path)) {
    if (dirname(path) === path) throw new Error('durable_precision_anchor_required');
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
        throw new Error('unsafe_precision_store');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(path);
    }
  }
  for (const path of missing.reverse()) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) {
      throw new Error('unsafe_precision_store');
    }
    await retainedProtocolTestEvent(path === target ? 'target-visible' : 'mkdir-component-visible', path);
  }
}

/**
 * Retained writes publish a durable intent before mkdir. Cooperating writers
 * discover it from the target's ancestors and repair its bounded chain before
 * any acknowledgement; legacy pre-existing directories have no such intent.
 */
async function prepareRetainedDirectory(inputDir: string): Promise<string> {
  const target = resolve(inputDir);
  let discovered = await discoverIntent(target);
  if (!discovered) {
    await retainedProtocolTestEvent('intent-discovery-miss', target);
    try {
      const existing = await lstat(target);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('unsafe_precision_store');
      const dir = await realpath(target);
      if (dir !== target) throw new Error('unsafe_precision_store');
      // The target may have appeared after the first discovery pass. Its
      // creator publishes the intent before mkdir, so a second pass closes
      // that race without burdening genuinely pre-existing stores.
      discovered = await discoverIntent(target);
      if (!discovered) return dir;
      await retainedProtocolTestEvent('existing-target-intent-discovered', discovered.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!discovered) {
    await retainedProtocolTestEvent('target-missing', target);
    const anchor = await nearestExistingAncestor(target);
    if (dirname(anchor) === anchor) throw new Error('durable_precision_anchor_required');
    // A competing creator may have supplied this ancestor after lstat missed
    // the target. Join its original intent and lock instead of treating an
    // unflushed directory link as our durable boundary.
    discovered = await discoverIntent(target);
    if (!discovered) {
      const root = intentDirectory(anchor, target);
      try { await mkdir(root, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await retainedProtocolTestEvent('intent-root-created', root);
      await syncNativeDirectory(anchor);
      await retainedProtocolTestEvent('intent-root-anchored', anchor);
      discovered = { root, intent: { version: 1, target, anchor, phase: 'creating' } };
    }
  }

  const durableCreation = discovered;
  await withNativeLock(durableCreation.root, 'model-stats-intent', async () => {
    let intent = await readIntent(durableCreation.root, target);
    if (!intent) {
      intent = durableCreation.intent;
      await writeIntent(durableCreation.root, intent);
      await retainedProtocolTestEvent('creating-intent-durable', join(durableCreation.root, 'intent.json'));
    }
    if (intent.phase === 'creating') {
      await createRetainedChain(target, intent.anchor);
      const dir = await realpath(target);
      if (dir !== target) throw new Error('unsafe_precision_store');
      await syncCreatedChain(dir, intent.anchor);
      await writeIntent(durableCreation.root, { ...intent, phase: 'published' });
      await retainedProtocolTestEvent('published-intent-durable', join(durableCreation.root, 'intent.json'));
    }
  });
  return await realpath(target);
}

async function syncDirectoryAncestors(inputDir: string): Promise<string> {
  const target = resolve(inputDir);
  const firstCreated = await mkdir(target, { recursive: true, mode: 0o700 });
  const dir = await realpath(target);
  let paths = pendingDirectorySyncs.get(dir) ?? [];
  if (firstCreated) {
    const boundary = await realpath(dirname(firstCreated));
    const created: string[] = [];
    for (let path = dir; dirname(path) !== path; path = dirname(path)) {
      created.push(path);
      if (path === boundary) break;
    }
    paths = [...new Set([...paths, ...created])];
  }
  if (paths.length === 0) return dir;
  try { for (const path of paths) await syncNativeDirectory(path); }
  catch (error) { pendingDirectorySyncs.set(dir, paths); throw error; }
  pendingDirectorySyncs.delete(dir);
  return dir;
}

async function trailingSeparator(handle: Awaited<ReturnType<typeof open>>): Promise<string> {
  const { size } = await handle.stat();
  if (size === 0) return '';
  const tail = Buffer.alloc(1);
  await handle.read(tail, 0, 1, size - 1);
  return tail[0] === 10 ? '' : '\n';
}

async function appendJsonl(inputDir: string, file: string, input: PrecisionRecord[]): Promise<void> {
  if (input.length === 0) return;
  // Freeze and validate the entire batch before making any filesystem changes.
  const records = JSON.parse(JSON.stringify(input)) as PrecisionRecord[];
  records.forEach(validateMetadata);
  const retained = records.some(record => record.recordId !== undefined);
  if (retained && records.some(record => record.recordId === undefined)) throw new Error('mixed_precision_batch');
  identityIndex(records);
  const dir = retained ? await prepareRetainedDirectory(inputDir) : await syncDirectoryAncestors(inputDir);
  await withNativeLock(join(dir, 'model-stats-locks'), file, async () => {
    const handle = await open(join(dir, file), constants.O_CREAT | constants.O_RDWR | constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('invalid_precision_store');
      const raw = retained ? await handle.readFile('utf8') : '';
      const existingRecords = retained ? readableRecords(parseJsonl<PrecisionRecord>(raw)) : [];
      const existing = identityIndex(existingRecords);
      const pending: PrecisionRecord[] = [];
      for (const record of records) {
        const prior = record.recordId === undefined ? undefined : existing.byId.get(record.recordId);
        if (prior) {
          if (!isDeepStrictEqual(prior, record)) throw new Error('precision_record_conflict');
        } else {
          if ('order' in record && record.order) {
            const key = JSON.stringify([record.target, record.findingKey, record.order.scope, record.order.sequence]);
            const priorOrder = existing.byOrder.get(key);
            if (priorOrder && !isDeepStrictEqual(priorOrder, record)) throw new Error('precision_order_conflict');
            existing.byOrder.set(key, record);
          }
          pending.push(record);
          if (record.recordId !== undefined) existing.byId.set(record.recordId, record);
        }
      }
      // Never concatenate a retry to a torn tail or an un-terminated complete
      // record. Its original bytes remain intact; only the separator is added.
      let chunk = retained
        ? (raw.length > 0 && !raw.endsWith('\n') ? '\n' : '')
        : await trailingSeparator(handle);
      for (const record of pending) {
        chunk += JSON.stringify(record) + '\n';
        if (Buffer.byteLength(chunk) >= APPEND_CHUNK_BYTES) {
          await handle.writeFile(chunk, 'utf8'); chunk = '';
        }
      }
      if (chunk) await handle.writeFile(chunk, 'utf8');
      // Readback after a failed fsync is not durability. Even an identical
      // already-present batch must successfully flush before acknowledging it.
      await handle.sync();
      if (retained) await retainedProtocolTestEvent('history-file-synced', join(dir, file));
    } finally { await handle.close(); }
    await syncNativeDirectory(dir);
    if (retained) await retainedProtocolTestEvent('history-directory-synced', dir);
  });
}

export async function appendOutcomes(records: OutcomeRecord[], dir = resolveDataDir()): Promise<void> {
  await appendJsonl(dir, OUTCOMES_FILE, records);
}

export async function appendCalls(records: CallRecord[], dir = resolveDataDir()): Promise<void> {
  await appendJsonl(dir, CALLS_FILE, records);
}

async function readJsonl<T extends PrecisionRecord>(dir: string, file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, file), 'utf8');
  } catch {
    return [];
  }
  const parsed = readableRecords(parseJsonl<T>(raw));
  const seen = new Set<string>();
  return parsed.filter(record => {
    if (record.recordId === undefined) return true;
    if (seen.has(record.recordId)) return false;
    seen.add(record.recordId); return true;
  });
}

/**
 * Ordered rows take precedence over legacy rows. Sequence is authoritative only
 * within one original operation scope; different ordered scopes and two legacy
 * rows have no shared logical clock, so their later physical JSONL row wins.
 */
function laterOutcome(candidate: OutcomeRecord, current: OutcomeRecord): boolean {
  if (candidate.order && current.order && candidate.order.scope === current.order.scope) {
    if (candidate.order.sequence === current.order.sequence && !isDeepStrictEqual(candidate, current)) {
      throw new Error('precision_order_conflict');
    }
    return candidate.order.sequence > current.order.sequence;
  }
  if (!candidate.order && current.order) return false;
  if (candidate.order && !current.order) return true;
  return true;
}

/**
 * Weight for a model's consensus vote: precision mapped into [0.5, 1.5]
 * (0.5 + precision), neutral 1 below the sample floor. All-neutral weights
 * reproduce today's unweighted behavior exactly.
 */
export function computeWeight(
  precision: number | undefined,
  outcomes: number,
  minSamples = MIN_OUTCOMES_FOR_WEIGHT
): number {
  if (precision === undefined || outcomes < minSamples) return 1;
  return Math.min(1.5, Math.max(0.5, 0.5 + precision));
}

export async function loadModelStats(options: {
  dir?: string;
  windowDays?: number;
  now?: Date;
} = {}): Promise<ModelStats[]> {
  const dir = options.dir ?? resolveDataDir();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = (ts: string): boolean => {
    const t = Date.parse(ts);
    return Number.isFinite(t) && t >= cutoff;
  };

  const byModel = new Map<
    string,
    { outcomes: number; fixed: number; calls: number; dead: number; durations: number[] }
  >();
  const bucket = (model: string) => {
    let b = byModel.get(model);
    if (!b) {
      b = { outcomes: 0, fixed: 0, calls: 0, dead: 0, durations: [] };
      byModel.set(model, b);
    }
    return b;
  };

  // One effective verdict per finding. Retained order prevents a delayed retry
  // from replacing later triage in the same original operation. Ordered rows
  // beat legacy rows; only all-legacy or cross-scope rows use physical order.
  const outcomesByKey = new Map<string, OutcomeRecord>();
  const keylessOutcomes: OutcomeRecord[] = [];
  for (const rec of await readJsonl<OutcomeRecord>(dir, OUTCOMES_FILE)) {
    if (!Array.isArray(rec.models) || !inWindow(rec.ts)) continue;
    if (rec.verdict !== 'fixed' && rec.verdict !== 'dismissed') continue;
    if (rec.target && rec.findingKey) {
      const key = `${rec.target} ${rec.findingKey}`;
      const prior = outcomesByKey.get(key);
      if (!prior || laterOutcome(rec, prior)) outcomesByKey.set(key, rec);
    } else {
      keylessOutcomes.push(rec);
    }
  }
  for (const rec of [...outcomesByKey.values(), ...keylessOutcomes]) {
    for (const model of new Set(rec.models.filter((m) => typeof m === 'string'))) {
      const b = bucket(model);
      b.outcomes++;
      if (rec.verdict === 'fixed') b.fixed++;
    }
  }

  // Seeded call records carry stable timestamps (artifact mtimes), so
  // re-seeding the same directory reproduces identical records — dedupe
  // those by full identity. Live records are never collapsed.
  const seenSeedCalls = new Set<string>();
  for (const rec of await readJsonl<CallRecord>(dir, CALLS_FILE)) {
    if (typeof rec.model !== 'string' || !inWindow(rec.ts)) continue;
    if (rec.source === 'seed') {
      const id = `${rec.ts} ${rec.model} ${rec.role ?? ''} ${rec.durationMs} ${rec.status}`;
      if (seenSeedCalls.has(id)) continue;
      seenSeedCalls.add(id);
    }
    const b = bucket(rec.model);
    b.calls++;
    if (rec.status === 'timeout' || rec.status === 'error') b.dead++;
    if (typeof rec.durationMs === 'number' && rec.durationMs > 0) b.durations.push(rec.durationMs);
  }

  return [...byModel.entries()]
    .map(([model, b]) => {
      const precision = b.outcomes > 0 ? b.fixed / b.outcomes : undefined;
      const sorted = [...b.durations].sort((x, y) => x - y);
      return {
        model,
        outcomes: b.outcomes,
        fixed: b.fixed,
        ...(precision !== undefined ? { precision } : {}),
        calls: b.calls,
        dead: b.dead,
        ...(b.calls > 0 ? { deadRate: b.dead / b.calls } : {}),
        // Same percentile convention as the audit scripts: s[floor(0.5·n)].
        ...(sorted.length > 0
          ? { p50Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length / 2))] }
          : {}),
        weight: computeWeight(precision, b.outcomes),
      };
    })
    .sort((a, b) => b.outcomes - a.outcomes || b.calls - a.calls);
}

/** Convenience: model → weight map for the voter and gating layers. */
export async function loadModelWeights(options: {
  dir?: string;
  windowDays?: number;
  now?: Date;
} = {}): Promise<Map<string, number>> {
  const stats = await loadModelStats(options);
  return new Map(stats.map((s) => [s.model, s.weight]));
}
