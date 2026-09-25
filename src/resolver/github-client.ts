import { execFile } from 'node:child_process';
import { Octokit } from '@octokit/rest';
import type { GitHubTarget } from './github.js';

export async function createGitHubClient(token?: string): Promise<Octokit> {
  const configuredToken = token?.trim() || process.env['GITHUB_TOKEN']?.trim();
  const auth = configuredToken || await new Promise<string | undefined>((resolve) => {
    execFile(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 16384 },
      (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)
    );
  });
  return new Octokit({ auth });
}

export async function getGitHubPullRequest(client: Octokit, target: GitHubTarget) {
  try {
    return await client.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.number,
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
      throw new Error(
        'PR fetch returned 404 — the pull request may not exist or access may be missing. ' +
        'For private repos, verify access with gh auth status --hostname github.com, ' +
        'or set GITHUB_TOKEN or githubToken in config.'
      );
    }
    throw error;
  }
}
