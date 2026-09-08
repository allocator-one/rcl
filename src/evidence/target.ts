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

// GitHub's segment rules: an owner is alphanumerics and single hyphens (no
// leading or trailing hyphen); a repository is alphanumerics, `-`, `_` and
// `.`, never `.` or `..` — so neither can carry a control character, a path
// separator or a dot-segment into a request path.
const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*';
const REPO = '[A-Za-z0-9_.-]+';
const OWNER_RE = new RegExp(`^${OWNER}$`);
const REPO_RE = new RegExp(`^${REPO}$`);
// The scp-like form has no scheme to hand to `URL`; the repository is matched
// lazily (`+?`) so an optional `.git` suffix is not swallowed into the name.
const SCP_REMOTE = new RegExp(`^git@github\\.com:(${OWNER})/(${REPO}?)(?:\\.git)?/?$`, 'i');
const REPO_PATH = new RegExp(`^/(${OWNER})/(${REPO}?)(?:\\.git)?/?$`, 'i');

function legalRepo(owner: string, repo: string): RepoRef | null {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** An `owner/repo` argument as a repository, or `null` when it is not one GitHub would accept. */
export function parseRepoName(text: string): RepoRef | null {
  const parts = text.trim().split('/');
  if (parts.length !== 2) return null;
  return legalRepo(parts[0]!, parts[1]!);
}

/** The GitHub repository a remote URL names, or `null` for anything else. */
export function parseRemoteUrl(url: string): RepoRef | null {
  const trimmed = url.trim();
  const scp = trimmed.match(SCP_REMOTE);
  if (scp) return legalRepo(scp[1]!, scp[2]!);
  // Scheme forms (ssh, https, git) go through `URL`, so user-info (a token,
  // `user:password`) and a port never take part in the match.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!/^(?:ssh|https?|git):$/i.test(parsed.protocol) || (host !== 'github.com' && host !== 'www.github.com')) return null;
  const path = parsed.pathname.match(REPO_PATH);
  return path ? legalRepo(path[1]!, path[2]!) : null;
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
    // The GitHub parser is shared with `rcl review`; the read side re-checks
    // what it hands back so no other target shape passes as a pull request.
    if (legalRepo(target.owner, target.repo) === null) {
      throw new Error('The repository in the pull request target is not a GitHub owner/repository name.');
    }
    if (!Number.isSafeInteger(target.number) || target.number <= 0) {
      throw new Error(`Cannot read a pull request number from "${trimmed}": use N, #N, owner/repo#N or a pull request URL.`);
    }
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
