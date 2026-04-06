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
  token?: string
): Promise<Diff> {
  const octokit = new Octokit({
    auth: token ?? process.env['GITHUB_TOKEN'],
  });

  const [prResponse, filesResponse] = await Promise.all([
    octokit.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    }),
    octokit.pulls.listFiles({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
      per_page: 100,
    }),
  ]);

  const pr = prResponse.data;
  const files = filesResponse.data;

  const metadata: PRMetadata = {
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    title: pr.title,
    body: pr.body ?? '',
    author: pr.user?.login ?? 'unknown',
    base: pr.base.ref,
    head: pr.head.ref,
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
