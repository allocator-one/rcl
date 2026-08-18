import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['RCL_DATA_DIR']?.trim();
  return override && override.length > 0 ? override : join(homedir(), '.rcl');
}

async function appendJsonl(dir: string, file: string, records: object[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await appendFile(join(dir, file), lines, { encoding: 'utf8', mode: 0o600 });
}

export async function appendOutcomes(records: OutcomeRecord[], dir = resolveDataDir()): Promise<void> {
  await appendJsonl(dir, OUTCOMES_FILE, records);
}

export async function appendCalls(records: CallRecord[], dir = resolveDataDir()): Promise<void> {
  await appendJsonl(dir, CALLS_FILE, records);
}

async function readJsonl<T>(dir: string, file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, file), 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn or corrupt line loses one record, never the store.
    }
  }
  return out;
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

  // Idempotency at load: verdicts can be re-recorded (converge re-runs, a
  // later verdict superseding an earlier one) and seeds re-run — the LAST
  // record per (target, findingKey) wins; keyless records pass through.
  const outcomesByKey = new Map<string, OutcomeRecord>();
  const keylessOutcomes: OutcomeRecord[] = [];
  for (const rec of await readJsonl<OutcomeRecord>(dir, OUTCOMES_FILE)) {
    if (!Array.isArray(rec.models) || !inWindow(rec.ts)) continue;
    if (rec.verdict !== 'fixed' && rec.verdict !== 'dismissed') continue;
    if (rec.target && rec.findingKey) {
      outcomesByKey.set(`${rec.target} ${rec.findingKey}`, rec);
    } else {
      keylessOutcomes.push(rec);
    }
  }
  for (const rec of [...outcomesByKey.values(), ...keylessOutcomes]) {
    for (const model of new Set(rec.models)) {
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
