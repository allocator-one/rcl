import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { parseGitHubTarget, fetchPRDiff } from '../../src/resolver/github.js';

function fakePr() {
  return {
    data: {
      title: 'A big PR',
      body: 'body',
      user: { login: 'mstroeck' },
      base: { ref: 'main' },
      head: { ref: 'feature', sha: 'headsha123' },
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
});
