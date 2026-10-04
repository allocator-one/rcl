import { AmbiguousReviewerIdentityError, assertUnambiguousReviewerIdentities, type ReviewerIdentity } from './reviewer-identity.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelReview } from '../consensus/types.js';
import type { ReviewAdapter } from './adapter.js';
import type { ReasoningEffort } from '../config/schema.js';
import { defaultAdapterFactory } from './runner.js';
import { resolveGitCommonDir } from '../converge/attempt-budget.js';
import { readStable } from '../telemetry/recovery/files.js';

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

/**
 * Detached workers are one Node process each; a huge chunked diff must not
 * fan out into an unbounded process swarm. Beyond this, extra async calls
 * are dropped (the lane is a bonus, never load-bearing).
 */
export const MAX_ASYNC_CALLS_PER_ROUND = 8;

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
 * For a converging patch, pass the validated convergence target instead of
 * identifying the loop by its per-round capture path. Prefix the complete
 * key to keep this namespace separate without changing legacy target keys.
 */
export function asyncTargetKey(target: string, convergeTarget?: string, cycleId?: string): string {
  if (cycleId !== undefined) return `cycle-${asyncTargetKey(JSON.stringify([cycleId, convergeTarget ?? target]))}`;
  if (convergeTarget !== undefined) return `converge-${asyncTargetKey(convergeTarget)}`;
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
 *
 * The directory is verified before use — spools contain the diff, and a
 * forged result file would inject findings into the next round. A tmpdir
 * path in particular is predictable, so a pre-created symlink or another
 * user's directory must be rejected, never chmod'd or written into.
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
  const info = await lstat(base);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`async store path is not a plain directory: ${base}`);
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`async store directory is not owned by the current user: ${base}`);
  }
  // Ownership is established; now clamp permissions (mkdir mode does not
  // apply to a pre-existing directory).
  await chmod(base, 0o700);
  return base;
}

/** Resolve an existing async store without creating or changing it. */
export async function resolveExistingAsyncStoreDir(cwd = process.cwd()): Promise<string> {
  let base: string;
  try { base = join(await resolveGitCommonDir(cwd), 'rcl-async'); }
  catch { const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'; base = join(tmpdir(), `rcl-async-${uid}`); }
  const info = await lstat(base);
  if (info.isSymbolicLink() || !info.isDirectory() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error(`async store path is not a current-user plain directory: ${base}`);
  }
  return base;
}

function spoolPath(storeDir: string, targetKey: string): string {
  return join(storeDir, `pending-${targetKey}-${randomUUID()}.json`);
}

const execFileAsync = promisify(execFile);

/**
 * Current branch name for git-mode target labels, so `--staged` /
 * `--working-tree` reviews on different branches of one repository never
 * exchange async results. Best-effort: '' outside a repo or on detached
 * HEAD (the store is repo-scoped, so the label only needs to split
 * branches).
 */
export async function currentBranchLabel(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    });
    const branch = stdout.trim();
    return branch === 'HEAD' ? '' : branch;
  } catch {
    return '';
  }
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

const WORKER_ENV_PREFIXES = /^(ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|OPENROUTER_|AZURE_|NODE_|RCL_|LC_)/;
const WORKER_ENV_EXACT = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

/**
 * Environment for a detached worker: provider credentials/config, proxy and
 * locale basics — nothing else. The worker only ever talks to its model
 * provider, so unrelated secrets in the parent env (GITHUB_TOKEN, cloud
 * credentials, …) have no business outliving the review in a background
 * process.
 */
