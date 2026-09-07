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

/**
 * GitHub's compare endpoint returns the changed files only in its first
 * response and caps them at 300 (paging applies to commits, not files).
 */
const COMPARE_FILE_CAP = 300;

type ChangedFile = NonNullable<
  RestEndpointMethodTypes['repos']['compareCommitsWithBasehead']['response']['data']['files']
>[number];
type PullRequest = RestEndpointMethodTypes['pulls']['get']['response']['data'];

/**
 * The PR's changed files, bound to the SHAs the PR response named.
 *
 * Preferred path: `GET /compare/{base}...{head}` — the same merge-base
 * comparison a PR shows, addressed by immutable object ids, so nothing that
 * happens to the PR after `pulls.get` can change what comes back. GitHub
 * includes at most 300 files in that response, so it is authoritative only
 * below the cap.
 *
 * Large PRs fall back to the PR-number-addressed listing (paged to 3,000
 * files), bracketed by PR reads: if the head or base moved while the pages
 * were fetched, the report is not bound. A move-and-move-back inside that
 * window is not detectable here; every PR up to the compare cap takes the
 * pinned path and has no such window.
 */
async function fetchChangedFiles(
  octokit: Octokit,
  target: GitHubTarget,
  pr: PullRequest
): Promise<ChangedFile[]> {
  if (pr.changed_files <= COMPARE_FILE_CAP) {
    const { data } = await octokit.repos.compareCommitsWithBasehead({
      owner: target.owner,
      repo: target.repo,
      basehead: `${pr.base.sha}...${pr.head.sha}`,
    });
    const files = data.files ?? [];
    // Exactly at the cap the list may be truncated; only a shorter list is
    // known to be complete.
    if (files.length < COMPARE_FILE_CAP) return files;
  }

  const listed: ChangedFile[] = await octokit.paginate(octokit.pulls.listFiles, {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.number,
    per_page: 100,
  });
  const recheck = (
    await octokit.pulls.get({ owner: target.owner, repo: target.repo, pull_number: target.number })
  ).data;
  if (recheck.head.sha !== pr.head.sha || recheck.base.sha !== pr.base.sha) {
    throw new Error(
      `PR #${target.number} moved (${pr.base.sha}...${pr.head.sha} → ${recheck.base.sha}...${recheck.head.sha}) while its ${listed.length} files were being listed — rerun the review.`
    );
  }
  return listed;
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

  // Exact-head binding: the files come from a compare pinned to the base and
  // head object ids this very response named (see fetchChangedFiles for the
  // large-PR fallback and its bracket), so the patches belong to `head_sha`.
  const files = await fetchChangedFiles(octokit, target, pr);

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
