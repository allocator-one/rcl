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
