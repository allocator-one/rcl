import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDiffFromString } from './local.js';
import { parseUnifiedDiff } from '../prepare/unified-diff.js';
import type { Diff } from './types.js';

const execFileAsync = promisify(execFile);

// Preserve the ordinary local-reader limit. Explicit PR capacity has a
// separate finite ceiling and never truncates output to satisfy it.
const MAX_DIFF_BYTES = 10 * 1024 * 1024;
const MAX_PINNED_DIFF_BYTES = 32 * 1024 * 1024;

export type GitDiffMode = 'staged' | 'working-tree';

const MODE_ARGS: Record<GitDiffMode, string[]> = {
  // Staged changes only (what `git commit` would pick up right now).
  staged: ['diff', '--cached'],
  // Everything uncommitted relative to HEAD: staged + unstaged. Untracked
  // files are invisible to `git diff` and therefore not reviewed.
  'working-tree': ['diff', 'HEAD'],
};

async function runGit(args: string[], cwd: string, maxBytes = MAX_DIFF_BYTES): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      // quotepath off so non-ASCII filenames survive parseDiffText's header
      // match; ext-diff off so a configured external diff tool can't replace
      // the unified format the parser expects.
      ['-c', 'core.quotepath=false', ...args, '--no-color', '--no-ext-diff'],
      { cwd, maxBuffer: maxBytes }
    );
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : `: ${String(err)}`}`);
  }
}

export interface GitHeads {
  /** `git rev-parse HEAD` — the commit a staged/working-tree review is relative to. */
  headSha?: string;
  /** Merge-base of HEAD with the remote default branch (`origin/HEAD`, then `origin/main`). */
  baseSha?: string;
}

/** A full object id in either repository format: SHA-1 (40 hex) or SHA-256 (64 hex). */
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

async function revParse(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    const sha = stdout.trim();
    return FULL_OBJECT_ID.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The remote default branch: `origin/HEAD` when the clone recorded it, else
 * the conventional names in order. Shallow CI checkouts and `git remote add`
 * clones have no `origin/HEAD`, so the fallbacks carry real weight.
 */
const DEFAULT_BRANCH_FALLBACKS = ['origin/main', 'origin/master'] as const;

/**
 * Best-effort exact-head binding for local review modes (IO-12475 section
 * 8.1). Never throws: outside a repository, on an unborn branch, or without
 * a remote default branch the corresponding field is simply absent and the
 * report records only the diff digest.
 */
export async function resolveGitHeads(cwd = process.cwd()): Promise<GitHeads> {
  const headSha = await revParse(cwd, 'rev-parse', 'HEAD');
  if (headSha === undefined) return {};
  let baseSha: string | undefined;
  for (const ref of ['origin/HEAD', ...DEFAULT_BRANCH_FALLBACKS]) {
    baseSha = await revParse(cwd, 'merge-base', 'HEAD', ref);
    if (baseSha !== undefined) break;
  }
  return { headSha, ...(baseSha !== undefined ? { baseSha } : {}) };
}

export async function loadGitDiff(mode: GitDiffMode, cwd = process.cwd(), maxDiffBytes?: number): Promise<Diff> {
  const maxBytes = validateDiffCapacity(maxDiffBytes);
  // Fail with a clear message when we're not in a git repository (or git is
  // missing) before attempting the actual diff.
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd });
  } catch {
    throw new Error(`--${mode} requires running inside a git repository`);
  }

  const diffText = await runGit(MODE_ARGS[mode], cwd, maxBytes);
  return { ...parseDiffFromString(diffText), source: 'local' };
}

export interface PinnedGitDiffOptions {
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
  cwd?: string;
  maxBytes?: number;
  /** GitHub's immutable base...head comparison, when acquired by the caller. */
  expectedMergeBaseSha?: string;
}

/** Only unavailable local objects permit a hosted acquisition retry. */
export class PinnedGitObjectsUnavailableError extends Error {}

function validateDiffCapacity(requested?: number): number {
  const maxBytes = requested ?? MAX_DIFF_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PINNED_DIFF_BYTES) {
    throw new Error(`Invalid Git diff capacity: expected 1–${MAX_PINNED_DIFF_BYTES} bytes.`);
  }
  return maxBytes;
}

function githubRepository(remote: string): string | undefined {
  const ssh = /^git@github\.com:([^\s]+)$/i.exec(remote);
  let path: string;
  if (ssh) path = ssh[1]!;
  else {
    let url: URL;
    try { url = new URL(remote); } catch { return undefined; }
    if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com' ||
      url.port || url.search || url.hash) return undefined;
    path = url.pathname.replace(/^\//, '');
  }
  path = path.replace(/\/$/, '');
  return /^[\w.-]+\/[\w.-]+(?:\.git)?$/u.test(path)
    ? path.replace(/\.git$/i, '').toLowerCase() : undefined;
}

/** Read the exact PR comparison from existing objects; never fetch or change refs. */
export async function loadPinnedGitDiff(options: PinnedGitDiffOptions): Promise<Diff & { mergeBaseSha: string }> {
  const cwd = options.cwd ?? process.cwd();
  const maxBytes = validateDiffCapacity(options.maxBytes);
  if (!FULL_OBJECT_ID.test(options.baseSha) || !FULL_OBJECT_ID.test(options.headSha) ||
    (options.expectedMergeBaseSha !== undefined && !FULL_OBJECT_ID.test(options.expectedMergeBaseSha))) {
    throw new Error('Pinned PR diff requires exact commits, not revision names.');
  }
  // Object reads in partial clones can otherwise invoke a promisor fetch.
  // Deny transports as a backstop for Git versions predating NO_LAZY_FETCH;
  // the separately bounded hosted reader is the only acquisition path.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  const readGit = async (args: string[], bound = 16_384): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', ['--no-replace-objects', ...args], {
        cwd, env, maxBuffer: bound, encoding: 'utf8', timeout: 60_000,
      });
      return stdout;
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: unknown };
      const missing = typeof failure.stderr === 'string'
        ? /^fatal: unable to read ([a-f0-9]+)\r?$/m.exec(failure.stderr) : null;
      // Only an explicit missing object may select hosted acquisition. Output
      // limits and malformed patches must keep their original refusal.
      if (failure.code === 128 && missing && FULL_OBJECT_ID.test(missing[1]!)) {
        throw new PinnedGitObjectsUnavailableError('Pinned PR diff requires locally available objects; a referenced object is missing.');
      }
      throw error;
    }
  };
  let remote: string;
  try { remote = (await readGit(['config', '--get', 'remote.origin.url'])).trim(); }
  catch { throw new PinnedGitObjectsUnavailableError('Pinned PR repository mismatch: a matching local GitHub origin is required.'); }
  if (githubRepository(remote) !== `${options.owner}/${options.repo}`.toLowerCase()) {
    throw new PinnedGitObjectsUnavailableError('Pinned PR repository mismatch: the local origin does not identify the requested GitHub repository.');
  }
  let mergeBaseSha: string;
  try {
    if ((await readGit(['rev-parse', '--is-shallow-repository'])).trim() !== 'false') {
      throw new Error('incomplete ancestry');
    }
    for (const sha of [options.baseSha, options.headSha]) {
      if ((await readGit(['rev-parse', '--verify', `${sha}^{commit}`])).trim() !== sha) throw new Error('missing commit');
    }
    mergeBaseSha = (await readGit(['merge-base', '--all', options.baseSha, options.headSha])).trim();
    if (!FULL_OBJECT_ID.test(mergeBaseSha)) throw new Error('ambiguous or missing merge base');
  } catch {
    throw new PinnedGitObjectsUnavailableError('Pinned PR diff requires both exact commits and one unambiguous merge base in a complete local repository.');
  }
  if (options.expectedMergeBaseSha !== undefined && options.expectedMergeBaseSha !== mergeBaseSha) {
    throw new Error('Pinned PR merge base disagrees with the exact GitHub comparison.');
  }
  return readPinnedPatch(readGit, mergeBaseSha, options.headSha, maxBytes);
}

async function readPinnedPatch(
  readGit: (args: string[], bound?: number) => Promise<string>,
  mergeBaseSha: string,
  headSha: string,
  maxBytes: number
): Promise<Diff & { mergeBaseSha: string }> {
  let rawDiff: string;
  try {
    rawDiff = await readGit(['-c', 'core.quotepath=false', '-c', 'diff.algorithm=myers',
      '-c', 'diff.indentHeuristic=true', 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
      '--find-renames=50%', '--full-index', '--binary', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3',
      mergeBaseSha, headSha, '--'], maxBytes);
  } catch (error) {
    if (error instanceof PinnedGitObjectsUnavailableError) throw error;
    throw new Error(`Pinned PR diff could not be read within its ${maxBytes}-byte output bound.`);
  }
  if (/^GIT binary patch$/m.test(rawDiff) || /^Binary files .+ differ$/m.test(rawDiff)) {
    throw new Error('A complete PR patch contains binary changes that cannot be represented as textual review input.');
  }
  // The parser proves each header against its path metadata (or exact
  // same-path symmetry). Counting blocks alone cannot detect wrong identities.
  const diff = parseDiffFromString(rawDiff);
  const blocks = rawDiff.split(/^diff --git /m).filter(Boolean);
  if (blocks.length !== diff.files.length || new Set(diff.files.map(file => file.filename)).size !== blocks.length) {
    throw new Error('Pinned PR patch parsing was incomplete; unsupported or ambiguous filenames cannot be skipped.');
  }
  for (const [index, file] of diff.files.entries()) {
    if (file.patch) {
      if (!parseUnifiedDiff(file.patch).ok) throw new Error(`Pinned PR patch is incomplete for ${file.filename}.`);
      const lines = file.patch.split('\n');
      file.additions = lines.filter(line => line.startsWith('+')).length;
      file.deletions = lines.filter(line => line.startsWith('-')).length;
    }
    const ids = /^index ([a-f0-9]+)\.\.([a-f0-9]+)/m.exec(blocks[index]!);
    if (ids) file.blobSha = /^0+$/.test(ids[2]!) ? ids[1]! : ids[2]!;
  }
  return { ...diff, mergeBaseSha };
}

const HOSTED_GIT_TIMEOUT_MS = 180_000;
const HOSTED_GIT_STORAGE_BYTES = 512 * 1024 * 1024;

/**
 * Read GitHub's pinned comparison in a disposable object database. The API
 * supplies the merge base; depth-one snapshots must never infer ancestry.
 * Blobless snapshots omit unchanged file contents; Git's promisor machinery
 * fetches the changed blobs needed by diff inside the same bounded process.
 * No PR checkout, config, hooks, credential helper, or submodule is executed.
 */
export async function loadHostedPinnedGitDiff(
  options: PinnedGitDiffOptions & { expectedMergeBaseSha: string; token?: string }
): Promise<Diff & { mergeBaseSha: string }> {
  const maxBytes = validateDiffCapacity(options.maxBytes);
  const origin = `https://github.com/${options.owner}/${options.repo}.git`;
  if (githubRepository(origin) !== `${options.owner}/${options.repo}`.toLowerCase() ||
    ![options.baseSha, options.headSha, options.expectedMergeBaseSha].every(sha => /^[a-f0-9]{40}$/.test(sha)) ||
    (options.token !== undefined && (typeof options.token !== 'string' || /[\r\n\0]/.test(options.token)))) {
    throw new Error('Hosted PR acquisition requires a GitHub repository, exact comparison commits and a valid optional token.');
  }
  const cwd = await mkdtemp(join(tmpdir(), 'rcl-pr-objects-'));
  const deadline = Date.now() + HOSTED_GIT_TIMEOUT_MS;
  // Do not inherit Git tracing, alternate object databases, injected config or
  // credential helpers. Authorization exists only in the child's environment.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https', GIT_CONFIG_COUNT: '0' });
  const token = options.token?.trim();
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${origin}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
  const argsPrefix = ['--no-replace-objects', '-c', `core.hooksPath=${join(cwd, 'disabled-hooks')}`, '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true', '-c', 'submodule.recurse=false',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.unpackLimit=0'];
  const readGit = (args: string[], bound = 16_384) => runHostedGit(
    [...argsPrefix, ...args], cwd, env, deadline, bound
  );
  try {
    await readGit(['init', '--bare', '--template=', '--quiet', '.']);
    await readGit(['remote', 'add', 'origin', origin]);
    if ((await readGit(['config', '--get', 'remote.origin.url'])).trim() !== origin) {
      throw new Error('Hosted PR repository identity did not match.');
    }
    await readGit(['fetch', '--quiet', '--depth=1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules',
      '--no-write-fetch-head', '--no-auto-maintenance', 'origin',
      ...new Set([options.headSha, options.expectedMergeBaseSha])]);
    for (const sha of [options.headSha, options.expectedMergeBaseSha]) {
      if ((await readGit(['rev-parse', '--verify', `${sha}^{commit}`])).trim() !== sha) {
        throw new Error('Hosted PR acquisition did not return the exact comparison commits.');
      }
    }
    return await readPinnedPatch(readGit, options.expectedMergeBaseSha, options.headSha, maxBytes);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function repositoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    try {
      bytes += entry.isDirectory() ? await repositoryBytes(path) : (await stat(path)).size;
    } catch (error) {
      // Git atomically renames temporary pack/index files during acquisition.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (bytes > HOSTED_GIT_STORAGE_BYTES) return bytes;
  }
  return bytes;
}

/** Bound subprocess output, elapsed time and retained object bytes; redact all Git errors. */
async function runHostedGit(
  args: string[], cwd: string, env: NodeJS.ProcessEnv, deadline: number, maxBytes: number
): Promise<string> {
  if (Date.now() >= deadline) throw new Error('Hosted PR acquisition exceeded its time bound.');
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let outputBytes = 0, errorBytes = 0, failure: string | undefined, closed = false;
    let diagnosticTail = '';
    let storageCheck: Promise<void> | undefined;
    const stop = (message: string) => {
      failure ??= message;
      if (closed) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The child may already have exited. */ }
    };
    child.stdout.on('data', (data: Buffer) => {
      outputBytes += data.length;
      if (outputBytes > maxBytes) stop('Hosted PR acquisition exceeded its output byte bound.');
      else chunks.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      errorBytes += data.length;
      if (errorBytes > 65_536) {
        stop('Hosted PR acquisition exceeded its diagnostic byte bound.');
        return;
      }
      // Git otherwise warns and silently downloads full snapshots when the
      // server lacks filtering. Detect split writes too, including a nested
      // promisor fetch launched by diff, and never expose its diagnostics.
      const diagnostic = diagnosticTail + data.toString('utf8');
      if (diagnostic.includes('filtering not recognized by server, ignoring')) {
        stop('Hosted PR acquisition requires server support for object filtering.');
      }
      diagnosticTail = diagnostic.slice(-128);
    });
    const timer = setTimeout(() => stop('Hosted PR acquisition exceeded its time bound.'), deadline - Date.now());
    const monitor = setInterval(() => {
      if (storageCheck) return;
      storageCheck = repositoryBytes(cwd).then(bytes => {
        if (bytes > HOSTED_GIT_STORAGE_BYTES) stop('Hosted PR acquisition exceeded its object storage bound.');
      }, () => stop('Hosted PR acquisition could not verify its object storage bound.')).finally(() => { storageCheck = undefined; });
    }, 100);
    child.once('error', () => { failure ??= 'Hosted PR Git process could not start.'; });
    child.once('close', (code) => {
      closed = true;
      clearTimeout(timer); clearInterval(monitor);
      void (async () => {
        await storageCheck;
        // Also check quick commands which completed between monitor ticks.
        if (await repositoryBytes(cwd) > HOSTED_GIT_STORAGE_BYTES) failure ??= 'Hosted PR acquisition exceeded its object storage bound.';
        if (failure || code !== 0) reject(new Error(failure ?? 'Hosted PR Git acquisition failed.'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      })().catch(() => reject(new Error('Hosted PR acquisition could not verify its object storage bound.')));
    });
  });
}
