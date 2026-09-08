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
  const attributed = pullRequestFor(opts);
  // Evidence for a pull request binds to a commit: an attributed patch without
  // its head could be any bytes presented against that pull request's gate.
  // The explicit flag is refused without one; a converge target only
  // attributes when the head is there, since it is a bookkeeping key first.
  if (attributed && opts.headSha === undefined && attributed.source === '--for-pr') {
    throw new Error('A patch review bound to a pull request by --for-pr needs --head-sha: evidence binds to the commit it reviewed.');
  }
  const pr = attributed && opts.headSha !== undefined ? attributed : undefined;
  return {
    kind: 'patch',
    ...(pr ? { repo: `${pr.owner}/${pr.repo}`, prNumber: pr.number, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}` } : {}),
    ...(opts.headSha !== undefined ? { headSha: validateSha(opts.headSha, '--head-sha') } : {}),
    ...(opts.baseSha !== undefined ? { baseSha: validateSha(opts.baseSha, '--base-sha') } : {}),
  };
}

interface Attribution {
  owner: string;
  repo: string;
  number: number;
  source: '--for-pr' | '--converge-target';
}

/**
 * The pull request a patch review stands for: `--for-pr` when given (an
 * invalid value is an error), else a converge target that parses cleanly as
 * `owner/repo#N` (anything else — a slug such as `rcl-7`, a malformed
 * reference — is a bookkeeping key and attributes nothing).
 */
function pullRequestFor(opts: TargetOverrides): Attribution | undefined {
  if (opts.forPr !== undefined) {
    const text = opts.forPr.trim();
    if (!isGitHubTarget(text)) throw new Error(`--for-pr must name a pull request as owner/repo#N or a pull request URL, got "${text}".`);
    const pr = checked(parseGitHubTarget(text));
    if (!pr) throw new Error('--for-pr does not name a GitHub pull request.');
    return { ...pr, source: '--for-pr' };
  }
  if (opts.convergeTarget !== undefined && isGitHubTarget(opts.convergeTarget.trim())) {
    const pr = checked(parseGitHubTarget(opts.convergeTarget.trim()));
    return pr ? { ...pr, source: '--converge-target' } : undefined;
  }
  return undefined;
}

/** GitHub's segment rules for both names and a positive number, lower-cased (one spelling, one key on the server); `null` otherwise. */
function checked(pr: { owner: string; repo: string; number: number }): { owner: string; repo: string; number: number } | null {
  if (parseRepoName(`${pr.owner}/${pr.repo}`) === null || !Number.isSafeInteger(pr.number) || pr.number <= 0) return null;
  return { owner: pr.owner.toLowerCase(), repo: pr.repo.toLowerCase(), number: pr.number };
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
