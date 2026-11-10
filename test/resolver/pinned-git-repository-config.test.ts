import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPinnedGitDiff } from '../../src/resolver/git.js';

const exec = promisify(execFile);
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };

describe('pinned PR patch under repository-local diff configuration', () => {
  let repo: string, baseSha: string, headSha: string;
  const git = async (...args: string[]) => (await exec('git', args, { cwd: repo, env })).stdout.trim();

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rcl-pinned-config-'));
    await git('init', '--template=', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('remote', 'add', 'origin', 'git@github.com:o/r.git');
    await mkdir(join(repo, 'sub'));
    await writeFile(join(repo, 'sub', 'inside.ex'), 'old\n');
    await writeFile(join(repo, 'outside.ex'), 'old\n');
    await git('add', '.'); await git('commit', '-qm', 'base');
    baseSha = await git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'sub', 'inside.ex'), 'new\n');
    await writeFile(join(repo, 'outside.ex'), 'new\n');
    await git('commit', '-qam', 'head');
    headSha = await git('rev-parse', 'HEAD');
    // A reader's own repository configuration must not decide which files a
    // "complete" PR patch contains.
    await git('config', 'diff.relative', 'true');
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

  it('keeps files outside the working subdirectory when diff.relative is configured', async () => {
    const diff = await loadPinnedGitDiff({ cwd: join(repo, 'sub'), owner: 'o', repo: 'r', baseSha, headSha });
    expect(diff.files.map(file => file.filename).sort()).toEqual(['outside.ex', 'sub/inside.ex']);
  });
});
