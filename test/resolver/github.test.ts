import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { parseGitHubTarget, fetchPRDiff, isGitHubTarget } from '../../src/resolver/github.js';
import { chunkDiff } from '../../src/prepare/chunker.js';
import { resolveReviewTarget } from '../../src/resolver/target.js';
import { buildRunHeader, diffDigest } from '../../src/report/run-header.js';

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
    deletions: 1,
    patch: `@@ -1 +1 @@\n-old\n+new-${i}`,
  };
}

const files = (n: number) => Array.from({ length: n }, (_, i) => changedFile(i));

/** A `.gitattributes` in the fake repository: its text, or a symlink (git mode 120000). */
type AttributesFixture = string | { symlink: true };

const attributesSha = (path: string, ref: string) => `${Buffer.from(`${ref}:${path}`).toString('hex')}`.padEnd(40, '0').slice(0, 40);

/**
 * An Octokit fake: compare serves `compareFiles` on one response; the PR listing serves `listed`;
 * the git tree and blob endpoints serve the `.gitattributes` fixtures of the base (and, to prove it
 * is never read, of the head).
 */
function octokitWith(opts: {
  pr?: ReturnType<typeof fakePr>; recheck?: ReturnType<typeof fakePr>; compareFiles?: number; listed?: number;
  attributes?: AttributesFixture; nested?: Record<string, AttributesFixture>; headAttributes?: string;
  treeTruncated?: boolean; getContentError?: unknown;
}) {
  const pr = opts.pr ?? fakePr();
  const get = vi.fn().mockResolvedValueOnce(pr).mockResolvedValueOnce(opts.recheck ?? pr);
  const compare = vi.fn(async () => ({ data: { files: files(opts.compareFiles ?? pr.data.changed_files) } }));
  const paginate = vi.fn(async () => files(opts.listed ?? pr.data.changed_files));
  const fixturesAt = (ref: string): Record<string, AttributesFixture> => {
    if (ref === pr.data.head.sha) return opts.headAttributes === undefined ? {} : { '.gitattributes': opts.headAttributes };
    return { ...(opts.attributes === undefined ? {} : { '.gitattributes': opts.attributes }), ...opts.nested };
  };
  const getTree = vi.fn(async (request: { tree_sha: string }) => {
    if (opts.getContentError) throw opts.getContentError;
    const tree = [
      { path: 'src', type: 'tree', mode: '040000', sha: 'c'.repeat(40) },
      { path: 'src/file-1.ts', type: 'blob', mode: '100644', sha: 'd'.repeat(40), size: 10 },
      ...Object.entries(fixturesAt(request.tree_sha)).map(([path, fixture]) => ({
        path, type: 'blob', sha: attributesSha(path, request.tree_sha),
        mode: typeof fixture === 'string' ? '100644' : '120000',
        size: typeof fixture === 'string' ? Buffer.byteLength(fixture, 'utf8') : 10,
      })),
    ];
    return { data: { sha: request.tree_sha, truncated: opts.treeTruncated ?? false, tree } };
  });
  const getBlob = vi.fn(async (request: { file_sha: string }) => {
    for (const ref of [pr.data.base.sha, pr.data.head.sha]) {
      for (const [path, fixture] of Object.entries(fixturesAt(ref))) {
        if (attributesSha(path, ref) !== request.file_sha || typeof fixture !== 'string') continue;
        const content = Buffer.from(fixture, 'utf8');
        return { data: { encoding: 'base64', size: content.length, content: content.toString('base64') } };
      }
    }
    throw Object.assign(new Error('Not Found'), { status: 404 });
  });
  const octokit = {
    pulls: { get, listFiles: { endpoint: 'pulls.listFiles' } },
    repos: { compareCommitsWithBasehead: compare },
    git: { getTree, getBlob },
    paginate,
  } as unknown as Octokit;
  return { octokit, get, compare, paginate, getTree, getBlob };
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
  it('retains the actual comparison merge base for ordinary PR reviews (RCL-210)', async () => {
    const fake = octokitWith({ pr: fakePr(1) });
    fake.compare.mockResolvedValueOnce({ data: { files: files(1), merge_base_commit: { sha: 'c'.repeat(40) } } } as any);
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', fake.octokit);
    expect(diff.metadata?.mergeBaseSha).toBe('c'.repeat(40));
    expect(diff.metadata?.baseSha).toBe('basesha456');
  });

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

  it('retains the blob binding for ordinary patchless remote changes', async () => {
    const pr = fakePr(1);
    pr.data.base.sha = 'a'.repeat(40);
    pr.data.head.sha = 'b'.repeat(40);
    const compare = vi.fn().mockResolvedValueOnce({
      data: { files: [{ filename: 'app.bin', status: 'modified', additions: 0, deletions: 0, sha: 'd'.repeat(40) }] },
    }).mockResolvedValueOnce({ data: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Buffer.from('diff --git a/app.bin b/app.bin\nindex eeeeeee..ddddddd 100644\nBinary files a/app.bin and b/app.bin differ\n'));
      controller.close();
    } }) });
    const octokit = { pulls: { get: vi.fn().mockResolvedValue(pr) }, repos: { compareCommitsWithBasehead: compare } } as unknown as Octokit;
    const diff = await fetchPRDiff({ owner: 'o', repo: 'r', number: 1 }, 'token', octokit);
    expect(diff.files).toEqual([expect.objectContaining({ filename: 'app.bin', patch: '', blobSha: 'd'.repeat(40) })]);
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


