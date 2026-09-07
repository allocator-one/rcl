import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { parseGitHubTarget, fetchPRDiff, isGitHubTarget } from '../../src/resolver/github.js';

function fakePr() {
  return {
    data: {
      title: 'A big PR',
      body: 'body',
      user: { login: 'mstroeck' },
      base: { ref: 'main', sha: 'basesha456' },
      head: { ref: 'feature', sha: 'headsha123' },
      merge_commit_sha: 'mergesha789',
      html_url: 'https://github.com/o/r/pull/1',
      labels: [{ name: 'big' }],
      draft: false,
    },
  };
}

function compareFile(i: number) {
  return {
    filename: `src/file-${i}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: `@@ -1 +1 @@\n-old\n+new-${i}`,
  };
}

/** A compare endpoint fake that serves `total` files in pages of 100. */
function compareServing(total: number) {
  return vi.fn(async ({ page, per_page }: { page: number; per_page: number }) => {
    const start = (page - 1) * per_page;
    const files = Array.from({ length: Math.max(0, Math.min(per_page, total - start)) }, (_, i) =>
      compareFile(start + i)
    );
    return { data: { files } };
  });
}

function octokitWith(compare: ReturnType<typeof vi.fn>, get = vi.fn().mockResolvedValue(fakePr())) {
  return { pulls: { get }, repos: { compareCommitsWithBasehead: compare } } as unknown as Octokit;
}

describe('parseGitHubTarget', () => {
  it('parses owner/repo#N', () => {
    expect(parseGitHubTarget('allocator-one/rcl#7')).toEqual({
      owner: 'allocator-one',
      repo: 'rcl',
      number: 7,
    });
  });

  it('parses a PR URL', () => {
    expect(parseGitHubTarget('https://github.com/allocator-one/rcl/pull/7')).toEqual({
      owner: 'allocator-one',
      repo: 'rcl',
      number: 7,
    });
  });

  it('rejects garbage', () => {
    expect(() => parseGitHubTarget('nonsense')).toThrow(/Invalid GitHub target/);
  });
});

describe('isGitHubTarget', () => {
  it('recognizes PR references by shape and nothing else', () => {
    expect(isGitHubTarget('allocator-one/rcl#7')).toBe(true);
    expect(isGitHubTarget('https://github.com/allocator-one/rcl/pull/7')).toBe(true);
    for (const local of ['fix.DIFF', 'patches/fix', 'changes.txt', './x.patch', '/tmp/x.diff', 'owner/repo']) {
      expect(isGitHubTarget(local)).toBe(false);
    }
  });

  it('accepts the URL variants people paste', () => {
    for (const url of [
      'https://github.com/o/r/pull/7/',
      'https://github.com/o/r/pull/7/files',
      'https://github.com/o/r/pull/7/commits',
      'https://github.com/o/r/pull/7?diff=split',
      'https://github.com/o/r/pull/7#discussion_r123',
      'http://github.com/o/r/pull/7',
      'https://www.github.com/o/r/pull/7',
      'https://github.com:443/o/r/pull/7',
      'HTTPS://GitHub.com/o/r/pull/7',
      'github.com/o/r/pull/7',
    ]) {
      expect(isGitHubTarget(url)).toBe(true);
      expect(parseGitHubTarget(url)).toEqual({ owner: 'o', repo: 'r', number: 7 });
    }
  });

  it('is anchored: local paths that merely contain a PR-like substring are patch files', () => {
    for (const local of [
      'patches/github.com/o/r/pull/1.patch',
      './vendor/github.com/o/r/pull/12',
      'test-github.com/o/r/pull/123',
      'a/b/c#5',
      'out/patches/round#2',
      'notes#1.diff',
      'o/r#abc',
      'https://gitlab.com/o/r/pull/7',
      'https://github.com/o/r/issues/5',
    ]) {
      expect(isGitHubTarget(local)).toBe(false);
    }
    expect(() => parseGitHubTarget('a/b/c#5')).toThrow(/Invalid GitHub target/);
  });
});

describe('fetchPRDiff', () => {
  it('fetches the changed files through a compare pinned to the PR base and head SHAs, paging past 100 files', async () => {
    const compare = compareServing(250);
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokitWith(compare));

    expect(compare).toHaveBeenCalledTimes(3);
    for (const [page, call] of compare.mock.calls.entries()) {
      expect(call[0]).toEqual({
        owner: 'o',
        repo: 'r',
        basehead: 'basesha456...headsha123',
        per_page: 100,
        page: page + 1,
      });
    }
    expect(diff.files).toHaveLength(250);
    expect(diff.files[249]!.filename).toBe('src/file-249.ts');
    expect(diff.metadata?.title).toBe('A big PR');
  });

  it('binds the metadata to the same SHAs the compare was pinned to', async () => {
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokitWith(compareServing(0)));

    expect(diff.metadata).toMatchObject({
      headSha: 'headsha123',
      baseSha: 'basesha456',
      mergeCommitSha: 'mergesha789',
    });
  });

  it('reads the PR exactly once — the immutable object ids make a re-read unnecessary', async () => {
    const get = vi.fn().mockResolvedValue(fakePr());
    await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokitWith(compareServing(3), get));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('refuses an absurdly large comparison instead of paging forever', async () => {
    const endless = vi.fn(async () => ({ data: { files: Array.from({ length: 100 }, (_, i) => compareFile(i)) } }));
    await expect(fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokitWith(endless))).rejects.toThrow(
      /more than 3000 files/
    );
    expect(endless).toHaveBeenCalledTimes(30);
  });
});
