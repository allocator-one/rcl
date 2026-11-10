import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as lockScope from '../../src/evidence/original-run/lock-scope.js';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';

// Controlled /etc account databases, so the group-writable ancestor path runs whatever the host's account setup.
const accounts = vi.hoisted(() => ({ files: new Map<string, string>() }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((path: string, ...rest: unknown[]) => accounts.files.has(path) ? Promise.resolve(accounts.files.get(path)) :
    (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFile;
  const readdir = ((path: string, ...rest: unknown[]) => /userdb$/.test(path) ?
    Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) :
    (actual.readdir as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.readdir;
  return { ...actual, readFile, readdir };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); accounts.files.clear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function writableParent(group: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'rcl-lock-private-group-')); roots.push(parent); await chmod(parent, 0o775);
  const { gid } = await stat(parent); const uid = process.geteuid!();
  accounts.files.set('/etc/passwd', `ann:x:${uid}:${gid}::/home/ann:/bin/sh\n`);
  accounts.files.set('/etc/group', group.replace('GID', String(gid)));
  accounts.files.set('/etc/nsswitch.conf', 'passwd: files\ngroup: files\n');
  const command = lockScope.lockSystemCommand;
  vi.spyOn(lockScope, 'lockSystemCommand').mockImplementation(async (file, args, timeout) =>
    file === '/bin/ls' && args.at(-1) === parent ? `drwxrwxr-x 2 ann ann 4096 Nov 10 04:00 ${parent}\n` : command(file, args, timeout));
  return parent;
}

it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('acquires the lock under a group-writable ancestor whose group only the owner is in', async () => {
  const parent = await writableParent('ann:x:GID:\n'); const work = vi.fn(async () => undefined);
  await withRecoveryLock(join(parent, 'child'), 'run', work);
  expect(work).toHaveBeenCalledTimes(1);
});

it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('refuses the same ancestor once another user is in the group', async () => {
  const parent = await writableParent('ann:x:GID:bob\n'); const work = vi.fn(async () => undefined);
  await expect(withRecoveryLock(join(parent, 'child'), 'run', work)).rejects.toThrow(new RegExp(`unsafe_recovery_lock_ancestor.*${parent}`));
  expect(work).not.toHaveBeenCalled();
});
