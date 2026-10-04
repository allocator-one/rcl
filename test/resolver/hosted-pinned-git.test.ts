import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access } from 'node:fs/promises';
import { loadHostedPinnedGitDiff } from '../../src/resolver/git.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), oversizedStorage: false }));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: mocks.spawn,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => mocks.oversizedStorage
      ? Promise.resolve([{ name: 'oversized.pack', isDirectory: () => false }]) : actual.readdir(...args),
    stat: (...args: Parameters<typeof actual.stat>) => mocks.oversizedStorage
      ? Promise.resolve({ size: 512 * 1024 * 1024 + 1 }) : actual.stat(...args),
  };
});

const headSha = 'b'.repeat(40), baseSha = 'a'.repeat(40), expectedMergeBaseSha = 'c'.repeat(40);
const token = 'private-test-token';
const origin = 'https://github.com/o/r.git';
const rawDiff = `diff --git a/a.ex b/a.ex
index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644
--- a/a.ex
+++ b/a.ex
@@ -1 +1 @@
-old
+new
`;
const input = () => ({ owner: 'o', repo: 'r', baseSha, headSha, expectedMergeBaseSha, token });
let failFetch = false, wrongCommit = false, pauseFetch = false;

beforeEach(() => {
  mocks.oversizedStorage = false;
  failFetch = false; wrongCommit = false; pauseFetch = false;
  mocks.spawn.mockReset().mockImplementation((_command, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; }),
    });
    queueMicrotask(() => {
      if (args.includes('fetch') && pauseFetch) return;
      if (args.includes('fetch') && failFetch) {
        child.stderr.write(`fatal: rejected ${token}`);
        child.emit('close', 1);
        return;
      }
      if (args.includes('config')) child.stdout.write(`${origin}\n`);
      if (args.includes('rev-parse')) child.stdout.write(`${wrongCommit ? baseSha : args.at(-1)!.split('^')[0]}\n`);
      if (args.includes('diff')) child.stdout.write(rawDiff);
      child.emit('close', 0);
    });
    return child;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function expectRemoved() {
  const cwd = mocks.spawn.mock.calls[0]![2].cwd as string;
  await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('hosted pinned PR object acquisition', () => {
  it('fetches exact snapshots without checkout and removes the private object database', async () => {
    const diff = await loadHostedPinnedGitDiff(input());
    expect(diff).toMatchObject({ mergeBaseSha: expectedMergeBaseSha,
      files: [{ filename: 'a.ex', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new\n' }] });
    const fetch = mocks.spawn.mock.calls.find(([, args]) => args.includes('fetch'))!;
    expect(fetch[1]).toEqual(expect.arrayContaining(['--depth=1', '--no-tags', '--no-recurse-submodules',
      '--no-write-fetch-head', '--no-auto-maintenance', 'origin', headSha, expectedMergeBaseSha]));
    expect(mocks.spawn.mock.calls.flatMap(([, args]) => args)).not.toContain('checkout');
    expect(mocks.spawn.mock.calls.flatMap(([, args]) => args)).not.toContain('merge-base');
    await expectRemoved();
  });

  it('keeps authentication only in the child environment and disables inherited Git execution settings', async () => {
    vi.stubEnv('GIT_TRACE', '1');
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'credential.helper=!unsafe'");
    await loadHostedPinnedGitDiff(input());
    for (const [command, args, options] of mocks.spawn.mock.calls) {
      expect(command).toBe('git');
      expect(JSON.stringify(args)).not.toContain(token);
      expect(options.env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
      expect(options.env.GIT_CONFIG_KEY_0).toBe(`http.${origin}.extraHeader`);
      expect(options.env.GIT_TRACE).toBeUndefined();
      expect(options.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(options.env.GIT_ALLOW_PROTOCOL).toBe('https');
      expect(args).toEqual(expect.arrayContaining([`core.hooksPath=${options.cwd}/disabled-hooks`, 'credential.helper=', 'http.followRedirects=false']));
    }
  });

  it('redacts a failed fetch and still removes all temporary objects', async () => {
    failFetch = true;
    const error = await loadHostedPinnedGitDiff(input()).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('Hosted PR Git acquisition failed');
    expect(String(error)).not.toContain(token);
    await expectRemoved();
  });

  it('refuses a wrong fetched commit before reading a patch', async () => {
    wrongCommit = true;
    await expect(loadHostedPinnedGitDiff(input())).rejects.toThrow('exact comparison commits');
    expect(mocks.spawn.mock.calls.some(([, args]) => args.includes('diff'))).toBe(false);
    await expectRemoved();
  });

  it('enforces the output byte bound without returning a truncated patch', async () => {
    await expect(loadHostedPinnedGitDiff({ ...input(), maxBytes: 32 })).rejects.toThrow('output bound');
    await expectRemoved();
  });

  it('refuses retained objects above the finite storage bound', async () => {
    mocks.oversizedStorage = true;
    await expect(loadHostedPinnedGitDiff(input())).rejects.toThrow('object storage bound');
    await expectRemoved();
  });

  it('terminates an unresponsive fetch at the shared acquisition deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    pauseFetch = true;
    const pending = loadHostedPinnedGitDiff(input());
    const assertion = expect(pending).rejects.toThrow('time bound');
    await vi.waitFor(() => expect(mocks.spawn.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(true));
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
    await expectRemoved();
  });

  it('rejects invalid origins, revisions and capacities before starting a process', async () => {
    await expect(loadHostedPinnedGitDiff({ ...input(), owner: 'o@evil.example/' })).rejects.toThrow('requires');
    await expect(loadHostedPinnedGitDiff({ ...input(), expectedMergeBaseSha: 'HEAD' })).rejects.toThrow('requires');
    await expect(loadHostedPinnedGitDiff({ ...input(), maxBytes: Number.NaN })).rejects.toThrow('capacity');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