describe('retained PR effective merge-base binding', () => {
  const target = { owner: 'o', repo: 'r', number: 1 };
  function strictFixture(count = 3) {
    const pr = fakePr(count); pr.data.base.sha = 'a'.repeat(40); pr.data.head.sha = 'b'.repeat(40);
    return octokitWith({ pr });
  }
  it('returns the actual merge base separately from the upstream tip', async () => {
    const f = strictFixture(); f.compare.mockResolvedValue({ data: { files: files(3), merge_base_commit: { sha: 'c'.repeat(40) } } } as any);
    const diff = await fetchPRDiff(target, undefined, f.octokit, { requireMergeBase: true });
    expect(diff.metadata).toMatchObject({ baseSha: 'a'.repeat(40), mergeBaseSha: 'c'.repeat(40), headSha: 'b'.repeat(40) });
    expect(f.compare).toHaveBeenCalledWith({ owner: 'o', repo: 'r', basehead: `${'a'.repeat(40)}...${'b'.repeat(40)}` });
  });
  it.each([undefined, 'bad', 'a'.repeat(40) + '\n'])('refuses absent/malformed merge-base %s without a tip substitution', async sha => {
    const f = strictFixture(); f.compare.mockResolvedValue({ data: { files: files(3), merge_base_commit: { sha } } } as any);
    await expect(fetchPRDiff(target, undefined, f.octokit, { requireMergeBase: true })).rejects.toThrow('merge base');
    expect(f.paginate).not.toHaveBeenCalled();
  });
  it('still obtains a pinned merge base when full files require bracketed pagination', async () => {
    const f = strictFixture(301); f.compare.mockResolvedValue({ data: { files: files(300), merge_base_commit: { sha: 'c'.repeat(40) } } } as any);
    const diff = await fetchPRDiff(target, undefined, f.octokit, { requireMergeBase: true });
    expect(diff.files).toHaveLength(301); expect(diff.metadata?.mergeBaseSha).toBe('c'.repeat(40)); expect(f.paginate).toHaveBeenCalledOnce();
  });
});

