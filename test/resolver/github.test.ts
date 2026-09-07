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
    ]) {
      expect(isGitHubTarget(local)).toBe(false);
    }
    expect(() => parseGitHubTarget('a/b/c#5')).toThrow(/Invalid GitHub target/);
  });
});

describe('fetchPRDiff', () => {
  it('paginates the PR file listing beyond 100 files', async () => {
    const manyFiles = Array.from({ length: 250 }, (_, i) => ({
      filename: `src/file-${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: `@@ -1 +1 @@\n-old\n+new-${i}`,
    }));

    const listFiles = { endpoint: 'pulls.listFiles' };
    const paginate = vi.fn().mockResolvedValue(manyFiles);
    const fakeOctokit = {
      pulls: {
        get: vi.fn().mockResolvedValue(fakePr()),
        listFiles,
      },
      paginate,
    } as unknown as Octokit;

    const diff = await fetchPRDiff(
      { owner: 'o', repo: 'r', number: 1 },
      'token',
      fakeOctokit
    );

    expect(paginate).toHaveBeenCalledWith(
      listFiles,
      expect.objectContaining({ owner: 'o', repo: 'r', pull_number: 1, per_page: 100 })
    );
    expect(diff.files).toHaveLength(250);
    expect(diff.files[249]!.filename).toBe('src/file-249.ts');
    expect(diff.metadata?.title).toBe('A big PR');
  });

  it('captures the exact head, base and merge-commit SHAs the API already returns', async () => {
    const fakeOctokit = {
      pulls: {
        get: vi.fn().mockResolvedValue(fakePr()),
        listFiles: { endpoint: 'pulls.listFiles' },
      },
      paginate: vi.fn().mockResolvedValue([]),
    } as unknown as Octokit;

    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', fakeOctokit);

    expect(diff.metadata).toMatchObject({
      headSha: 'headsha123',
      baseSha: 'basesha456',
      mergeCommitSha: 'mergesha789',
    });
  });

  it('refuses to bind when the PR head moves between the metadata read and the file listing', async () => {
    const moved = fakePr();
    moved.data.head.sha = 'headsha999';
    const fakeOctokit = {
      pulls: {
        get: vi.fn().mockResolvedValueOnce(fakePr()).mockResolvedValueOnce(moved),
        listFiles: { endpoint: 'pulls.listFiles' },
      },
      paginate: vi.fn().mockResolvedValue([]),
    } as unknown as Octokit;

    await expect(fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', fakeOctokit)).rejects.toThrow(
      /head moved from headsha123 to headsha999/
    );
  });

  it('refuses to bind when the PR base moves while its files are being fetched', async () => {
    const moved = fakePr();
    moved.data.base.sha = 'basesha999';
    const fakeOctokit = {
      pulls: {
        get: vi.fn().mockResolvedValueOnce(fakePr()).mockResolvedValueOnce(moved),
        listFiles: { endpoint: 'pulls.listFiles' },
      },
      paginate: vi.fn().mockResolvedValue([]),
    } as unknown as Octokit;

    await expect(fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', fakeOctokit)).rejects.toThrow(
      /base moved from basesha456 to basesha999/
    );
  });

  it('re-reads the PR only after the file listing has settled', async () => {
    const order: string[] = [];
    const fakeOctokit = {
      pulls: {
        get: vi.fn(async () => {
          order.push('get');
          return fakePr();
        }),
        listFiles: { endpoint: 'pulls.listFiles' },
      },
      paginate: vi.fn(async () => {
        order.push('files');
        return [];
      }),
    } as unknown as Octokit;

    await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', fakeOctokit);
    expect(order.indexOf('files')).toBeLessThan(order.lastIndexOf('get'));
    expect(order.filter((o) => o === 'get')).toHaveLength(2);
  });
});
