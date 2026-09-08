import { openReadSink, type ReadSinkOptions } from '../telemetry/read-sink.js';
import { describeOutcome } from '../telemetry/sink.js';
import { DEFAULT_WINDOW_DAYS, loadModelStats, MIN_OUTCOMES_FOR_WEIGHT, type ModelStats } from './stats-store.js';

/**
 * Org-wide model weights from Harness (epic IO-12475, sections 8.9–8.10;
 * RCL-38): `GET /api/v1/reviews/model-stats` is the server-side `rcl models`
 * over every run the organization recorded — live and backfilled, from
 * every machine — so a fresh install weights consensus the way the org's
 * history says, not the way one `~/.rcl` does. The server wins for a model
 * it has at least the outcome floor for; below that the local store decides;
 * a model neither knows enough about keeps the neutral weight.
 */

export interface ServerModelStat {
  model: string;
  outcomes: number;
  fixed: number;
  precision: number | null;
  calls: number;
  dead: number;
  dead_rate: number | null;
  p50_ms: number | null;
  weight: number;
  tiers?: unknown;
}

export interface ServerModelStats {
  window_days: number;
  computed_at: string;
  min_outcomes_for_weight: number;
  models: ServerModelStat[];
}

export type ServerStatsOutcome = { kind: 'ok'; value: ServerModelStats; host: string } | { kind: 'none'; reason: string };

export interface MergedStat {
  model: string;
  weight: number;
  /** Where the weight came from: the server window, this machine's store, or neither (neutral 1). */
  source: 'server' | 'local' | 'neutral';
  serverOutcomes?: number;
  localOutcomes?: number;
  local?: ModelStats;
  server?: ServerModelStat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const count = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const rate = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
const latency = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
/** The voter's range; a row outside it is not a weight this client will apply. */
const weightInRange = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0.5 && v <= 1.5;

/** Every field the merge and the table read, in the ranges the server documents; one bad row refuses the answer. */
export function isServerModelStats(value: unknown): value is ServerModelStats {
  return (
    isRecord(value) &&
    count(value['window_days']) &&
    typeof value['computed_at'] === 'string' &&
    count(value['min_outcomes_for_weight']) &&
    Array.isArray(value['models']) &&
    value['models'].every(
      (m) =>
        isRecord(m) &&
        typeof m['model'] === 'string' &&
        m['model'] !== '' &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(m['model']) &&
        count(m['outcomes']) &&
        count(m['fixed']) &&
        count(m['calls']) &&
        count(m['dead']) &&
        rate(m['precision'] ?? null) &&
        rate(m['dead_rate'] ?? null) &&
        latency(m['p50_ms'] ?? null) &&
        weightInRange(m['weight'])
    )
  );
}

export interface ServerStatsOptions extends ReadSinkOptions {
  windowDays?: number;
  /** Bound one request, e.g. so a review's start is never held up by a slow host. */
  timeoutMs?: number;
}

/** The org's stats, or one phrase saying why there are none — never a throw. */
export async function fetchServerModelStats(options: ServerStatsOptions): Promise<ServerStatsOutcome> {
  const opened = await openReadSink(options);
  if (!opened.sink) return { kind: 'none', reason: opened.note };
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const outcome = await opened.sink.getJson(
    `/api/v1/reviews/model-stats?window_days=${encodeURIComponent(String(windowDays))}`,
    (data) => (isServerModelStats(data) ? data : null),
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
  );
  if (outcome.kind !== 'ok') return { kind: 'none', reason: describeOutcome(outcome) };
  return { kind: 'ok', value: outcome.value, host: opened.host };
}

/**
 * One row per model known anywhere: the server's weight where it holds at
 * least its own floor (`min_outcomes_for_weight`) of outcomes for the model,
 * else the local weight (at least `minOutcomes` local outcomes), else
 * neutral. Ordered by the evidence behind the row, most first.
 */
export function mergeWeights(
  local: ModelStats[],
  server: ServerModelStats | undefined,
  minOutcomes: number = MIN_OUTCOMES_FOR_WEIGHT
): MergedStat[] {
  const rows = new Map<string, MergedStat>();
  for (const stat of local) {
    // The local store's own floor: below it the weight is neutral and says so.
    const source = stat.outcomes >= minOutcomes ? 'local' : 'neutral';
    rows.set(stat.model, { model: stat.model, weight: stat.weight, source, localOutcomes: stat.outcomes, local: stat });
  }
  // The server states the floor it applied; it may raise this client's
  // floor, never lower it below the 20 outcomes the contract promises.
  const serverFloor = Math.max(minOutcomes, server?.min_outcomes_for_weight ?? minOutcomes);
  for (const stat of server?.models ?? []) {
    const existing = rows.get(stat.model);
    if (stat.outcomes >= serverFloor) {
      const weight = Math.min(1.5, Math.max(0.5, stat.weight));
      rows.set(stat.model, { ...(existing ?? { model: stat.model }), weight, source: 'server', serverOutcomes: stat.outcomes, server: stat });
    } else if (existing) {
      existing.server = stat;
      existing.serverOutcomes = stat.outcomes;
    } else {
      rows.set(stat.model, { model: stat.model, weight: 1, source: 'neutral', serverOutcomes: stat.outcomes, server: stat });
    }
  }
  return [...rows.values()].sort(
    (a, b) => (b.serverOutcomes ?? 0) + (b.localOutcomes ?? 0) - ((a.serverOutcomes ?? 0) + (a.localOutcomes ?? 0)) || a.model.localeCompare(b.model)
  );
}

export interface MergedWeightsOptions extends ServerStatsOptions {
  /** The local store's rows; injected by tests. */
  localStats?: () => Promise<ModelStats[]>;
  /**
   * Whether to ask the server at all. A review passes the resolved telemetry
   * level here: `off` means no request leaves the machine for weights either.
   */
  serverEnabled?: boolean;
}

/**
 * Model → weight for the voter: server-backed where the org has enough
 * history, local otherwise; local alone when the server is switched off or
 * cannot answer. The server side — credential lookup and the request — is
 * bounded by `timeoutMs` (default 3 s); the request itself is aborted by the
 * sink at that deadline, and the local store is read as any local file is.
 */
export async function loadMergedWeights(options: MergedWeightsOptions): Promise<Map<string, number>> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const local = await (options.localStats ?? (() => loadModelStats({ windowDays })))();
  let server: ServerModelStats | undefined;
  if (options.serverEnabled !== false) {
    const timeoutMs = options.timeoutMs ?? 3_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const fetched = await Promise.race([
        fetchServerModelStats({ ...options, windowDays, timeoutMs }),
        new Promise<ServerStatsOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'none', reason: `no answer within ${timeoutMs} ms` }), timeoutMs);
        }),
      ]);
      if (fetched.kind === 'ok') server = fetched.value;
    } catch {
      server = undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return new Map(mergeWeights(local, server).map((row) => [row.model, row.weight]));
}
