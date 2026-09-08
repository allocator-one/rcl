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
  });

  it('a PR target always carries both SHAs (the metadata type requires them)', async () => {
    const target = await resolveReviewTarget(prDiff(), undefined, {});
    expect(target.headSha).toBe(HEAD);
    expect(target.baseSha).toBe(BASE);
  });

  it('rejects an abbreviated expectation', async () => {
    const target = await resolveReviewTarget(prDiff(), undefined, {});
    expect(() => assertExpectedHead(target, 'abc1234')).toThrow(/--expect-head-sha.*40/);
  });
});

describe('a patch review attributed to its pull request (RCL-39)', () => {
  const patch: Diff = { source: 'file', files: [] } as unknown as Diff;

  it('binds repo, number and URL from --for-pr, in either form', async () => {
    for (const forPr of ['allocator-one/rcl#42', 'https://github.com/allocator-one/rcl/pull/42']) {
      const target = await resolveReviewTarget(patch, undefined, { headSha: HEAD, forPr });
      expect(target).toEqual({
        kind: 'patch',
        repo: 'allocator-one/rcl',
        prNumber: 42,
        url: 'https://github.com/allocator-one/rcl/pull/42',
        headSha: HEAD,
      });
    }
  });

  it('takes a converge target of the owner/repo#N form, and ignores a slug', async () => {
    expect(await resolveReviewTarget(patch, undefined, { headSha: HEAD, convergeTarget: 'allocator-one/rcl#42' })).toMatchObject({ repo: 'allocator-one/rcl', prNumber: 42 });
    expect(await resolveReviewTarget(patch, undefined, { headSha: HEAD, convergeTarget: 'rcl-42' })).toEqual({ kind: 'patch', headSha: HEAD });
    // --for-pr wins over the converge target.
    expect(await resolveReviewTarget(patch, undefined, { forPr: 'allocator-one/rcl#7', convergeTarget: 'allocator-one/rcl#42' })).toMatchObject({ prNumber: 7 });
  });

  it('refuses --for-pr that does not name a pull request, on either segment', async () => {
    await expect(resolveReviewTarget(patch, undefined, { forPr: 'feature-branch' })).rejects.toThrow(/--for-pr/);
    for (const bad of ['allocator-one/..#1', '../rcl#1', '-bad-/rcl#1', 'allocator-one/rcl#0']) {
      await expect(resolveReviewTarget(patch, undefined, { forPr: bad }), bad).rejects.toThrow(/--for-pr/);
    }
    await expect(resolveReviewTarget(patch, undefined, { headSha: HEAD, convergeTarget: 'allocator-one/..#1' })).rejects.toThrow(/--converge-target/);
  });

  it('refuses --for-pr on a PR or git-mode target, which name their own', async () => {
    await expect(resolveReviewTarget(prDiff(), undefined, { forPr: 'allocator-one/rcl#42' })).rejects.toThrow(/patch files only/);
    await expect(resolveReviewTarget(patch, 'staged', { forPr: 'allocator-one/rcl#42' }, { gitHeads: { headSha: HEAD } })).rejects.toThrow(/patch files only/);
  });
});