export function workerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (WORKER_ENV_PREFIXES.test(key) || WORKER_ENV_EXACT.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Launch one detached worker process per spool. Fire-and-forget by design:
 * the parent exits when the blocking council is done, and the workers keep
 * running until their call completes or times out. Launch failures are
 * contained: an unhandled child 'error' event would crash the review
 * process that is doing the real work.
 */
export function launchAsyncWorkers(spoolPaths: string[], cliScript = process.argv[1]): void {
  if (!cliScript) {
    console.warn('Async lane: cannot resolve the CLI script path; async reviewers not launched.');
    return;
  }
  const env = workerEnv();
  for (const spool of spoolPaths) {
    try {
      const child = spawn(process.execPath, [cliScript, 'async-worker', '--spool', spool], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.on('error', (err) => {
        console.warn(`Async worker failed to launch: ${String(err)}`);
      });
      child.unref();
    } catch (err) {
      console.warn(`Async worker failed to launch: ${String(err)}`);
    }
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

  await publishAsyncReview(resolve(spoolFile, '..'), payload.targetKey, review);
  await rm(spoolFile, { force: true });
}

/** Publish a derived opportunistic opinion; this store is never physical-call authority. */
export async function publishAsyncReview(storeDir: string, targetKey: string, review: ModelReview): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(targetKey)) throw new Error('invalid async opinion target');
  await assertSafeAsyncOpinionDirectory(storeDir);
  const resultFile = join(storeDir, `result-${targetKey}-${randomUUID()}.json`);
  const tempFile = `${resultFile}.tmp`;
  await writeFile(tempFile, JSON.stringify(review), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(tempFile, resultFile);
}

async function assertSafeAsyncOpinionDirectory(storeDir: string): Promise<void> {
  const info = await lstat(storeDir);
  const unsafePosixMetadata = process.platform !== 'win32' &&
    ((info.mode & 0o022) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid());
  if (!info.isDirectory() || info.isSymbolicLink() || unsafePosixMetadata) {
    throw new Error('unsafe async opinion directory');
  }
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
 * Exact bytes observed before a refusal. The original file remains untouched,
 * while the private refusal artifact can still recover it after normal store
 * cleanup removes the source path.
 */
export interface AsyncResultReference {
  path: string;
  sha256: string;
  bytesBase64: string;
}

/** Immutable read-only snapshot for a target-locked interrupted-launch resume. */
export async function snapshotAsyncResults(
  storeDir: string,
  targetKey: string,
  blockingReviews: readonly ReviewerIdentity[] = [],
  expectedSha256?: readonly string[],
): Promise<{ reviews: ModelReview[]; reviewBytes: string[]; artifacts: AsyncResultReference[] }> {
  await assertSafeAsyncOpinionDirectory(storeDir);
  const directoryNames = await readdir(storeDir);
  if (directoryNames.some(name => name.startsWith(`pending-${targetKey}-`) && name.endsWith('.json'))) {
    throw new Error('async_resume_worker_pending');
  }
  const resultPrefix = `result-${targetKey}-`;
  const names = directoryNames.filter(name =>
    name.startsWith(resultPrefix) &&
    (name.endsWith('.json') || /\.json(?:\.consumed-[A-Za-z0-9-]+)+$/.test(name))).sort();
  if (names.length > MAX_ASYNC_CALLS_PER_ROUND) throw new Error('async_resume_result_limit');
  const reviews: ModelReview[] = [], reviewBytes: string[] = [], artifacts: AsyncResultReference[] = [];
  for (const name of names) {
    const path = join(storeDir, name);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 8 * 1024 * 1024) {
      throw new Error('async_resume_result_invalid');
    }
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('async_resume_result_changed');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('async_resume_result_invalid'); }
    if (!isReviewShape(parsed) || parsed.async !== true) throw new Error('async_resume_result_invalid');
    const review = structuredClone(parsed);
    reviews.push(review);
    reviewBytes.push(bytes.toString('utf8'));
    artifacts.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: bytes.toString('base64') });
  }
  assertUnambiguousReviewerIdentities([...blockingReviews, ...reviews]);
  if (expectedSha256 !== undefined) {
    const expected = [...expectedSha256].sort();
    const actual = artifacts.map(artifact => artifact.sha256).sort();
    if (expected.length !== new Set(expected).size ||
      expected.some(digest => !/^[a-f0-9]{64}$/.test(digest)) ||
      expected.length !== actual.length || expected.some((digest, index) => digest !== actual[index])) {
      throw new Error('async_resume_result_binding_mismatch');
    }
  }
  return { reviews, reviewBytes, artifacts };
}

