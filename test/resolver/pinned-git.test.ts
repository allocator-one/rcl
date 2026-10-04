import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPinnedGitDiff } from '../../src/resolver/git.js';

const exec = promisify(execFile);
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const env = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };
describe('pinned PR Git patches', () => {
  let cwd: string, baseSha: string, headSha: string, largeSha: string, binarySha: string;
  const git = async (...args: string[]) => (await exec('git', args, { cwd, env })).stdout.trim();
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rcl-pinned-pr-'));
    await git('init', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('remote', 'add', 'origin', 'git@github.com:o/r.git');
    await writeFile(join(cwd, 'a.ex'), 'old\n');
    await git('add', '.'); await git('commit', '-qm', 'base');
    baseSha = await git('rev-parse', 'HEAD');
    await writeFile(join(cwd, 'a.ex'), 'new\n');
    await git('add', '.'); await git('commit', '-qm', 'head');
    headSha = await git('rev-parse', 'HEAD');
    await writeFile(join(cwd, 'large.ex'), 'x'.repeat(11 * 1024 * 1024) + '\n');
    await git('add', '.'); await git('commit', '-qm', 'large');
    largeSha = await git('rev-parse', 'HEAD');
    await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    await git('add', '.'); await git('commit', '-qm', 'binary');
    binarySha = await git('rev-parse', 'HEAD');
    await writeFile(join(cwd, 'a.ex'), 'uncommitted and excluded\n');
  });
  afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });
  const input = () => ({ cwd, owner: 'o', repo: 'r', baseSha, headSha });

  it('reviews the immutable PR commits without reading working-tree edits', async () => {
    const diff = await loadPinnedGitDiff(input());
    expect(diff.mergeBaseSha).toBe(baseSha);
    expect(diff.files[0]?.patch).toBe('@@ -1 +1 @@\n-old\n+new\n');
    expect(diff.rawDiff).not.toContain('uncommitted');
  });

  it('refuses a checkout belonging to another GitHub repository', async () => {
    await expect(loadPinnedGitDiff({ ...input(), repo: 'other' })).rejects.toThrow('repository mismatch');
  });

  it('refuses missing exact objects instead of substituting HEAD or origin/main', async () => {
    await expect(loadPinnedGitDiff({ ...input(), headSha: 'f'.repeat(40) })).rejects.toThrow('exact commits');
  });

  it('requires local ancestry to agree with the exact GitHub comparison', async () => {
    await expect(loadPinnedGitDiff({ ...input(), expectedMergeBaseSha: 'e'.repeat(40) }))
      .rejects.toThrow('merge base disagrees');
    const diff = await loadPinnedGitDiff({ ...input(), expectedMergeBaseSha: baseSha });
    expect(diff.mergeBaseSha).toBe(baseSha);
  });

  it('enforces the selected output bound and the hard ceiling', async () => {
    await expect(loadPinnedGitDiff({ ...input(), maxBytes: 32 })).rejects.toThrow(/bound|buffer/i);
    await expect(loadPinnedGitDiff({ ...input(), maxBytes: 32 * 1024 * 1024 + 1 })).rejects.toThrow('capacity');
    await expect(loadPinnedGitDiff({ ...input(), maxBytes: Number.NaN })).rejects.toThrow('capacity');
  });

  it('rejects non-object-id revision syntax before invoking Git', async () => {
    await expect(loadPinnedGitDiff({ ...input(), baseSha: 'HEAD~1' })).rejects.toThrow('exact commits');
  });

  it('requires explicit capacity for a patch beyond the unchanged 10 MiB default', async () => {
    await expect(loadPinnedGitDiff({ ...input(), headSha: largeSha })).rejects.toThrow('output bound');
    const diff = await loadPinnedGitDiff({ ...input(), headSha: largeSha, maxBytes: 16 * 1024 * 1024 });
    expect(diff.files.find(file => file.filename === 'large.ex')?.patch).toContain('x'.repeat(1024));
    expect(Buffer.byteLength(diff.rawDiff!)).toBeGreaterThan(10 * 1024 * 1024);
  });

  it('refuses binary changes instead of counting an empty patch as reviewed', async () => {
    await expect(loadPinnedGitDiff({ ...input(), baseSha: largeSha, headSha: binarySha }))
      .rejects.toThrow('binary changes');
  });
});
