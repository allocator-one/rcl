import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { localLockScope } from '../../src/evidence/original-run/lock-scope.js';
import { checkDarwinLockACL, checkDarwinLockMount, checkLinuxLockFilesystem, checkLockDirectory } from '../../src/evidence/original-run/lock-path.js';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';

const boot = '00000000-0000-4000-8000-000000000001';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'rcl-lock-platform-')); roots.push(path); return path; }

it('binds Darwin scope to a validated boot UUID from the absolute system utility', async () => {
  const command = vi.fn(async () => boot.toUpperCase() + '\n');
  await expect(localLockScope({ platform: 'darwin', command })).resolves.toEqual({ platform: 'darwin', boot, namespace: 'native' });
  expect(command).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
});

it('binds Linux scope to boot and the PID namespace device/inode', async () => {
  await expect(localLockScope({ platform: 'linux', boot: async () => boot + '\n', namespace: async () => ({ dev: 4n, ino: 123456n }) })).resolves.toEqual({ platform: 'linux', boot, namespace: '4:123456' });
});

it.each(['unavailable', 'malformed', 'oversized'])('refuses %s scope inspection', async kind => {
  await expect(localLockScope({ platform: 'darwin', command: async () => {
    if (kind === 'unavailable') throw new Error('ENOENT'); return kind === 'malformed' ? 'hostname' : 'x'.repeat(1024);
  } })).rejects.toThrow('unsupported_recovery_lock_scope');
});

it('refuses unsupported platforms and unobservable Linux namespaces', async () => {
  await expect(localLockScope({ platform: 'win32' })).rejects.toThrow('unsupported_recovery_lock_scope');
  await expect(localLockScope({ platform: 'linux', boot: async () => boot, namespace: async () => { throw new Error('EACCES'); } })).rejects.toThrow('unsupported_recovery_lock_scope');
});

it.each([
  { uid: 501, mode: 0o700, private: true, safe: true },
  { uid: 501, mode: 0o755, private: true, safe: false },
  { uid: 999, mode: 0o700, private: true, safe: false },
  { uid: 0, mode: 0o755, private: false, safe: true },
  { uid: 0, mode: 0o1777, private: false, safe: true },
  { uid: 0, mode: 0o777, private: false, safe: false },
  { uid: 501, mode: 0o1777, private: false, safe: false },
  { uid: 501, mode: 0o770, private: false, safe: false },
  { uid: 999, mode: 0o755, private: false, safe: false },
])('checks directory ownership and modes: $uid/$mode/private=$private', item => {
  const check = () => checkLockDirectory({ ...item, isDirectory: () => true, isSymbolicLink: () => false }, 501, item.private);
  if (item.safe) expect(check).not.toThrow(); else expect(check).toThrow(/unsafe_recovery_lock_/);
});

it('refuses writable ancestors before creating a private child root', async () => {
  const parent = await root(); await chmod(parent, 0o777); const work = vi.fn();
  await expect(withRecoveryLock(join(parent, 'child'), 'run', work)).rejects.toThrow('unsafe_recovery_lock_ancestor');
  expect(work).not.toHaveBeenCalled(); expect(await readdir(parent)).toEqual([]);
});

it('refuses arbitrary directory symlinks instead of canonicalizing them into acceptance', async () => {
  const parent = await root(); await mkdir(join(parent, 'real'), { mode: 0o700 }); await symlink(join(parent, 'real'), join(parent, 'alias'));
  const work = vi.fn(); await expect(withRecoveryLock(join(parent, 'alias'), 'run', work)).rejects.toThrow('unsafe_recovery_lock_root');
  expect(work).not.toHaveBeenCalled();
});

it('accepts ordinary restrictive Darwin ACLs and rejects grants or unknown ACL output', () => {
  expect(() => checkDarwinLockACL('drwx------+ 2 user staff 64 Sep 22 12:00 /tmp/example\n 0: group:everyone deny delete\n')).not.toThrow();
  for (const acl of [' 0: group:everyone allow add_file,delete_child', 'unknown output', '']) {
    expect(() => checkDarwinLockACL('drwx------+ 2 user staff 64 Sep 22 12:00 /tmp/example\n' + acl)).toThrow('unsafe_recovery_lock_acl');
  }
});

it.runIf(process.platform === 'darwin')('refuses a real harmful macOS ACL even while mode remains 0700', async () => {
  const path = await root(); await promisify(execFile)('/bin/chmod', ['+a', 'everyone allow add_file,delete_child', path]);
  try {
    const work = vi.fn(); await expect(withRecoveryLock(path, 'run', work)).rejects.toThrow('unsafe_recovery_lock_acl'); expect(work).not.toHaveBeenCalled();
  } finally { await promisify(execFile)('/bin/chmod', ['-N', path]); }
});

it('qualifies Darwin mounts by name and local/ownership flags with the longest mount match', () => {
  const mount = '/dev/disk on / (apfs, local, journaled)\n';
  expect(() => checkDarwinLockMount('/private/tmp', mount)).not.toThrow();
  for (const flags of ['nfs, local', 'apfs, local, noowners', 'apfs, journaled', 'smbfs, local']) {
    expect(() => checkDarwinLockMount('/private/tmp/root', mount + `server on /private/tmp (${flags})\n`)).toThrow('unsupported_recovery_lock_filesystem');
  }
  expect(() => checkDarwinLockMount('/tmp', 'unrecognized')).toThrow('unsupported_recovery_lock_filesystem');
  expect(() => checkDarwinLockMount('/tmp/a on /b', mount + 'server on /tmp/a on /b (nfs, local)\n')).toThrow('unsupported_recovery_lock_filesystem');
});

it('refuses network, FUSE and unqualified Linux filesystems', () => {
  for (const type of [0xef53n, 0x01021994n, 0x58465342n, 0x9123683en]) expect(() => checkLinuxLockFilesystem(type)).not.toThrow();
  for (const type of [0x6969n, 0x517bn, 0xfe534d42n, 0x65735546n, 0x794c7630n, 123n]) expect(() => checkLinuxLockFilesystem(type)).toThrow('unsupported_recovery_lock_filesystem');
});