/**
 * Snapshot unattributed history from one authenticated cycle namespace.
 * Duplicate reviewer identities are expected across attempts, so these bytes
 * are archival evidence only and can never be admitted as council findings.
 */
export async function snapshotAsyncHistory(
  storeDir: string,
  targetKey: string,
  maxResults: number,
  expectedSha256?: readonly string[],
): Promise<{ reviews: ModelReview[]; reviewBytes: string[]; artifacts: AsyncResultReference[] }> {
  await assertSafeAsyncOpinionDirectory(storeDir);
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) throw new Error('async_history_result_limit');
  const directoryNames = await readdir(storeDir);
  if (directoryNames.some(name => name.startsWith(`pending-${targetKey}-`) && name.endsWith('.json'))) {
    throw new Error('async_resume_worker_pending');
  }
  const resultPrefix = `result-${targetKey}-`;
  const names = directoryNames.filter(name => name.startsWith(resultPrefix) &&
    (name.endsWith('.json') || /\.json(?:\.consumed-[A-Za-z0-9-]+)+$/.test(name))).sort();
  if (names.length > maxResults) throw new Error('async_history_result_limit');
  const reviews: ModelReview[] = [], reviewBytes: string[] = [], artifacts: AsyncResultReference[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const path = join(storeDir, name);
    let bytes: Buffer;
    try {
      bytes = (await readStable(path, 8 * 1024 * 1024)).raw;
    } catch (error) {
      if ((error as Error).message === 'changing_source' ||
          (error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('async_resume_result_changed');
      throw new Error('async_resume_result_invalid');
    }
    if ((totalBytes += bytes.length) > 20 * 1024 * 1024) throw new Error('async_resume_result_invalid');
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('async_resume_result_invalid'); }
    if (!isReviewShape(parsed) || parsed.async !== true) throw new Error('async_resume_result_invalid');
    reviews.push(structuredClone(parsed));
    reviewBytes.push(bytes.toString('utf8'));
    artifacts.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'),
      bytesBase64: bytes.toString('base64') });
  }
  if (expectedSha256 !== undefined) {
    const expected = [...expectedSha256].sort();
    const actual = artifacts.map(artifact => artifact.sha256).sort();
    if (expected.some(value => !/^[a-f0-9]{64}$/.test(value)) ||
        expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
      throw new Error('async_resume_result_binding_mismatch');
    }
  }
  return { reviews, reviewBytes, artifacts };
}

/** Remove only the exact archived cycle-history files after a terminal receipt exists. */
export async function consumeBoundAsyncHistory(storeDir: string, targetKey: string,
  expectedSha256: readonly string[], maxResults: number): Promise<void> {
  const snapshot = await snapshotAsyncHistory(storeDir, targetKey, maxResults);
  const expected = [...expectedSha256].sort();
  const actual = snapshot.artifacts.map(item => item.sha256).sort();
  const remaining = new Map<string, number>();
  for (const digest of expected) remaining.set(digest, (remaining.get(digest) ?? 0) + 1);
  for (const digest of actual) {
    const count = remaining.get(digest) ?? 0;
    if (count === 0) throw new Error('async_resume_result_binding_mismatch');
    remaining.set(digest, count - 1);
  }
  for (const artifact of snapshot.artifacts) {
    const retained = `${artifact.path}.consumed-${randomUUID()}`;
    await rename(artifact.path, retained);
    try {
      const bytes = await readFile(retained);
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
        throw new Error('async_resume_result_changed');
      }
      await rm(retained, { force: true });
    } catch (error) {
      try { await rename(retained, artifact.path); } catch { /* preserve the original error */ }
      throw error;
    }
  }
}

