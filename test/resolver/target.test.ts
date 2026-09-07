import { describe, it, expect } from 'vitest';
import { assertExpectedHead, resolveReviewTarget } from '../../src/resolver/target.js';
import type { Diff } from '../../src/resolver/types.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);

function prDiff(over: Partial<NonNullable<Diff['metadata']>> = {}): Diff {
  return {
    source: 'github',
    files: [],
    metadata: {
      owner: 'allocator-one',
      repo: 'rcl',
      number: 42,
      title: 't',
      body: '',
      author: 'x',
      base: 'main',
      head: 'feature',
      headSha: HEAD,
      baseSha: BASE,
      url: 'https://github.com/allocator-one/rcl/pull/42',
      labels: [],
      draft: false,
      ...over,
    },
  };
}

const localDiff: Diff = { source: 'local', files: [] };

describe('resolveReviewTarget', () => {
  it('binds a PR to the head and base SHAs GitHub returned', async () => {
    const target = await resolveReviewTarget(prDiff(), undefined, {});
    expect(target).toEqual({
      kind: 'pr',
      repo: 'allocator-one/rcl',
      prNumber: 42,
      url: 'https://github.com/allocator-one/rcl/pull/42',
      headSha: HEAD,
      baseSha: BASE,
      headRef: 'feature',
      baseRef: 'main',
    });
  });

  it('uses the HEAD the caller resolved around the diff read for git modes, never a fresh read', async () => {
    let fresh = 0;
    const target = await resolveReviewTarget(localDiff, 'staged', {}, {
      gitHeads: { headSha: HEAD, baseSha: BASE },
      resolveGitHeads: async () => {
        fresh++;
        return { headSha: OTHER };
      },
    });
    expect(target).toEqual({ kind: 'staged', headSha: HEAD, baseSha: BASE });
    expect(fresh).toBe(0);
  });

  it('maps --working-tree to the working_tree kind', async () => {
    const target = await resolveReviewTarget(localDiff, 'working-tree', {}, { gitHeads: { headSha: HEAD } });
    expect(target).toEqual({ kind: 'working_tree', headSha: HEAD });
  });

  it('accepts --head-sha / --base-sha only for patch files', async () => {
    await expect(resolveReviewTarget(prDiff(), undefined, { headSha: HEAD })).rejects.toThrow(/patch files only/);
    await expect(
      resolveReviewTarget(localDiff, 'staged', { baseSha: BASE }, { gitHeads: { headSha: HEAD } })
    ).rejects.toThrow(/patch files only/);
    expect(await resolveReviewTarget(localDiff, undefined, { headSha: HEAD.toUpperCase(), baseSha: BASE })).toEqual({
      kind: 'patch',
      headSha: HEAD,
      baseSha: BASE,
    });
    expect(await resolveReviewTarget(localDiff, undefined, {})).toEqual({ kind: 'patch' });
  });
});

describe('assertExpectedHead', () => {
  it('passes when the PR head equals the expectation and fails fast when the PR has moved', async () => {
    const target = await resolveReviewTarget(prDiff(), undefined, {});
    expect(() => assertExpectedHead(target, HEAD)).not.toThrow();
    expect(() => assertExpectedHead(target, OTHER)).toThrow(/does not match --expect-head-sha/);
  });

  it('names the way out per target kind when no head is known', async () => {
    const patch = await resolveReviewTarget(localDiff, undefined, {});
    expect(() => assertExpectedHead(patch, HEAD)).toThrow(/pass --head-sha/);
    const staged = await resolveReviewTarget(localDiff, 'staged', {}, { gitHeads: {} });
    expect(() => assertExpectedHead(staged, HEAD)).toThrow(/HEAD could not be resolved/);
    const pr = await resolveReviewTarget(prDiff({ headSha: undefined }), undefined, {});
    expect(() => assertExpectedHead(pr, HEAD)).toThrow(/no head SHA for this PR/);
  });

  it('rejects an abbreviated expectation', async () => {
    const target = await resolveReviewTarget(prDiff(), undefined, {});
    expect(() => assertExpectedHead(target, 'abc1234')).toThrow(/--expect-head-sha.*40/);
  });
});
