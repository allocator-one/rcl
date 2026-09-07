import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadGitDiff, resolveGitHeads } from '../../src/resolver/git.js';

const execFileAsync = promisify(execFile);

// Isolate from the developer's global/system git config (init.defaultBranch,
// hooks, external diff) so the fixtures behave the same on every machine.
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, env: GIT_ENV });
}

describe('loadGitDiff', () => {
  let repo: string;
  let notARepo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rcl-git-test-'));
    notARepo = await mkdtemp(join(tmpdir(), 'rcl-git-test-plain-'));

    await git(repo, 'init');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await writeFile(join(repo, 'committed.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'modified-later.ts'), 'export const b = 2;\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'initial');

    // Staged change: a new file
    await writeFile(join(repo, 'staged-only.ts'), 'export const staged = true;\n');
    await git(repo, 'add', 'staged-only.ts');

    // Unstaged change: modify a tracked file
    await writeFile(join(repo, 'modified-later.ts'), 'export const b = 99;\n');

    // Untracked file: must appear in neither mode
    await writeFile(join(repo, 'untracked.ts'), 'export const invisible = true;\n');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(notARepo, { recursive: true, force: true });
  });

  it('staged mode returns only staged changes', async () => {
    const diff = await loadGitDiff('staged', repo);
    expect(diff.source).toBe('local');
    expect(diff.files.map((f) => f.filename)).toEqual(['staged-only.ts']);
    expect(diff.files[0]!.status).toBe('added');
    expect(diff.files[0]!.patch).toContain('+export const staged = true;');
  });

  it('working-tree mode returns staged and unstaged changes vs HEAD', async () => {
    const diff = await loadGitDiff('working-tree', repo);
    const names = diff.files.map((f) => f.filename).sort();
    expect(names).toEqual(['modified-later.ts', 'staged-only.ts']);
    const modified = diff.files.find((f) => f.filename === 'modified-later.ts')!;
    expect(modified.status).toBe('modified');
    expect(modified.patch).toContain('-export const b = 2;');
    expect(modified.patch).toContain('+export const b = 99;');
  });

  it('neither mode includes untracked files', async () => {
    for (const mode of ['staged', 'working-tree'] as const) {
      const diff = await loadGitDiff(mode, repo);
      expect(diff.files.map((f) => f.filename)).not.toContain('untracked.ts');
    }
  });

  it('returns an empty file list when there is nothing to review', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'rcl-git-test-clean-'));
    try {
      await git(clean, 'init');
      await git(clean, 'config', 'user.email', 'test@example.com');
      await git(clean, 'config', 'user.name', 'Test');
      await writeFile(join(clean, 'a.ts'), 'export {};\n');
      await git(clean, 'add', '.');
      await git(clean, 'commit', '-m', 'initial');

      const staged = await loadGitDiff('staged', clean);
      expect(staged.files).toEqual([]);
      const workingTree = await loadGitDiff('working-tree', clean);
      expect(workingTree.files).toEqual([]);
    } finally {
      await rm(clean, { recursive: true, force: true });
    }
  });

  it('fails with a clear error outside a git repository', async () => {
    // Guard against a git repo in a parent of tmpdir: use a nested dir.
    const nested = join(notARepo, 'deep');
    await mkdir(nested, { recursive: true });
    await expect(loadGitDiff('staged', nested)).rejects.toThrow(
      /--staged requires running inside a git repository/
    );
  });

  it('preserves non-ASCII filenames', async () => {
    await writeFile(join(repo, 'ünïcode.ts'), 'export const u = 1;\n');
    await git(repo, 'add', 'ünïcode.ts');
    try {
      const diff = await loadGitDiff('staged', repo);
      expect(diff.files.map((f) => f.filename)).toContain('ünïcode.ts');
    } finally {
      await git(repo, 'rm', '--cached', '-q', 'ünïcode.ts');
      await rm(join(repo, 'ünïcode.ts'), { force: true });
    }
  });
});

describe('resolveGitHeads', () => {
  let repo: string;
  let notARepo: string;
  let firstCommit: string;
  let secondCommit: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rcl-git-heads-'));
    notARepo = await mkdtemp(join(tmpdir(), 'rcl-git-heads-plain-'));
    await git(repo, 'init');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'first');
    firstCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    // Fake the remote default branch at the first commit, then move on.
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await writeFile(join(repo, 'b.ts'), 'export const b = 2;\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'second');
    secondCommit = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(notARepo, { recursive: true, force: true });
  });

  it('resolves HEAD and the merge-base with the remote default branch', async () => {
    const heads = await resolveGitHeads(repo);
    expect(heads.headSha).toBe(secondCommit);
    expect(heads.baseSha).toBe(firstCommit);
  });

  it('returns nothing outside a repository instead of throwing', async () => {
    expect(await resolveGitHeads(notARepo)).toEqual({});
  });
});

describe('resolveGitHeads — default-branch detection', () => {
  const repos: string[] = [];

  async function repoWithTwoCommits(): Promise<{ dir: string; first: string; second: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'rcl-git-default-'));
    repos.push(dir);
    await git(dir, 'init', '-q', '-b', 'trunk');
    await git(dir, 'config', 'user.email', 'test@example.com');
    await git(dir, 'config', 'user.name', 'Test');
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'first');
    const first = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV })).stdout.trim();
    await writeFile(join(dir, 'b.ts'), 'export const b = 2;\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', 'second');
    const second = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV })).stdout.trim();
    return { dir, first, second };
  }

  afterAll(async () => {
    for (const dir of repos) await rm(dir, { recursive: true, force: true });
  });

  it('prefers the remote default branch recorded in origin/HEAD, whatever its name', async () => {
    const { dir, first, second } = await repoWithTwoCommits();
    await git(dir, 'update-ref', 'refs/remotes/origin/trunk', first);
    await git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    expect(await resolveGitHeads(dir)).toEqual({ headSha: second, baseSha: first });
  });

  it('falls back to origin/master when origin/HEAD and origin/main are absent', async () => {
    const { dir, first, second } = await repoWithTwoCommits();
    await git(dir, 'update-ref', 'refs/remotes/origin/master', first);
    expect(await resolveGitHeads(dir)).toEqual({ headSha: second, baseSha: first });
  });

  it('records only HEAD when no remote default branch can be found', async () => {
    const { dir, second } = await repoWithTwoCommits();
    expect(await resolveGitHeads(dir)).toEqual({ headSha: second });
  });
});
