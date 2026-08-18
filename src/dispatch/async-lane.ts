import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter } from './adapter.js';
import type { ReasoningEffort } from '../config/schema.js';
import { defaultAdapterFactory } from './runner.js';
import { resolveGitCommonDir } from '../converge/attempt-budget.js';

/**
 * Async review lane (RCL-25). Async models are fired with the round but never
 * awaited: the main process writes a spool file per call and launches a
 * detached worker (`rcl async-worker`) that runs the call and drops the
 * completed ModelReview into the store. The NEXT review of the same target
 * collects whatever has arrived and merges it into its dedup, marked async.
 *
 * The store lives in the repository's git common dir (durable across rounds,
 * repo-scoped, not world-writable), falling back to a per-user tmp dir when
 * reviewing outside a repository.
 */

export interface AsyncCallSpec {
  model: string;
  role: string;
  provider: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface AsyncLaneOptions {
  storeDir: string;
  targetKey: string;
  timeoutMs: number;
  maxRetries: number;
  reasoningEffort?: ReasoningEffort;
}

interface SpoolPayload extends AsyncCallSpec {
  version: 1;
  targetKey: string;
  timeoutMs: number;
  maxRetries: number;
  reasoningEffort?: ReasoningEffort;
  launchedAt: string;
}

/** Results older than this are stale runs' leftovers and get swept. */
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Split assignments so async models never sit on the blocking path. */
export function partitionAsyncAssignments<A extends { model: string }>(
  assignments: A[],
  asyncModels: readonly string[]
): { blocking: A[]; async: A[] } {
  const asyncSet = new Set(asyncModels);
  const blocking: A[] = [];
  const async: A[] = [];
  for (const a of assignments) {
    (asyncSet.has(a.model) ? async : blocking).push(a);
  }
  return { blocking, async };
}

/**
 * Stable, filesystem-safe key for a review target, so consecutive rounds of
 * the same converge run find each other's async results and different targets
 * never collide. Same alphabet rule as the converge attempt store.
 */
export function asyncTargetKey(target: string): string {
  const slug = target
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const digest = createHash('sha256').update(target).digest('hex').slice(0, 12);
  return `${slug || 'target'}.${digest}`;
}

/**
 * Store directory: `<gitCommonDir>/rcl-async` inside a repository, else a
 * per-user directory under the OS tmpdir (mode 0700 either way).
 */
export async function resolveAsyncStoreDir(cwd = process.cwd()): Promise<string> {
  let base: string;
  try {
    base = join(await resolveGitCommonDir(cwd), 'rcl-async');
  } catch {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
    base = join(tmpdir(), `rcl-async-${uid}`);
  }
  await mkdir(base, { recursive: true, mode: 0o700 });
  return base;
}

function spoolPath(storeDir: string, targetKey: string): string {
  return join(storeDir, `pending-${targetKey}-${randomUUID()}.json`);
}

/** Write one spool file per async call; returns the spool paths. */
export async function spoolAsyncCalls(
  calls: AsyncCallSpec[],
  options: AsyncLaneOptions
): Promise<string[]> {
  await mkdir(options.storeDir, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const call of calls) {
    const payload: SpoolPayload = {
      version: 1,
      targetKey: options.targetKey,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      launchedAt: new Date().toISOString(),
      ...call,
    };
    const path = spoolPath(options.storeDir, options.targetKey);
    // Spools contain the diff — keep them owner-readable only.
    await writeFile(path, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    paths.push(path);
  }
  return paths;
}

/**
 * Launch one detached worker process per spool. Fire-and-forget by design:
 * the parent exits when the blocking council is done, and the workers keep
 * running until their call completes or times out. Provider keys travel via
 * inherited env.
 */
export function launchAsyncWorkers(spoolPaths: string[], cliScript = process.argv[1]!): void {
  for (const spool of spoolPaths) {
    const child = spawn(process.execPath, [cliScript, 'async-worker', '--spool', spool], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  }
}

/**
 * Worker body: consume one spool file, run the call, publish the completed
 * review atomically (tmp + rename, so collect never reads a half-written
 * file). A failed call still publishes — an async reviewer that silently
 * vanishes would be invisible in every report.
 */
export async function runAsyncWorker(
  spoolFile: string,
  adapterFactory?: (provider: string) => ReviewAdapter
): Promise<void> {
  const payload = JSON.parse(await readFile(spoolFile, 'utf8')) as SpoolPayload;
  const factory =
    adapterFactory ?? ((provider: string) => defaultAdapterFactory(provider, payload.reasoningEffort));

  let review: ModelReview;
  try {
    const adapter = factory(payload.provider);
    review = await adapter.review(
      payload.model,
      payload.role,
      payload.systemPrompt,
      payload.userPrompt,
      { timeoutMs: payload.timeoutMs, maxRetries: payload.maxRetries }
    );
  } catch (err) {
    review = {
      model: payload.model,
      role: payload.role,
      provider: payload.provider,
      findings: [],
      durationMs: 0,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  review.async = true;

  const dir = resolve(spoolFile, '..');
  const resultFile = join(dir, `result-${payload.targetKey}-${randomUUID()}.json`);
  const tempFile = `${resultFile}.tmp`;
  await writeFile(tempFile, JSON.stringify(review), { encoding: 'utf8', mode: 0o600 });
  await rename(tempFile, resultFile);
  await rm(spoolFile, { force: true });
}

function isReviewShape(value: unknown): value is ModelReview {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<ModelReview>;
  return (
    typeof r.model === 'string' &&
    typeof r.role === 'string' &&
    typeof r.status === 'string' &&
    Array.isArray(r.findings)
  );
}

/**
 * Collect (and consume) every arrived async result for this target. Corrupt
 * files are skipped and removed; other targets' files are left alone except
 * for a TTL sweep of stale leftovers.
 */
export async function collectAsyncResults(
  storeDir: string,
  targetKey: string
): Promise<ModelReview[]> {
  let entries: string[];
  try {
    entries = await readdir(storeDir);
  } catch {
    return [];
  }

  const collected: ModelReview[] = [];
  const now = Date.now();
  for (const name of entries) {
    const path = join(storeDir, name);
    if (name.startsWith(`result-${targetKey}-`) && name.endsWith('.json')) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (isReviewShape(parsed)) {
          parsed.async = true;
          collected.push(parsed);
        }
      } catch {
        // Corrupt or half-written by an interrupted worker — drop it below.
      }
      await rm(path, { force: true });
      continue;
    }
    // TTL sweep for abandoned spools/results from other runs.
    if (name.startsWith('pending-') || name.startsWith('result-')) {
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > STALE_TTL_MS) await rm(path, { force: true });
      } catch {
        // Already gone — nothing to sweep.
      }
    }
  }
  return collected;
}
