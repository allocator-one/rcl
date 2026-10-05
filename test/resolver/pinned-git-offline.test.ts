import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPinnedGitDiff, PinnedGitObjectsUnavailableError } from '../../src/resolver/git.js';

const exec = promisify(execFile);
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
afterEach(() => { vi.unstubAllEnvs(); });

// Fixture setup must be safe even when the suite is launched by a Git hook.
function fixtureEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };
}


describe('local pinned PR reads stay offline', () => {
  it('isolates fixture writes and pinned reads from inherited repository, object, and config settings', async () => {
    const decoy = await mkdtemp(join(tmpdir(), 'rcl-pinned-decoy-'));
    const target = await mkdtemp(join(tmpdir(), 'rcl-pinned-target-'));
    const gitAt = async (cwd: string, ...args: string[]) =>
      (await exec('git', args, { cwd, env: fixtureEnvironment() })).stdout.trim();
    const createFixture = async (cwd: string, repo: string) => {
      await gitAt(cwd, 'init', '--template=', '-q');
      await gitAt(cwd, 'config', 'user.email', 'test@example.com');
      await gitAt(cwd, 'config', 'user.name', 'Test');
      await gitAt(cwd, 'remote', 'add', 'origin', `git@github.com:o/${repo}.git`);
      await writeFile(join(cwd, 'a.ex'), `${repo}-old\n`);
      await gitAt(cwd, 'add', '.');
      await gitAt(cwd, 'commit', '-qm', 'base');
      const baseSha = await gitAt(cwd, 'rev-parse', 'HEAD');
      await writeFile(join(cwd, 'a.ex'), `${repo}-new\n`);
      await gitAt(cwd, 'add', '.');
      await gitAt(cwd, 'commit', '-qm', 'head');
      return { baseSha, headSha: await gitAt(cwd, 'rev-parse', 'HEAD') };
    };
    const decoyState = async () => ({
      config: await readFile(join(decoy, '.git', 'config'), 'utf8'),
      head: await gitAt(decoy, 'rev-parse', 'HEAD'),
      index: await readFile(join(decoy, '.git', 'index')),
    });
    try {
      await createFixture(decoy, 'decoy');
      const before = await decoyState();
      const decoyGit = join(decoy, '.git');
      for (const [key, value] of Object.entries({
        GIT_DIR: decoyGit, GIT_COMMON_DIR: decoyGit, GIT_WORK_TREE: decoy,
        GIT_INDEX_FILE: join(decoyGit, 'index'), GIT_OBJECT_DIRECTORY: join(decoyGit, 'objects'),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoyGit, 'objects'),
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url',
        GIT_CONFIG_VALUE_0: 'git@github.com:o/injected.git',
        GIT_TRACE: join(decoy, 'inherited-trace'),
      })) vi.stubEnv(key, value);
      // Only disposable paths are ever injected, including during fixture
      // setup, so a regression cannot mutate the developer's checkout.
      const targetFixture = await createFixture(target, 'r').catch(error => error as Error);
      expect(await decoyState()).toEqual(before);
      expect(targetFixture).not.toBeInstanceOf(Error);
      if (targetFixture instanceof Error) throw targetFixture;

      const result = await loadPinnedGitDiff({ cwd: target, owner: 'o', repo: 'r', ...targetFixture })
        .catch(error => error as Error);

      expect(await decoyState()).toEqual(before);
      await expect(access(join(decoy, 'inherited-trace'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result).toMatchObject({ mergeBaseSha: targetFixture.baseSha,
        files: [{ filename: 'a.ex', patch: '@@ -1 +1 @@\n-r-old\n+r-new\n' }] });
    } finally {
      await rm(decoy, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it.each(['commit', 'blob'] as const)('does not invoke a promisor transport for a missing %s', async missing => {
    const cwd = await mkdtemp(join(tmpdir(), 'rcl-pinned-offline-'));
    const fixtureEnv = fixtureEnvironment();
    const git = async (...args: string[]) => (await exec('git', args, { cwd, env: fixtureEnv })).stdout.trim();
    try {
      await git('init', '-q');
      await git('config', 'user.email', 'test@example.com');
      await git('config', 'user.name', 'Test');
      await git('config', 'gc.auto', '0');
      await git('remote', 'add', 'origin', 'git@github.com:o/r.git');
      await writeFile(join(cwd, 'a.ex'), 'old\n');
      await git('add', '.');
      await git('commit', '-qm', 'base');
      const baseSha = await git('rev-parse', 'HEAD');
      await writeFile(join(cwd, 'a.ex'), 'new\n');
      await git('add', '.');
      await git('commit', '-qm', 'head');
      const headSha = await git('rev-parse', 'HEAD');
      const missingSha = missing === 'commit' ? headSha : await git('rev-parse', `${headSha}:a.ex`);
      // Model a non-shallow partial clone: ancestry is present, but an object
      // is promised by the remote. The transport probe records attempts and
      // exits locally; the regression itself can never access the network.
      await git('config', 'remote.origin.promisor', 'true');
      await git('config', 'remote.origin.partialclonefilter', 'blob:none');
      const objectPath = join(cwd, '.git', 'objects', missingSha.slice(0, 2), missingSha.slice(2));
      await rm(objectPath);
      const attempted = join(cwd, 'transport-attempted');
      const probe = join(cwd, 'transport-probe.cjs');
      await writeFile(probe, `require('node:fs').appendFileSync(${JSON.stringify(attempted)}, 'attempt\\n'); process.exit(1);\n`);
      vi.stubEnv('GIT_CONFIG_GLOBAL', nullDevice);
      vi.stubEnv('GIT_CONFIG_SYSTEM', nullDevice);
      await git('config', 'core.sshCommand', `"${process.execPath}" "${probe}"`);
      vi.stubEnv('GIT_NO_LAZY_FETCH', '0');
      vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ssh');
      const configBefore = await readFile(join(cwd, '.git', 'config'), 'utf8');

      const result = await loadPinnedGitDiff({ cwd, owner: 'o', repo: 'r', baseSha, headSha }).catch(error => error);

      await expect(access(attempted)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(objectPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(cwd, '.git', 'config'), 'utf8')).toBe(configBefore);
      expect(result).toBeInstanceOf(PinnedGitObjectsUnavailableError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
