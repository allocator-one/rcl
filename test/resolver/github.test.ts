import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { parseGitHubTarget, fetchPRDiff, isGitHubTarget } from '../../src/resolver/github.js';

function fakePr(changedFiles = 3) {
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
      changed_files: changedFiles,
    },
  };
}

function changedFile(i: number) {
  return {
    filename: `src/file-${i}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: `@@ -1 +1 @@\n-old\n+new-${i}`,
  };
}

const files = (n: number) => Array.from({ length: n }, (_, i) => changedFile(i));

/** An Octokit fake: compare serves `compareFiles` on one response; the PR listing serves `listed`. */
function octokitWith(opts: { pr?: ReturnType<typeof fakePr>; recheck?: ReturnType<typeof fakePr>; compareFiles?: number; listed?: number }) {
  const pr = opts.pr ?? fakePr();
  const get = vi.fn().mockResolvedValueOnce(pr).mockResolvedValueOnce(opts.recheck ?? pr);
  const compare = vi.fn(async () => ({ data: { files: files(opts.compareFiles ?? pr.data.changed_files) } }));
  const paginate = vi.fn(async () => files(opts.listed ?? pr.data.changed_files));
  const octokit = {
    pulls: { get, listFiles: { endpoint: 'pulls.listFiles' } },
    repos: { compareCommitsWithBasehead: compare },
    paginate,
  } as unknown as Octokit;
  return { octokit, get, compare, paginate };
}

describe('parseGitHubTarget', () => {
  it('parses owner/repo#N', () => {
    expect(parseGitHubTarget('allocator-one/rcl#7')).toEqual({ owner: 'allocator-one', repo: 'rcl', number: 7 });
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
  it('fetches the files through ONE compare pinned to the PR base and head SHAs (no paging params)', async () => {
    const { octokit, get, compare, paginate } = octokitWith({ pr: fakePr(31) });
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokit);

    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]![0]).toEqual({ owner: 'o', repo: 'r', basehead: 'basesha456...headsha123' });
    expect(paginate).not.toHaveBeenCalled();
    // Immutable object ids make a re-read unnecessary on the pinned path.
    expect(get).toHaveBeenCalledTimes(1);
    expect(diff.files).toHaveLength(31);
    expect(diff.files[30]!.filename).toBe('src/file-30.ts');
    expect(diff.metadata).toMatchObject({
      title: 'A big PR',
      headSha: 'headsha123',
      baseSha: 'basesha456',
      mergeCommitSha: 'mergesha789',
    });
  });

  it('accepts a compare response exactly at the 300-file cap when it accounts for every reported file', async () => {
    const { octokit, get, compare, paginate } = octokitWith({ pr: fakePr(300), compareFiles: 300 });
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokit);

    expect(compare).toHaveBeenCalledTimes(1);
    expect(paginate).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    expect(diff.files).toHaveLength(300);
  });

  it('falls back to the bracketed paged listing when the compare accounts for fewer files than the PR reports', async () => {
    const { octokit, get, compare, paginate } = octokitWith({ pr: fakePr(300), compareFiles: 250, listed: 300 });
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokit);

    expect(compare).toHaveBeenCalledTimes(1);
    expect(paginate).toHaveBeenCalledWith(
      octokit.pulls.listFiles,
      expect.objectContaining({ owner: 'o', repo: 'r', pull_number: 1, per_page: 100 })
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect(diff.files).toHaveLength(300);
  });

  it('refuses an incomplete listing instead of reviewing a truncated diff as if it were whole', async () => {
    const { octokit } = octokitWith({ pr: fakePr(3500), listed: 3000 });
    await expect(fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokit)).rejects.toThrow(
      /reports 3500 changed files but the API listed 3000/
    );
  });

  it('carries the blob id of every file so patchless changes stay bound to their content', async () => {
    const pr = fakePr(1);
    const compare = vi.fn(async () => ({
      data: { files: [{ filename: 'app.bin', status: 'modified', additions: 0, deletions: 0, sha: 'blob123' }] },
    }));
    const octokit = { pulls: { get: vi.fn().mockResolvedValue(pr) }, repos: { compareCommitsWithBasehead: compare } } as unknown as Octokit;
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokit);
    expect(diff.files[0]).toMatchObject({ filename: 'app.bin', patch: '', blobSha: 'blob123' });
  });

  it('skips the compare for PRs above the cap and brackets the paged listing with PR reads', async () => {
    const { octokit, get, compare, paginate } = octokitWith({ pr: fakePr(500), listed: 500 });
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokit);

    expect(compare).not.toHaveBeenCalled();
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(diff.files).toHaveLength(500);
    expect(diff.files[499]!.filename).toBe('src/file-499.ts');
  });

  it('falls back to the bracketed listing when the compare request itself fails', async () => {
    const fake = octokitWith({ pr: fakePr(31), listed: 31 });
    (fake.compare as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('HttpError: Not Found'));
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', fake.octokit);

    expect(fake.paginate).toHaveBeenCalledTimes(1);
    expect(fake.get).toHaveBeenCalledTimes(2);
    expect(diff.files).toHaveLength(31);
  });

  it('refuses to bind a large PR whose head or base moved while its files were listed', async () => {
    const movedHead = fakePr(500);
    movedHead.data.head.sha = 'headsha999';
    await expect(
      fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokitWith({ pr: fakePr(500), recheck: movedHead, listed: 500 }).octokit)
    ).rejects.toThrow(/moved .*headsha999/);

    const movedBase = fakePr(500);
    movedBase.data.base.sha = 'basesha999';
    await expect(
      fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokitWith({ pr: fakePr(500), recheck: movedBase, listed: 500 }).octokit)
    ).rejects.toThrow(/moved .*basesha999/);
  });
});
