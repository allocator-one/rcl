import type { Diff } from './types.js';
import type { GitHeads } from './git.js';
import { resolveGitHeads } from './git.js';
import { validateSha, type RunHeaderInput } from '../report/run-header.js';

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
}

export async function resolveReviewTarget(
  diff: Diff,
  gitMode: GitDiffMode | undefined,
  opts: TargetOverrides,
  deps: { gitHeads?: GitHeads; resolveGitHeads?: () => Promise<GitHeads> } = {}
): Promise<ReviewTarget> {
  const overrideGiven = opts.headSha !== undefined || opts.baseSha !== undefined;
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
  return {
    kind: 'patch',
    ...(opts.headSha !== undefined ? { headSha: validateSha(opts.headSha, '--head-sha') } : {}),
    ...(opts.baseSha !== undefined ? { baseSha: validateSha(opts.baseSha, '--base-sha') } : {}),
  };
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
