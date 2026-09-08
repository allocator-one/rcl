import type { Diff } from './types.js';
import type { GitHeads } from './git.js';
import { resolveGitHeads } from './git.js';
import { validateSha, type RunHeaderInput } from '../report/run-header.js';
import { isGitHubTarget, parseGitHubTarget } from './github.js';
import { parseRepoName } from '../evidence/target.js';

/**
 * Exact-head binding (IO-12475 section 8.1): which commit a diff belongs
 * to. PR mode takes the SHAs GitHub returned with the PR; git modes use the
 * HEAD the caller resolved around the diff read (see `runReview`); a patch
 * file carries only its digest unless the caller vouches for its head with
 * --head-sha — the file could have come from anywhere, so rcl never guesses
 * from the working directory.
 */

export type ReviewTarget = RunHeaderInput['target'];
export type GitDiffMode = 'staged' | 'working-tree';

export interface TargetOverrides {
  headSha?: string;
  baseSha?: string;
  /**
   * The pull request a patch-file review is evidence for (`owner/repo#N` or a
   * pull request URL), so Harness can verify its head and count the run for
   * that pull request's gate (RCL-39). A converge target of the same form
   * attributes the run the same way.
   */
  forPr?: string;
  convergeTarget?: string;
}

export async function resolveReviewTarget(
  diff: Diff,
  gitMode: GitDiffMode | undefined,
  opts: TargetOverrides,
  deps: { gitHeads?: GitHeads; resolveGitHeads?: () => Promise<GitHeads> } = {}
): Promise<ReviewTarget> {
  const overrideGiven = opts.headSha !== undefined || opts.baseSha !== undefined;
  // `--for-pr` names the pull request a patch file stands for; a PR target
  // names its own, and a git mode reviews a checkout, not a pull request.
  if (opts.forPr !== undefined && (diff.metadata || gitMode)) {
    throw new Error('--for-pr applies to patch files only; a PR target names its pull request itself and a git mode reviews the checkout.');
  }
  if (diff.metadata) {
    if (overrideGiven) {
      throw new Error(
        '--head-sha and --base-sha apply to patch files only; a PR target resolves its heads from GitHub.'
      );
    }
    const m = diff.metadata;
    return {
      kind: 'pr',
      repo: `${m.owner}/${m.repo}`,
      prNumber: m.number,
      url: m.url,
      headSha: m.headSha,
      baseSha: m.baseSha,
      headRef: m.head,
      baseRef: m.base,
    };
  }
  if (gitMode) {
    if (overrideGiven) {
      throw new Error(
        `--head-sha and --base-sha apply to patch files only; --${gitMode} resolves HEAD itself.`
      );
    }
    const heads = deps.gitHeads ?? (await (deps.resolveGitHeads ?? resolveGitHeads)());
    return { kind: gitMode === 'staged' ? 'staged' : 'working_tree', ...heads };
  }
  const pr = pullRequestFor(opts);
  return {
    kind: 'patch',
    ...(pr ? { repo: `${pr.owner}/${pr.repo}`, prNumber: pr.number, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` } : {}),
    ...(opts.headSha !== undefined ? { headSha: validateSha(opts.headSha, '--head-sha') } : {}),
    ...(opts.baseSha !== undefined ? { baseSha: validateSha(opts.baseSha, '--base-sha') } : {}),
  };
}

/**
 * The pull request a patch review stands for: `--for-pr` when given, else a
 * converge target that has the `owner/repo#N` form (a converge slug such as
 * `rcl-7` names nothing and attributes nothing).
 */
function pullRequestFor(opts: TargetOverrides): { owner: string; repo: string; number: number } | undefined {
  if (opts.forPr !== undefined) {
    const text = opts.forPr.trim();
    if (!isGitHubTarget(text)) throw new Error(`--for-pr must name a pull request as owner/repo#N or a pull request URL, got "${text}".`);
    return checked(parseGitHubTarget(text), '--for-pr');
  }
  if (opts.convergeTarget !== undefined && isGitHubTarget(opts.convergeTarget.trim())) {
    return checked(parseGitHubTarget(opts.convergeTarget.trim()), '--converge-target');
  }
  return undefined;
}

// GitHub's segment rules (owner: alphanumerics and single hyphens; repository:
// alphanumerics, `-`, `_`, `.`, never `.` or `..`) for both segments, and a
// positive number — the values reach a URL and a request path.
function checked(pr: { owner: string; repo: string; number: number }, flag: string): { owner: string; repo: string; number: number } {
  if (parseRepoName(`${pr.owner}/${pr.repo}`) === null || !Number.isSafeInteger(pr.number) || pr.number <= 0) {
    throw new Error(`${flag} does not name a GitHub pull request.`);
  }
  return pr;
}

/**
 * `--expect-head-sha`: refuse to review a target whose head is not the one
 * the caller expects. The message names the way out for each target kind —
 * a patch file can be vouched for with --head-sha, a git mode cannot.
 */
export function assertExpectedHead(target: ReviewTarget, expected: string): void {
  const sha = validateSha(expected, '--expect-head-sha');
  if (target.headSha === undefined) {
    // A PR target always carries its head (PRMetadata requires it); only a
    // patch file or a git mode outside a repository can lack one.
    const hint =
      target.kind === 'patch'
        ? 'pass --head-sha with the patch file'
        : 'HEAD could not be resolved (not a git repository, or an unborn branch)';
    throw new Error(
      `--expect-head-sha was given but this ${describeKind(target.kind)} has no head SHA: ${hint}.`
    );
  }
  if (target.headSha !== sha) {
    throw new Error(
      `Resolved head ${target.headSha} does not match --expect-head-sha ${sha}; the target has moved — refusing to review.`
    );
  }
}

function describeKind(kind: ReviewTarget['kind']): string {
  switch (kind) {
    case 'pr':
      return 'PR';
    case 'patch':
      return 'patch file';
    case 'working_tree':
      return 'working-tree diff';
    case 'staged':
      return 'staged diff';
    case 'plan':
      return 'plan';
  }
}
