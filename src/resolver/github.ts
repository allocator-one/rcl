import { Octokit, type RestEndpointMethodTypes } from '@octokit/rest';
import { detectLanguage } from '../prepare/language.js';
import type { Diff, FileChange, PRMetadata } from './types.js';

export interface GitHubTarget {
  owner: string;
  repo: string;
  number: number;
}

// Anchored: the whole target must be a PR URL (any scheme, optional www,
// optional sub-page such as /files, optional query or fragment) or the short
// owner/repo#N form with single-segment owner and repo. A local path that
// merely contains "github.com/…/pull/N" or ends in "#2" is not a PR.
const PR_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com(?::\d+)?\/([^/\s#?]+)\/([^/\s#?]+)\/pull\/(\d+)(?:\/[^\s?#]*)?(?:[?#].*)?$/i;
const PR_SHORT = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/;

/**
 * Whether a positional target names a GitHub PR (`owner/repo#N` or a PR
 * URL). Everything else a caller passes is a local patch file — by shape,
 * not by extension, so `fix.DIFF`, `patches/fix` and `changes.txt` all route
 * to the patch loader instead of failing as an "invalid GitHub target".
 */
export function isGitHubTarget(target: string): boolean {
  return PR_URL.test(target) || PR_SHORT.test(target);
}

export function parseGitHubTarget(target: string): GitHubTarget {
  // Supports: owner/repo#123 or https://github.com/owner/repo/pull/123
  const prUrlMatch = target.match(PR_URL);
  if (prUrlMatch) {
    return {
      owner: prUrlMatch[1]!,
      repo: prUrlMatch[2]!,
      number: parseInt(prUrlMatch[3]!, 10),
    };
  }

  const shortMatch = target.match(PR_SHORT);
  if (shortMatch) {
    return {
      owner: shortMatch[1]!,
      repo: shortMatch[2]!,
      number: parseInt(shortMatch[3]!, 10),
    };
  }

  throw new Error(
    `Invalid GitHub target: "${target}". Use owner/repo#123 or a GitHub PR URL.`
  );
}

/** Files per compare page; GitHub caps the parameter at 100. */
const COMPARE_PAGE_SIZE = 100;
/** A PR lists at most 3,000 changed files; more pages than that is a loop bug. */
const MAX_COMPARE_PAGES = 30;

type ComparedFile = NonNullable<
  RestEndpointMethodTypes['repos']['compareCommitsWithBasehead']['response']['data']['files']
>[number];

/**
 * The changed files between two immutable object ids, via
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}` — the same merge-base
 * comparison a PR shows, but addressed by SHA rather than by PR number, so
 * the result cannot change underneath the caller while it paginates.
 */
async function fetchComparedFiles(
  octokit: Octokit,
  target: GitHubTarget,
  baseSha: string,
  headSha: string
): Promise<ComparedFile[]> {
  const files: ComparedFile[] = [];
  for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
    const { data } = await octokit.repos.compareCommitsWithBasehead({
      owner: target.owner,
      repo: target.repo,
      basehead: `${baseSha}...${headSha}`,
      per_page: COMPARE_PAGE_SIZE,
      page,
    });
    const batch = data.files ?? [];
    files.push(...batch);
    if (batch.length < COMPARE_PAGE_SIZE) return files;
  }
  throw new Error(
    `PR #${target.number} changes more than ${MAX_COMPARE_PAGES * COMPARE_PAGE_SIZE} files — too large to review in one council pass.`
  );
}

export async function fetchPRDiff(
  target: GitHubTarget,
  token?: string,
  octokitClient?: Octokit
): Promise<Diff> {
  const octokit =
    octokitClient ??
    new Octokit({
      auth: token ?? process.env['GITHUB_TOKEN'],
    });

  const pr = (
    await octokit.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    })
  ).data;

  // Exact-head binding: the changed files are fetched by a compare pinned to
  // the base and head object ids this very response named, so the patches
  // provably belong to `head_sha`. A push, a base advance, or an A→B→A move
  // during pagination cannot mix revisions into the listing — object ids are
  // immutable, unlike the PR-number-addressed files endpoint.
  const files = await fetchComparedFiles(octokit, target, pr.base.sha, pr.head.sha);

  const metadata: PRMetadata = {
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user?.login ?? 'unknown',
    base: pr.base.ref,
    head: pr.head.ref,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    ...(pr.merge_commit_sha ? { mergeCommitSha: pr.merge_commit_sha } : {}),
    url: pr.html_url,
    labels: pr.labels.map((l) => l.name),
    draft: pr.draft ?? false,
  };

  const fileChanges: FileChange[] = files.map((f) => ({
    filename: f.filename,
    status: f.status as FileChange['status'],
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch ?? '',
    language: detectLanguage(f.filename),
    previousFilename: f.previous_filename,
  }));

  return {
    files: fileChanges,
    metadata,
    source: 'github',
  };
}
