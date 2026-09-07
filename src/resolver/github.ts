import { Octokit } from '@octokit/rest';
import { detectLanguage } from '../prepare/language.js';
import type { Diff, FileChange, PRMetadata } from './types.js';

export interface GitHubTarget {
  owner: string;
  repo: string;
  number: number;
}

export function parseGitHubTarget(target: string): GitHubTarget {
  // Supports: owner/repo#123 or https://github.com/owner/repo/pull/123
  const prUrlMatch = target.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  );
  if (prUrlMatch) {
    return {
      owner: prUrlMatch[1]!,
      repo: prUrlMatch[2]!,
      number: parseInt(prUrlMatch[3]!, 10),
    };
  }

  const shortMatch = target.match(/^([^/]+)\/([^#]+)#(\d+)$/);
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

  const [prResponse, files] = await Promise.all([
    octokit.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    }),
    // paginate: PRs can exceed 100 changed files; a single page would
    // silently drop the rest of the diff.
    octokit.paginate(octokit.pulls.listFiles, {
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
      per_page: 100,
    }),
  ]);

  const pr = prResponse.data;

  // Exact-head binding: the file listing is a separate request, so a push
  // (or a base-branch advance, which changes the comparison) landing between
  // the two would pair one pair of SHAs with another comparison's patches.
  // Both requests above have settled here; re-read the PR and refuse to bind
  // if either end moved.
  const recheck = await octokit.pulls.get({
    owner: target.owner,
    repo: target.repo,
    pull_number: target.number,
  });
  if (recheck.data.head.sha !== pr.head.sha) {
    throw new Error(
      `PR #${target.number} head moved from ${pr.head.sha} to ${recheck.data.head.sha} while its files were being fetched — rerun the review.`
    );
  }
  if (recheck.data.base.sha !== pr.base.sha) {
    throw new Error(
      `PR #${target.number} base moved from ${pr.base.sha} to ${recheck.data.base.sha} while its files were being fetched — rerun the review.`
    );
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