/** Consume only the exact reviewed async artifacts after terminal recovery. */
export async function consumeBoundAsyncResults(
  storeDir: string,
  targetKey: string,
  expectedSha256: readonly string[],
  options: { allowAlreadyConsumed?: boolean } = {},
): Promise<void> {
  const snapshot = await snapshotAsyncResults(storeDir, targetKey);
  if (options.allowAlreadyConsumed && snapshot.artifacts.length === 0) return;
  const expected = [...expectedSha256].sort();
  const actual = snapshot.artifacts.map(artifact => artifact.sha256).sort();
  const valid = options.allowAlreadyConsumed
    ? actual.every(digest => expected.includes(digest))
    : expected.length === actual.length && expected.every((digest, index) => digest === actual[index]);
  if (!valid) {
    throw new Error('async_resume_result_binding_mismatch');
  }
  for (const artifact of snapshot.artifacts) {
    const retained = `${artifact.path}.consumed-${randomUUID()}`;
    await rename(artifact.path, retained);
    try {
      const bytes = await readFile(retained);
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
        await rename(retained, artifact.path);
        throw new Error('async_resume_result_changed');
      }
      await rm(retained, { force: true });
    } catch (error) {
      try { await rename(retained, artifact.path); } catch { /* preserve the original error */ }
      throw error;
    }
  }
}

interface ObservedAsyncResult {
  path: string;
  bytes: Buffer;
}

/**
 * Collect (and consume) every arrived async result for this target. Corrupt
 * files are skipped and removed; other targets' files are left alone except
 * for a TTL sweep of stale leftovers.
 */
export async function collectAsyncResults(
  storeDir: string,
  targetKey: string,
  options: { blockingReviews?: readonly ReviewerIdentity[]; onIdentityRefused?: (error: AmbiguousReviewerIdentityError, artifacts: AsyncResultReference[]) => Promise<void> } = {},
): Promise<ModelReview[]> {
  let entries: string[];
  try {
    await assertSafeAsyncOpinionDirectory(storeDir);
    entries = await readdir(storeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const collected: ModelReview[] = [];
  const observed: ObservedAsyncResult[] = [];
  const consumed: string[] = [];
  const expired: string[] = [];
  const now = Date.now();
  for (const name of entries) {
    const path = join(storeDir, name);
    if (name.startsWith(`result-${targetKey}-`) && name.endsWith('.json')) {
      try {
        const bytes = await readFile(path);
        const parsed: unknown = JSON.parse(bytes.toString('utf8'));
        if (isReviewShape(parsed)) {
          parsed.async = true;
          collected.push(parsed);
          observed.push({ path, bytes });
        }
      } catch {
        // Corrupt or half-written by an interrupted worker — drop it below.
      }
      consumed.push(path);
      continue;
    }
    // TTL sweep for abandoned spools/results from other runs.
    if (name.startsWith('pending-') || name.startsWith('result-')) {
      try {
        const info = await stat(path);
        if (now - info.mtimeMs > STALE_TTL_MS) expired.push(path);
      } catch {
        // Already gone — nothing to sweep.
      }
    }
  }
  // Validate the entire union before consuming even the first retained opinion.
  try { assertUnambiguousReviewerIdentities([...(options.blockingReviews ?? []), ...collected]); }
  catch (error) {
    if (error instanceof AmbiguousReviewerIdentityError) {
      const artifacts = observed.map(({ path, bytes }) => ({
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytesBase64: bytes.toString('base64'),
      }));
      await options.onIdentityRefused?.(error, artifacts);
    }
    throw error;
  }
  for (const path of consumed) await rm(path, { force: true });
  for (const path of expired) await rm(path, { force: true }).catch(() => undefined);
  return collected;
}