describe('generated paths declared by the base .gitattributes (RCL-209)', () => {
  const target = { owner: 'o', repo: 'r', number: 1 };
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const attributes = 'spec/infraone.json linguist-generated\ndocs/infraone/** linguist-generated\n';
  // The served-spec shape: one generated file alone is over the 64,000-line patch cap.
  const hugePatch = `@@ -1 +1,70000 @@\n-x\n${Array.from({ length: 70_000 }, (_, i) => `+line ${i}`).join('\n')}\n`;
  const spec = (blobSha: string, patch = hugePatch) =>
    ({ filename: 'spec/infraone.json', status: 'modified', additions: 70_000, deletions: 1, patch, sha: blobSha });

  function release(blobSha: string, extra: Parameters<typeof octokitWith>[0] = {}) {
    const pr = fakePr(2); pr.data.base.sha = base; pr.data.head.sha = head;
    const f = octokitWith({ ...extra, pr });
    f.compare.mockResolvedValue({ data: { files: [changedFile(1), spec(blobSha)] } } as any);
    return f;
  }

  it('reads the attributes at the base commit, never the head', async () => {
    const f = release('1'.repeat(40), { attributes });
    await fetchPRDiff(target, undefined, f.octokit);
    expect(f.getTree).toHaveBeenCalledOnce();
    expect(f.getTree).toHaveBeenCalledWith(expect.objectContaining({ tree_sha: base, recursive: 'true' }));
    expect(f.getBlob).toHaveBeenCalledOnce();
  });

  it('leaves the generated patch out so an over-cap PR can be chunked, and says so in the metadata', async () => {
    const without = await fetchPRDiff(target, undefined, release('1'.repeat(40)).octokit);
    expect(() => chunkDiff(without.files)).toThrow(/lossless safety capacity/);

    const diff = await fetchPRDiff(target, undefined, release('1'.repeat(40), { attributes }).octokit);
    const chunks = chunkDiff(diff.files);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.files.find((f) => f.filename === 'spec/infraone.json')?.patch).toBe('');
    expect(chunks[0]!.files.find((f) => f.filename === 'src/file-1.ts')?.patch).toContain('+new-1');
    expect(diff.metadata?.leftOut).toEqual({ reason: 'linguist-generated', ref: base, count: 1, paths: ['spec/infraone.json'] });
  });

  it('keeps the evidence bound to the full head: the digest moves with the generated content', async () => {
    const attributesOpt = { attributes };
    const one = await fetchPRDiff(target, undefined, release('1'.repeat(40), attributesOpt).octokit);
    const same = await fetchPRDiff(target, undefined, release('1'.repeat(40), attributesOpt).octokit);
    const other = await fetchPRDiff(target, undefined, release('2'.repeat(40), attributesOpt).octokit);
    expect(diffDigest(same.files)).toBe(diffDigest(one.files));
    expect(diffDigest(other.files)).not.toBe(diffDigest(one.files));
  });

  it('leaves nothing out, and reads no attributes, while the full patch fits the review', async () => {
    const f = release('1'.repeat(40), { attributes });
    f.compare.mockResolvedValue({ data: { files: [changedFile(1), { ...spec('1'.repeat(40), '@@ -1 +1,2 @@\n-a\n+b\n+c\n'), additions: 2, deletions: 1 }] } } as any);
    const diff = await fetchPRDiff(target, undefined, f.octokit);
    expect(diff.metadata?.leftOut).toBeUndefined();
    expect(diff.files.find((x) => x.filename === 'spec/infraone.json')?.patch).toContain('+c');
    expect(f.getTree).not.toHaveBeenCalled();
    expect(f.getBlob).not.toHaveBeenCalled();
  });

  it('keeps a file in review when a base .gitattributes in one of its directories could change its attributes', async () => {
    const f = release('1'.repeat(40), { attributes, nested: { 'spec/.gitattributes': 'infraone.json -linguist-generated\n' } });
    const diff = await fetchPRDiff(target, undefined, f.octokit);
    expect(diff.metadata?.leftOut).toBeUndefined();
    expect(diff.files.find((x) => x.filename === 'spec/infraone.json')?.patch).toBe(hugePatch);
    expect(f.getBlob).toHaveBeenCalledOnce(); // the root file only; a nested one is never read, only its presence counts
  });

  it('keeps a file in review below a symlinked .gitattributes too, and ignores a symlinked root one as git does', async () => {
    const nested = await fetchPRDiff(target, undefined,
      release('1'.repeat(40), { attributes, nested: { 'spec/.gitattributes': { symlink: true } } }).octokit);
    expect(nested.metadata?.leftOut).toBeUndefined();

    const f = release('1'.repeat(40), { attributes: { symlink: true } });
    const root = await fetchPRDiff(target, undefined, f.octokit);
    expect(root.metadata?.leftOut).toBeUndefined();
    expect(root.files.find((x) => x.filename === 'spec/infraone.json')?.patch).toBe(hugePatch);
    expect(f.getBlob).not.toHaveBeenCalled();
  });

  it('fails the review when the repository tree is too large to list, rather than guess at nested attributes', async () => {
    const f = release('1'.repeat(40), { attributes, treeTruncated: true });
    await expect(fetchPRDiff(target, undefined, f.octokit)).rejects.toThrow(/too large to list/);
  });

  it('records the left-out paths in the run header target', async () => {
    const diff = await fetchPRDiff(target, undefined, release('1'.repeat(40), { attributes }).octokit);
    const runTarget = await resolveReviewTarget(diff, undefined, {});
    expect(runTarget.leftOut).toEqual(diff.metadata?.leftOut);
    const header = buildRunHeader({
      rclVersion: 'test', command: 'review', target: runTarget, diff, roster: [], config: {} as any,
      thresholds: { minConsensusScore: 0, minConfidence: 0, dedupeLineWindow: 0, jaccardThreshold: 0 },
      gating: { mode: 'severity', minModels: 1 } as any, runner: { kind: 'human' },
      startedAt: new Date(0), finishedAt: new Date(0), ciExitCode: 0,
    } as any);
    expect(header.target.left_out).toEqual({ reason: 'linguist-generated', ref: base, count: 1, paths: ['spec/infraone.json'] });
  });

  it('does not let the PR declare its own files generated: a head-only .gitattributes changes nothing', async () => {
    // The base has no .gitattributes; the head carries one that would leave the spec out. Only the base is read.
    const f = release('1'.repeat(40), { headAttributes: attributes });
    const diff = await fetchPRDiff(target, undefined, f.octokit);
    expect(diff.metadata?.leftOut).toBeUndefined();
    expect(diff.files.find((x) => x.filename === 'spec/infraone.json')?.patch).toBe(hugePatch);
    expect(f.getTree.mock.calls.every(([request]) => request.tree_sha === base)).toBe(true);
    expect(f.getBlob).not.toHaveBeenCalled();
  });

  it('fails the review when the attributes cannot be read, rather than reviewing a different patch', async () => {
    const f = release('1'.repeat(40), { getContentError: Object.assign(new Error('rate limited'), { status: 403 }) });
    await expect(fetchPRDiff(target, undefined, f.octokit)).rejects.toThrow('rate limited');
  });

  it('reads the attributes through the real Octokit response handling', async () => {
    const { Octokit } = await import('@octokit/rest');
    const pr = fakePr(2); pr.data.base.sha = base; pr.data.head.sha = head;
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
    const paths: string[] = [];
    const octokit = new Octokit({ request: { fetch: async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      paths.push(decodeURIComponent(url.pathname));
      if (url.pathname.includes('/git/trees/')) {
        return json({ sha: base, truncated: false, tree: [
          { path: 'spec', type: 'tree', mode: '040000', sha: 'c'.repeat(40) },
          { path: '.gitattributes', type: 'blob', mode: '100644', sha: 'e'.repeat(40), size: attributes.length },
          { path: 'docs/.gitattributes', type: 'blob', mode: '100644', sha: 'f'.repeat(40), size: 5 },
        ] });
      }
      if (url.pathname.includes('/git/blobs/')) {
        return json({ encoding: 'base64', size: attributes.length, content: Buffer.from(attributes, 'utf8').toString('base64') });
      }
      if (url.pathname.includes('/compare/')) return json({ files: [changedFile(1), spec('1'.repeat(40))] });
      return json(pr.data);
    } } });
    const diff = await fetchPRDiff(target, undefined, octokit);
    expect(diff.metadata?.leftOut?.paths).toEqual(['spec/infraone.json']);
    expect(paths.some((path) => path.endsWith(`/git/trees/${base}`))).toBe(true);
  });
});
