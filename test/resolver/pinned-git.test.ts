import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadPinnedGitDiff } from '../../src/resolver/git.js';

const exec = promisify(execFile);
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
function fixtureEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };
}
const env = fixtureEnvironment();

describe('pinned PR path identity', () => {
  let cwd: string, baseSha: string, headSha: string;
  const git = async (...args: string[]) => (await exec('git', args, { cwd, env })).stdout.trim();
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  };
  const renamedFrom = ' from b/old.ex ';
  const renamedTo = ' to b/new.ex ';
  const quoted = 'tab\tquote"line\n.ex';
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'rcl-pinned-paths-'));
    await git('init', '--template=', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('remote', 'add', 'origin', 'git@github.com:o/r.git');
    await write('a b/z', 'old\n');
    await write('a b/deleted.ex', 'deleted\n');
    await write(renamedFrom, 'unique renamed content\n');
    await write(quoted, 'quoted old\n');
    await git('add', '.'); await git('commit', '-qm', 'base');
    baseSha = await git('rev-parse', 'HEAD');
    await write('a b/z', 'new\n');
    await write('a b/added.ex', 'added\n');
    await rm(join(cwd, 'a b/deleted.ex'));
    await rm(join(cwd, renamedFrom));
    await write(renamedTo, 'unique renamed content\n');
    await write(quoted, 'quoted new\n');
    await git('add', '.'); await git('commit', '-qm', 'head');
    headSha = await git('rev-parse', 'HEAD');
  });
  afterAll(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('binds every spaced or quoted patch to the exact committed filename', async () => {
    const diff = await loadPinnedGitDiff({ cwd, owner: 'o', repo: 'r', baseSha, headSha });
    expect(diff.files.map(file => file.filename).sort()).toEqual([
      'a b/z', 'a b/added.ex', 'a b/deleted.ex', renamedTo, quoted,
    ].sort());
    expect(diff.files.find(file => file.filename === 'a b/z')).toMatchObject({ status: 'modified',
      patch: '@@ -1 +1 @@\n-old\n+new\n' });
    expect(diff.files.find(file => file.filename === 'a b/added.ex')).toMatchObject({ status: 'added' });
    expect(diff.files.find(file => file.filename === 'a b/deleted.ex')).toMatchObject({ status: 'deleted' });
    expect(diff.files.find(file => file.filename === renamedTo)).toMatchObject({ status: 'renamed', previousFilename: renamedFrom });
    expect(diff.files.find(file => file.filename === quoted)?.patch).toContain('+quoted new');
  });
});

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

  it.each([
    'https://github.com/o/r.git/',
    'https://github.com/o/r/',
    'ssh://git@github.com/o/r.git/',
    'git@github.com:o/r.git/',
  ])('reads the pinned local patch with a trailing slash in origin %s', async remote => {
    await git('remote', 'set-url', 'origin', remote);
    try {
      const diff = await loadPinnedGitDiff(input());
      expect(diff.mergeBaseSha).toBe(baseSha);
      expect(diff.files[0]?.patch).toBe('@@ -1 +1 @@\n-old\n+new\n');
    } finally {
      await git('remote', 'set-url', 'origin', 'git@github.com:o/r.git');
    }
  });

  it.each([
    'https://github.com.example.com/o/r.git/',
    'https://github.com/o/other.git/',
    'https://github.com/extra/o/r.git/',
    'https://github.com/o/r.git//',
    'https://github.com:8443/o/r.git/',
    'https://github.com/o/r.git/?repository=o/r',
    'https://github.com/o/r.git/#o/r',
  ])('refuses a nonmatching origin despite a trailing slash: %s', async remote => {
    await git('remote', 'set-url', 'origin', remote);
    try {
      await expect(loadPinnedGitDiff(input())).rejects.toThrow('repository mismatch');
    } finally {
      await git('remote', 'set-url', 'origin', 'git@github.com:o/r.git');
    }
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


describe('pinned PR fixture isolation', () => {
  it('keeps init, config, add, and commit confined to the fixture despite inherited Git settings', async () => {
    const decoy = await mkdtemp(join(tmpdir(), 'rcl-fixture-decoy-'));
    const target = await mkdtemp(join(tmpdir(), 'rcl-fixture-target-'));
    // Bootstrap and inspect using a trusted environment, independent of the
    // helper under test. Every injected path refers only to these temp dirs.
    const cleanEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };
    const gitAt = async (cwd: string, childEnv: NodeJS.ProcessEnv, ...args: string[]) =>
      (await exec('git', args, { cwd, env: childEnv })).stdout.trim();
    const initialize = async (cwd: string, childEnv: NodeJS.ProcessEnv, name: string) => {
      await gitAt(cwd, childEnv, 'init', '--template=', '-q');
      await gitAt(cwd, childEnv, 'config', 'user.email', 'test@example.com');
      await gitAt(cwd, childEnv, 'config', 'user.name', name);
      await writeFile(join(cwd, 'a.ex'), `${name}\n`);
      await gitAt(cwd, childEnv, 'add', '.');
      await gitAt(cwd, childEnv, 'commit', '-qm', name);
    };
    const state = async () => ({
      config: await readFile(join(decoy, '.git', 'config'), 'utf8'),
      head: await gitAt(decoy, cleanEnv, 'rev-parse', 'HEAD'),
      index: await readFile(join(decoy, '.git', 'index')),
    });
    try {
      await initialize(decoy, cleanEnv, 'Decoy');
      const before = await state();
      const decoyGit = join(decoy, '.git');
      const pollutedEnv = fixtureEnvironment({ ...cleanEnv,
        GIT_DIR: decoyGit, GIT_COMMON_DIR: decoyGit, GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: join(decoyGit, 'index'), GIT_OBJECT_DIRECTORY: join(decoyGit, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoyGit, 'objects'),
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Injected',
        GIT_TRACE: join(decoy, 'unexpected-trace'),
      });
      const setupError = await initialize(target, pollutedEnv, 'Target').then(() => undefined, error => error);

      expect(await state()).toEqual(before);
      await expect(access(join(decoy, 'unexpected-trace'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(setupError).toBeUndefined();
      expect(await gitAt(target, cleanEnv, 'config', '--get', 'user.name')).toBe('Target');
      expect(await gitAt(target, cleanEnv, 'log', '-1', '--format=%s')).toBe('Target');
    } finally {
      await rm(target, { recursive: true, force: true });
      await rm(decoy, { recursive: true, force: true });
    }
  });
});
