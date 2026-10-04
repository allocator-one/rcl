import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import { detectLanguage } from '../prepare/language.js';
import type { Diff, FileChange, PRMetadata } from './types.js';
import { createGitHubClient, getGitHubPullRequest } from './github-client.js';
import { loadHostedPinnedGitDiff, loadPinnedGitDiff, PinnedGitObjectsUnavailableError } from './git.js';
import { parseUnifiedDiff } from '../prepare/unified-diff.js';

export interface GitHubTarget {
  owner: string;
  repo: string;
  number: number;
}

/** A GitHub repository by owner and name. */
export interface RepoRef {
  owner: string;
  repo: string;
}

// GitHub's segment rules: an owner is alphanumerics and single hyphens (no
// leading or trailing hyphen); a repository is alphanumerics, `-`, `_` and
// `.`, never `.` or `..` — so neither can carry a control character, a path
// separator or a dot-segment into a request path.
export const GITHUB_OWNER_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*';
export const GITHUB_REPO_PATTERN = '[A-Za-z0-9_.-]+';
const OWNER_RE = new RegExp(`^${GITHUB_OWNER_PATTERN}$`);
const REPO_RE = new RegExp(`^${GITHUB_REPO_PATTERN}$`);

/** The pair as a repository, or `null` when GitHub would not accept either segment. */
export function legalRepo(owner: string, repo: string): RepoRef | null {
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** An `owner/repo` argument as a repository, or `null` when it is not one GitHub would accept. */
export function parseRepoName(text: string): RepoRef | null {
  const parts = text.trim().split('/');
  if (parts.length !== 2) return null;
  return legalRepo(parts[0]!, parts[1]!);
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
  pr: PullRequest,
  requireMergeBase: boolean
): Promise<{ files: ChangedFile[]; mergeBaseSha?: string }> {
  let mergeBaseSha: string | undefined;
  if (requireMergeBase && (![pr.base.sha, pr.head.sha].every(sha => /^[a-f0-9]{40}$/.test(sha)))) {
    throw new Error("A retained PR needs exact commits to resolve its effective merge base.");
  }
  if (requireMergeBase || pr.changed_files <= COMPARE_FILE_CAP) {
    let files: ChangedFile[] | undefined;
    try {
      const { data } = await octokit.repos.compareCommitsWithBasehead({
        owner: target.owner,
        repo: target.repo,
        basehead: `${pr.base.sha}...${pr.head.sha}`,
      });
      files = data.files ?? [];
      mergeBaseSha = data.merge_base_commit?.sha;
    } catch {
      // A compare the API refuses (e.g. an object id it cannot resolve for
      // this repository) must not fail the review: the bracketed listing
      // below still binds the files, just less tightly.
      files = undefined;
    }
    // Complete only when it accounts for every file the PR reports; anything
    // else (the 300 cap, or an API nuance) falls through to the listing.
    if (requireMergeBase && (typeof mergeBaseSha !== "string" || !/^[a-f0-9]{40}$/.test(mergeBaseSha))) {
      throw new Error("The exact PR comparison did not provide a valid effective merge base.");
    }
    if (files !== undefined && files.length === pr.changed_files) return { files, ...(requireMergeBase ? { mergeBaseSha } : {}) };
  }

  const listed: ChangedFile[] = await octokit.paginate(octokit.pulls.listFiles, {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.number,
    per_page: 100,
  });
  const recheck = (await getGitHubPullRequest(octokit, target)).data;
  if (recheck.head.sha !== pr.head.sha || recheck.base.sha !== pr.base.sha) {
    throw new Error(
      `PR #${target.number} moved (${pr.base.sha}...${pr.head.sha} → ${recheck.base.sha}...${recheck.head.sha}) while its ${listed.length} files were being listed — rerun the review.`
    );
  }
  // GitHub lists at most 3,000 files; a shorter list than the PR reports is
  // an incomplete diff, and an incomplete diff must never read as reviewed.
  if (listed.length !== recheck.changed_files) {
    throw new Error(
      `PR #${target.number} reports ${recheck.changed_files} changed files but the API listed ${listed.length} — the diff is incomplete (GitHub lists at most 3,000 files), refusing to review it as if it were whole.`
    );
  }
  return { files: listed, ...(requireMergeBase ? { mergeBaseSha } : {}) };
}

export async function fetchPRDiff(
  target: GitHubTarget,
  token?: string,
  octokitClient?: Octokit,
  options: { requireMergeBase?: boolean; maxDiffBytes?: number; cwd?: string } = {}
): Promise<Diff> {
  const octokit = octokitClient ?? await createGitHubClient(token);
  const pr = (await getGitHubPullRequest(octokit, target)).data;

  // Exact-head binding: the files come from a compare pinned to the base and
  // head object ids this very response named (see fetchChangedFiles for the
  // large-PR fallback and its bracket), so the patches belong to `head_sha`.
  let files: ChangedFile[] = [];
  let mergeBaseSha: string | undefined;
  if (options.maxDiffBytes === undefined) {
    ({ files, mergeBaseSha } = await fetchChangedFiles(octokit, target, pr, options.requireMergeBase === true));
  } else {
    // Only this immutable comparison may supply ancestry for a depth-one
    // hosted object database; the paginated file list cannot establish it.
    if (![pr.base.sha, pr.head.sha].every(sha => /^[a-f0-9]{40}$/.test(sha))) {
      throw new Error('A complete PR patch requires exact GitHub comparison commits.');
    }
    const comparison = await octokit.repos.compareCommitsWithBasehead({
      owner: target.owner, repo: target.repo, basehead: `${pr.base.sha}...${pr.head.sha}`,
    });
    mergeBaseSha = comparison.data.merge_base_commit?.sha;
    if (typeof mergeBaseSha !== 'string' || !/^[a-f0-9]{40}$/.test(mergeBaseSha)) {
      throw new Error('The exact PR comparison did not provide a valid effective merge base.');
    }
  }
  // GitHub can omit a changed text file's patch AND report zero changes while
  // still listing the file. A blob digest binds that omission, not its review.
  // Explicit full-patch capacity therefore always requires pinned Git objects;
  // ordinary remote targets may use only structurally complete API patches.
  let authoritative: Awaited<ReturnType<typeof loadPinnedGitDiff>> | undefined;
  if (options.maxDiffBytes !== undefined || files.some(file => !completeApiPatch(file))) {
    try {
      const pinned = { owner: target.owner, repo: target.repo,
        baseSha: pr.base.sha, headSha: pr.head.sha,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(mergeBaseSha === undefined ? {} : { expectedMergeBaseSha: mergeBaseSha }),
        ...(options.maxDiffBytes === undefined ? {} : { maxBytes: options.maxDiffBytes }) };
      try {
        authoritative = await loadPinnedGitDiff(pinned);
      } catch (error) {
        // A malformed/oversized/binary patch or an ancestry mismatch remains a
        // refusal. Hosted retrieval only repairs missing local object storage.
        if (!(error instanceof PinnedGitObjectsUnavailableError) || options.maxDiffBytes === undefined || !mergeBaseSha) throw error;
        const hostedToken = token?.trim() || process.env['GITHUB_TOKEN']?.trim();
        if (!hostedToken) throw new Error('Hosted PR object acquisition needs GITHUB_TOKEN or githubToken.');
        authoritative = await loadHostedPinnedGitDiff({ ...pinned, expectedMergeBaseSha: mergeBaseSha, token: hostedToken });
      }
    } catch (error) {
      throw new Error(`Cannot acquire a complete PR patch: ${error instanceof Error ? error.message : String(error)}`);
    }
    const recheck = (await getGitHubPullRequest(octokit, target)).data;
    if (recheck.head.sha !== pr.head.sha || recheck.base.sha !== pr.base.sha) {
      throw new Error(`PR #${target.number} moved while its pinned diff was read — rerun the review.`);
    }
    if (authoritative.files.length !== pr.changed_files || recheck.changed_files !== pr.changed_files) {
      throw new Error(`Pinned PR patch is incomplete: expected ${pr.changed_files} files, read ${authoritative.files.length}.`);
    }
    if (mergeBaseSha !== undefined && mergeBaseSha !== authoritative.mergeBaseSha) {
      throw new Error('Pinned PR merge base disagrees with the exact GitHub comparison.');
    }
    mergeBaseSha = authoritative.mergeBaseSha;
  }

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
    ...(mergeBaseSha ? { mergeBaseSha } : {}),
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
    ...(f.sha ? { blobSha: f.sha } : {}),
  }));

  return {
    files: authoritative?.files ?? fileChanges,
    metadata,
    source: 'github',
    ...(authoritative?.rawDiff === undefined ? {} : { rawDiff: authoritative.rawDiff }),
  };
}

function completeApiPatch(file: ChangedFile): boolean {
  if (typeof file.patch !== 'string' || file.patch.length === 0 || !parseUnifiedDiff(file.patch).ok) return false;
  let additions = 0, deletions = 0;
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('+')) additions++;
    if (line.startsWith('-')) deletions++;
  }
  return additions === file.additions && deletions === file.deletions;
}
