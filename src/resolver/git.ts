import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseDiffFromString } from './local.js';
import type { Diff } from './types.js';

const execFileAsync = promisify(execFile);

// Diffs larger than this are unreviewable by the council anyway; failing
// loudly beats silently truncating what the models see.
const MAX_DIFF_BYTES = 10 * 1024 * 1024;

export type GitDiffMode = 'staged' | 'working-tree';

const MODE_ARGS: Record<GitDiffMode, string[]> = {
  // Staged changes only (what `git commit` would pick up right now).
  staged: ['diff', '--cached'],
  // Everything uncommitted relative to HEAD: staged + unstaged. Untracked
  // files are invisible to `git diff` and therefore not reviewed.
  'working-tree': ['diff', 'HEAD'],
};

async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      // quotepath off so non-ASCII filenames survive parseDiffText's header
      // match; ext-diff off so a configured external diff tool can't replace
      // the unified format the parser expects.
      ['-c', 'core.quotepath=false', ...args, '--no-color', '--no-ext-diff'],
      { cwd, maxBuffer: MAX_DIFF_BYTES }
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

export async function loadGitDiff(mode: GitDiffMode, cwd = process.cwd()): Promise<Diff> {
  // Fail with a clear message when we're not in a git repository (or git is
  // missing) before attempting the actual diff.
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd });
  } catch {
    throw new Error(`--${mode} requires running inside a git repository`);
  }

  const diffText = await runGit(MODE_ARGS[mode], cwd);
  return { ...parseDiffFromString(diffText), source: 'local' };
}
