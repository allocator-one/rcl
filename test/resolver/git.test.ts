import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadGitDiff } from '../../src/resolver/git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
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
