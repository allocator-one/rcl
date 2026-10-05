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

describe('local pinned PR reads stay offline', () => {
  it.each(['commit', 'blob'] as const)('does not invoke a promisor transport for a missing %s', async missing => {
    const cwd = await mkdtemp(join(tmpdir(), 'rcl-pinned-offline-'));
    const fixtureEnv = { ...process.env, GIT_CONFIG_GLOBAL: nullDevice, GIT_CONFIG_SYSTEM: nullDevice };
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
      vi.stubEnv('GIT_SSH_COMMAND', `"${process.execPath}" "${probe}"`);
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
