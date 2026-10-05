import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { fetchPRDiff } from '../../src/resolver/github.js';
import { loadHostedPinnedGitDiff, loadPinnedGitDiff, PinnedGitObjectsUnavailableError } from '../../src/resolver/git.js';
import type { FileChange } from '../../src/resolver/types.js';

vi.mock('../../src/resolver/git.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/resolver/git.js')>(),
  loadPinnedGitDiff: vi.fn(), loadHostedPinnedGitDiff: vi.fn(),
}));

const target = { owner: 'o', repo: 'r', number: 1 };
const base = 'a'.repeat(40), head = 'b'.repeat(40), mergeBase = 'c'.repeat(40);
const complete: FileChange = { filename: 'a.ex', status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -1 +1 @@\n-old\n+new', language: 'elixir' };
function diffStream(rawDiff: string) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Buffer.from(rawDiff));
    controller.close();
  } });
}
function fixture(files: object[] = [complete], rawDiff?: string) {
  const pr = { title: 'Review', body: '', user: { login: 'author' },
    base: { ref: 'main', sha: base }, head: { ref: 'feature', sha: head },
    html_url: 'https://github.com/o/r/pull/1', labels: [], draft: false, changed_files: files.length };
  const get = vi.fn().mockResolvedValue({ data: pr });
  const compare = vi.fn().mockResolvedValue({ data: { files, merge_base_commit: { sha: mergeBase } } });
  if (rawDiff !== undefined) compare.mockResolvedValueOnce({ data: { files, merge_base_commit: { sha: mergeBase } } })
    .mockResolvedValueOnce({ data: diffStream(rawDiff) });
  const paginate = vi.fn().mockResolvedValue(files);
  const client = { pulls: { get, listFiles: {} }, repos: { compareCommitsWithBasehead: compare }, paginate } as unknown as Octokit;
  return { pr, get, compare, paginate, client };
}
beforeEach(() => {
  vi.mocked(loadPinnedGitDiff).mockReset();
  vi.mocked(loadHostedPinnedGitDiff).mockReset();
  vi.mocked(loadPinnedGitDiff).mockResolvedValue({ source: 'local', files: [complete],
    rawDiff: 'full pinned patch', mergeBaseSha: mergeBase });
  vi.mocked(loadHostedPinnedGitDiff).mockResolvedValue({ source: 'local', files: [complete],
    rawDiff: 'hosted pinned patch', mergeBaseSha: mergeBase });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('authoritative PR patch acquisition', () => {
  it('uses pinned local objects for explicit capacity even when the API could return patches', async () => {
    const f = fixture();
    const diff = await fetchPRDiff(target, undefined, f.client, { maxDiffBytes: 16 * 1024 * 1024, cwd: '/repo' });
    expect(loadPinnedGitDiff).toHaveBeenCalledWith({ owner: 'o', repo: 'r', baseSha: base, headSha: head,
      maxBytes: 16 * 1024 * 1024, cwd: '/repo', expectedMergeBaseSha: mergeBase });
    expect(f.compare).toHaveBeenCalledWith({ owner: 'o', repo: 'r', basehead: `${base}...${head}` });
    expect(f.paginate).not.toHaveBeenCalled();
    expect(loadHostedPinnedGitDiff).not.toHaveBeenCalled();
    expect(f.get).toHaveBeenCalledTimes(2);
    expect(diff).toMatchObject({ source: 'github', rawDiff: 'full pinned patch',
      metadata: { headSha: head, baseSha: base, mergeBaseSha: mergeBase } });
  });

  it('recovers changed text whose API patch and all line counts were omitted', async () => {
    const f = fixture([{ filename: 'a.ex', status: 'modified', additions: 0, deletions: 0, sha: 'd'.repeat(40) }],
      'diff --git a/a.ex b/a.ex\nindex eeeeeee..ddddddd 100644\n--- a/a.ex\n+++ b/a.ex\n@@ -1 +1 @@\n-old\n+new\n');
    const diff = await fetchPRDiff(target, undefined, f.client);
    expect(diff.files[0]).toMatchObject({ patch: complete.patch, additions: 1, deletions: 1 });
    expect(loadPinnedGitDiff).toHaveBeenCalledOnce();
  });

  it('recovers a nonempty but truncated API patch', async () => {
    const f = fixture([{ ...complete, additions: 2 }]);
    await fetchPRDiff(target, undefined, f.client);
    expect(loadPinnedGitDiff).toHaveBeenCalledOnce();
  });

  it('retains remote-only compatibility for structurally complete API patches', async () => {
    const f = fixture();
    await fetchPRDiff(target, undefined, f.client);
    expect(loadPinnedGitDiff).not.toHaveBeenCalled();
  });

  it.each([
    { filename: 'logo.png', status: 'modified', raw: 'index eeeeeee..ddddddd 100644\nBinary files a/logo.png and b/logo.png differ\n' },
    { filename: 'renamed.ex', previous_filename: 'original.ex', status: 'renamed', raw: 'similarity index 100%\nrename from original.ex\nrename to renamed.ex\n' },
    { filename: 'script.sh', status: 'modified', raw: 'old mode 100644\nnew mode 100755\n' },
  ])('keeps patchless zero-line $filename changes remotely reviewable with blob binding', async ({ raw, ...file }) => {
    const sha = 'd'.repeat(40);
    const f = fixture([{ ...file, additions: 0, deletions: 0, sha }],
      `diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}\n${raw}`);
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('missing objects'));
    const diff = await fetchPRDiff(target, undefined, f.client);
    expect(diff.files[0]).toMatchObject({ filename: file.filename, status: file.status,
      additions: 0, deletions: 0, patch: '', blobSha: sha });
    if ('previous_filename' in file) expect(diff.files[0]?.previousFilename).toBe(file.previous_filename);
    expect(loadPinnedGitDiff).not.toHaveBeenCalled();
    expect(loadHostedPinnedGitDiff).not.toHaveBeenCalled();
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.compare).toHaveBeenLastCalledWith(expect.objectContaining({ owner: 'o', repo: 'r',
      basehead: `${base}...${head}`, mediaType: { format: 'diff' },
      request: expect.objectContaining({ parseSuccessResponseBody: false }) }));
  });

  it.each([
    'diff --git a/other.png b/other.png\nindex eeeeeee..ddddddd 100644\nBinary files a/other.png and b/other.png differ\n',
    'diff --git a/logo.png b/logo.png\nindex eeeeeee..ffffff0 100644\nBinary files a/logo.png and b/logo.png differ\n',
    'diff --git a/logo.png b/logo.png\nold mode 100644\nnew mode 100755\n@@ -1 +1 @@\n-old\n+new\n',
    'diff --git a/logo.png b/logo.png\nindex eeeeeee..ddddddd 100644\nBinary files a/logo.png and b/logo.png differ',
  ])('does not certify ambiguous or mismatched patchless comparison blocks (%#)', async rawDiff => {
    const f = fixture([{ filename: 'logo.png', status: 'modified', additions: 0, deletions: 0, sha: 'd'.repeat(40) }], rawDiff);
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('missing objects'));
    vi.mocked(loadHostedPinnedGitDiff).mockRejectedValue(new Error('complete patch unavailable'));
    await expect(fetchPRDiff(target, undefined, f.client)).rejects.toThrow('complete PR patch');
  });

  it('cancels oversized raw comparisons and refuses patchless fallback', async () => {
    const file = { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0, sha: 'd'.repeat(40) };
    const f = fixture([file]);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
    }, cancel });
    f.compare.mockResolvedValueOnce({ data: { files: [file] } }).mockResolvedValueOnce({ data: stream });
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('missing objects'));
    vi.mocked(loadHostedPinnedGitDiff).mockRejectedValue(new Error('complete patch unavailable'));
    await expect(fetchPRDiff(target, undefined, f.client)).rejects.toThrow('complete PR patch');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('recovers missing textual patches even when a blob SHA is present', async () => {
    const f = fixture([{ filename: 'a.ex', status: 'modified', additions: 1, deletions: 1, sha: 'd'.repeat(40) }]);
    const diff = await fetchPRDiff(target, undefined, f.client);
    expect(diff.files[0]?.patch).toBe(complete.patch);
    expect(loadPinnedGitDiff).toHaveBeenCalledOnce();
  });

  it('requires pinned objects for patchless blob-bound files with explicit capacity', async () => {
    const f = fixture([{ filename: 'logo.png', status: 'modified', additions: 0, deletions: 0, sha: 'd'.repeat(40) }]);
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new Error('binary patch cannot be reviewed exhaustively'));
    await expect(fetchPRDiff(target, undefined, f.client, { maxDiffBytes: 16 * 1024 * 1024 }))
      .rejects.toThrow('binary patch cannot be reviewed exhaustively');
    expect(loadPinnedGitDiff).toHaveBeenCalledOnce();
  });

  it('never falls back to incomplete API patches when pinned local acquisition fails', async () => {
    const f = fixture([{ filename: 'a.ex', status: 'modified', additions: 0, deletions: 0 }]);
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new Error('Pinned PR repository mismatch'));
    await expect(fetchPRDiff(target, undefined, f.client)).rejects.toThrow('complete PR patch');
  });

  it('rejects PR movement while loading exact local objects', async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce({ data: f.pr }).mockResolvedValue({ data: { ...f.pr, head: { ...f.pr.head, sha: 'd'.repeat(40) } } });
    await expect(fetchPRDiff(target, undefined, f.client, { maxDiffBytes: 16 * 1024 * 1024 })).rejects.toThrow('moved');
  });

  it('rejects an incomplete local parse before returning review inputs', async () => {
    const f = fixture([complete, { ...complete, filename: 'b.ex' }]);
    await expect(fetchPRDiff(target, undefined, f.client, { maxDiffBytes: 16 * 1024 * 1024 })).rejects.toThrow('incomplete');
  });

  it('uses hosted exact objects only when explicit capacity lacks local objects', async () => {
    const f = fixture();
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('missing objects'));
    const diff = await fetchPRDiff(target, 'test-token', f.client, { maxDiffBytes: 16 * 1024 * 1024 });
    expect(loadHostedPinnedGitDiff).toHaveBeenCalledWith({ owner: 'o', repo: 'r', baseSha: base,
      headSha: head, expectedMergeBaseSha: mergeBase, maxBytes: 16 * 1024 * 1024, token: 'test-token' });
    expect(diff.rawDiff).toBe('hosted pinned patch');
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it('recovers omitted text remotely with the ordinary default capacity', async () => {
    const f = fixture([{ ...complete, patch: undefined }]);
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('outside matching clone'));
    const diff = await fetchPRDiff(target, 'test-token', f.client);
    expect(diff.rawDiff).toBe('hosted pinned patch');
    expect(diff.files[0]?.patch).toBe(complete.patch);
    expect(loadHostedPinnedGitDiff).toHaveBeenCalledWith({ owner: 'o', repo: 'r', baseSha: base,
      headSha: head, expectedMergeBaseSha: mergeBase, token: 'test-token' });
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it('resolves exact ancestry for ordinary hosted recovery after the file listing fallback', async () => {
    const f = fixture([{ ...complete, patch: undefined }]);
    f.compare.mockRejectedValueOnce(new Error('initial comparison unavailable'));
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('outside matching clone'));
    await fetchPRDiff(target, 'test-token', f.client);
    expect(f.compare).toHaveBeenCalledTimes(2);
    expect(f.compare).toHaveBeenLastCalledWith({ owner: 'o', repo: 'r', basehead: `${base}...${head}` });
    expect(loadHostedPinnedGitDiff).toHaveBeenCalledWith(expect.objectContaining({ expectedMergeBaseSha: mergeBase }));
  });

  it('allows anonymous public hosted acquisition with explicit capacity', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const f = fixture();
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('outside matching clone'));
    const diff = await fetchPRDiff(target, undefined, f.client, { maxDiffBytes: 16 * 1024 * 1024 });
    expect(diff.rawDiff).toBe('hosted pinned patch');
    expect(loadHostedPinnedGitDiff).toHaveBeenCalledWith(expect.objectContaining({ expectedMergeBaseSha: mergeBase,
      maxBytes: 16 * 1024 * 1024 }));
    expect(vi.mocked(loadHostedPinnedGitDiff).mock.calls[0]?.[0].token).toBeUndefined();
  });

  it('reuses an injected client credential for private hosted acquisition', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const f = fixture();
    const auth = vi.fn().mockResolvedValue({ type: 'token', token: 'client-fixture-token' });
    Object.assign(f.client, { auth });
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('outside matching clone'));
    await fetchPRDiff(target, undefined, f.client, { maxDiffBytes: 16 * 1024 * 1024 });
    expect(loadHostedPinnedGitDiff).toHaveBeenCalledWith(expect.objectContaining({ token: 'client-fixture-token' }));
    expect(auth).toHaveBeenCalledOnce();
  });

  it('requires an authoritative comparison before either object reader runs', async () => {
    const f = fixture();
    f.compare.mockResolvedValue({ data: { files: [complete] } });
    await expect(fetchPRDiff(target, 'test-token', f.client, { maxDiffBytes: 16 * 1024 * 1024 })).rejects.toThrow('merge base');
    expect(loadPinnedGitDiff).not.toHaveBeenCalled();
    expect(loadHostedPinnedGitDiff).not.toHaveBeenCalled();
  });

  it('does not retry hosted acquisition for a malformed or oversized local patch', async () => {
    const f = fixture();
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new Error('output bound'));
    await expect(fetchPRDiff(target, 'test-token', f.client, { maxDiffBytes: 16 * 1024 * 1024 })).rejects.toThrow('output bound');
    expect(loadHostedPinnedGitDiff).not.toHaveBeenCalled();
  });

  it('rejects movement and mismatched hosted comparison inputs', async () => {
    const f = fixture();
    vi.mocked(loadPinnedGitDiff).mockRejectedValue(new PinnedGitObjectsUnavailableError('missing objects'));
    vi.mocked(loadHostedPinnedGitDiff).mockResolvedValue({ source: 'local', files: [complete], mergeBaseSha: base });
    await expect(fetchPRDiff(target, 'test-token', f.client, { maxDiffBytes: 16 * 1024 * 1024 })).rejects.toThrow('merge base disagrees');
    f.get.mockResolvedValueOnce({ data: f.pr }).mockResolvedValue({ data: { ...f.pr, head: { ...f.pr.head, sha: 'd'.repeat(40) } } });
    await expect(fetchPRDiff(target, 'test-token', f.client, { maxDiffBytes: 16 * 1024 * 1024 })).rejects.toThrow('moved');
  });
});
