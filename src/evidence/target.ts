import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isGitHubTarget, parseGitHubTarget } from '../resolver/github.js';

/**
 * Which pull request `rcl evidence status` asks about: `owner/repo#N` or a
 * pull request URL stand alone; a bare `N` or `#N` is read against the
 * repository the current checkout's `origin` remote points at.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequestRef extends RepoRef {
  number: number;
}

const execFileAsync = promisify(execFile);

// Anchored: the whole remote must be a GitHub repository in the scp-like,
// ssh, https or git form, with or without a `.git` suffix or trailing slash.
const REMOTE_PATTERNS = [
  /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  /^(?:https?|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
];

/** The GitHub repository a remote URL names, or `null` for anything else. */
export function parseRemoteUrl(url: string): RepoRef | null {
  const trimmed = url.trim();
  for (const pattern of REMOTE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return { owner: match[1]!, repo: match[2]! };
  }
  return null;
}

/** The repository `origin` points at, or `null` outside a checkout with a GitHub remote. Never throws. */
export async function resolveRemoteRepo(cwd = process.cwd()): Promise<RepoRef | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    return parseRemoteUrl(stdout);
  } catch {
    return null;
  }
}

/** Whether an argument is a bare number or `#N`, which needs the remote to become a pull request. */
export function needsRemote(arg: string): boolean {
  return /^#?\d+$/.test(arg.trim());
}

export function parsePullRequestArg(arg: string, remote: RepoRef | null): PullRequestRef {
  const trimmed = arg.trim();
  if (isGitHubTarget(trimmed)) {
    const target = parseGitHubTarget(trimmed);
    return { owner: target.owner, repo: target.repo, number: target.number };
  }
  const numeric = trimmed.match(/^#?(\d+)$/);
  if (numeric) {
    const number = Number(numeric[1]);
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new Error(`The pull request number must be positive: "${trimmed}".`);
    }
    if (remote === null) {
      throw new Error(
        `No GitHub remote to read pull request ${number} against — name it as owner/repo#${number} or as its URL.`
      );
    }
    return { ...remote, number };
  }
  throw new Error(`Cannot read a pull request from "${trimmed}": use N, #N, owner/repo#N or a pull request URL.`);
}
