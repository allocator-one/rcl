import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { localLockScope } from '../../src/evidence/original-run/lock-scope.js';
import * as lockScope from '../../src/evidence/original-run/lock-scope.js';
import { checkDarwinLockACL, checkDarwinLockMount, checkLinuxLockFilesystem, checkLockDirectory, inspectRecoveryDirectory } from '../../src/evidence/original-run/lock-path.js';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';
import { platformPath } from '../../src/telemetry/recovery/files.js';

const boot = '00000000-0000-4000-8000-000000000001';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'rcl-lock-platform-')); roots.push(path); return path; }
const filesystem = (name: string, mounted: string) => JSON.stringify({
  'storage-system-information': { filesystem: [{ name, 'mounted-on': mounted }] },
});

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

it('qualifies the path-bound Darwin mount by exact source, mountpoint and local/ownership flags', () => {
  const mount = '/dev/disk on / (apfs, local, journaled)\n';
  expect(() => checkDarwinLockMount(mount, filesystem('/dev/disk', '/'))).not.toThrow();
  for (const flags of ['nfs, local', 'apfs, local, noowners', 'apfs, journaled', 'smbfs, local']) {
    expect(() => checkDarwinLockMount(mount + `server on /private/tmp (${flags})\n`, filesystem('server', '/private/tmp'))).toThrow('unsupported_recovery_lock_filesystem');
  }
  expect(() => checkDarwinLockMount('unrecognized', filesystem('/dev/disk', '/'))).toThrow('unsupported_recovery_lock_filesystem');
  expect(() => checkDarwinLockMount(mount + 'server on /tmp/a on /b (nfs, local)\n', filesystem('/dev/disk', '/'))).toThrow('unsupported_recovery_lock_filesystem');
});

it('keeps firmlink and case-alias attribution independent of the operator path spelling', () => {
  const mount = '/dev/root on / (apfs, local)\n/dev/data on /System/Volumes/Data (apfs, local)\nserver on /Users/Shared (nfs, local)\n';
  expect(() => checkDarwinLockMount(mount, filesystem('/dev/data', '/System/Volumes/Data'))).not.toThrow();
  expect(() => checkDarwinLockMount(mount, filesystem('server', '/Users/Shared'))).toThrow('unsupported_recovery_lock_filesystem');
  expect(() => checkDarwinLockMount(mount, filesystem('server', '/users/Shared'))).toThrow('unsupported_recovery_lock_filesystem');
});

it('refuses malformed, missing or ambiguous path-bound filesystem attribution without ancestor fallback', () => {
  const mount = '/dev/root on / (apfs, local)\n';
  for (const value of ['{', 'null', '{}', JSON.stringify({ 'storage-system-information': { filesystem: [] } }),
    JSON.stringify({ 'storage-system-information': { filesystem: [{ name: '/dev/root', 'mounted-on': '/' }, { name: '/dev/root', 'mounted-on': '/' }] } }),
    filesystem('/dev/other', '/'), filesystem('/dev/root', '/Other'), filesystem('/dev/root', 'relative'), filesystem('/dev/root\n', '/')]) {
    expect(() => checkDarwinLockMount(mount, value)).toThrow('unsupported_recovery_lock_filesystem');
  }
  expect(() => checkDarwinLockMount(mount + mount, filesystem('/dev/root', '/'))).toThrow('unsupported_recovery_lock_filesystem');
});

it('preserves spaces and parentheses while refusing ambiguous mount delimiters', () => {
  const name = '/dev/volume (backup)'; const path = '/Volumes/Local (apfs, local)';
  expect(() => checkDarwinLockMount(`${name} on ${path} (hfs, local)\n`, filesystem(name, path))).not.toThrow();
  expect(() => checkDarwinLockMount(`${name} on ${path} (nfs, local)\n`, filesystem(name, path))).toThrow('unsupported_recovery_lock_filesystem');
  expect(() => checkDarwinLockMount('disk on name on / (apfs, local)\n', filesystem('disk on name', '/'))).toThrow('unsupported_recovery_lock_filesystem');
});

it.runIf(process.platform === 'darwin').each(['apfs, local, noowners', 'nfs, local'])(
  'refuses work when the actual filesystem behind a firmlink has %s flags', async flags => {
    const path = await root(); const work = vi.fn(); const command = lockScope.lockSystemCommand;
    vi.spyOn(lockScope, 'lockSystemCommand').mockImplementation(async (file, args) => {
      if (file === '/sbin/mount') return `/dev/root on / (apfs, local)\n/dev/data on /System/Volumes/Data (${flags})\n`;
      if (file === '/bin/df') return filesystem('/dev/data', '/System/Volumes/Data');
      return command(file, args);
    });
    await expect(withRecoveryLock(path, 'run', work)).rejects.toThrow('unsupported_recovery_lock_filesystem');
    expect(work).not.toHaveBeenCalled(); expect(await readdir(path)).toEqual([]);
  },
);

it.runIf(process.platform === 'darwin')('queries the existing normalized directory and refuses unavailable structured inspection', async () => {
  const path = await root(); const command = lockScope.lockSystemCommand;
  const inspected: string[][] = [];
  vi.spyOn(lockScope, 'lockSystemCommand').mockImplementation(async (file, args) => {
    if (file === '/bin/df') { inspected.push(args); throw new Error('synthetic unavailable option'); }
    return command(file, args);
  });
  await expect(inspectRecoveryDirectory(path, true)).rejects.toThrow('unsupported_recovery_lock_filesystem');
  expect(inspected).toEqual([['--libxo', 'json', '-P', '-k', platformPath(path)]]);
  expect(await readdir(path)).toEqual([]);
});

it('refuses network, FUSE and unqualified Linux filesystems', () => {
  for (const type of [0xef53n, 0x01021994n, 0x58465342n, 0x9123683en]) expect(() => checkLinuxLockFilesystem(type)).not.toThrow();
  for (const type of [0x6969n, 0x517bn, 0xfe534d42n, 0x65735546n, 0x794c7630n, 123n]) expect(() => checkLinuxLockFilesystem(type)).toThrow('unsupported_recovery_lock_filesystem');
});
