import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { localLockScope } from '../../src/evidence/original-run/lock-scope.js';
import * as lockScope from '../../src/evidence/original-run/lock-scope.js';
import { checkDarwinLockACL, checkDarwinLockMount, checkLinuxLockACL, checkLinuxLockFilesystem, checkLockDirectory, inspectRecoveryDirectory, isUserPrivateGroup } from '../../src/evidence/original-run/lock-path.js';
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

it.each([
  { uid: 501, mode: 0o775, privateGroup: true, safe: true },
  { uid: 501, mode: 0o775, privateGroup: false, safe: false },
  { uid: 501, mode: 0o777, privateGroup: true, safe: false },
  { uid: 501, mode: 0o770, privateGroup: true, safe: true },
  { uid: 999, mode: 0o775, privateGroup: true, safe: false },
])('accepts a group-writable ancestor only in the owner private group: $uid/$mode/private=$privateGroup', item => {
  const info = { uid: item.uid, mode: item.mode, isDirectory: () => true, isSymbolicLink: () => false };
  const check = () => checkLockDirectory(info, 501, false, item.privateGroup);
  if (item.safe) expect(check).not.toThrow(); else expect(check).toThrow('unsafe_recovery_lock_ancestor');
});

it.each([0o775, 0o770])('refuses a root-owned group-writable ancestor for a root caller even in a private group: %o', mode => {
  const info = { uid: 0, mode, isDirectory: () => true, isSymbolicLink: () => false };
  expect(() => checkLockDirectory(info, 0, false, true)).toThrow('unsafe_recovery_lock_ancestor');
});

it('keeps the private lock root at 0700 even in a private group', () => {
  const info = { uid: 501, mode: 0o770, isDirectory: () => true, isSymbolicLink: () => false };
  expect(() => checkLockDirectory(info, 501, true, true)).toThrow('unsafe_recovery_lock_root');
});

const filesOnly = 'passwd:         files systemd\ngroup:          files systemd\n';
const files = (passwd: string, group: string, nsswitch: string | null = filesOnly) => async (path: string) => {
  if (path === '/etc/passwd') return passwd; if (path === '/etc/group') return group;
  if (path === '/etc/nsswitch.conf' && nsswitch !== null) return nsswitch; throw new Error('ENOENT');
};
const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const userdb = (entries: Record<string, string[]> = {}) => async (path: string) => {
  const found = entries[path]; if (found === undefined) throw missing; return found;
};
const noUserdb = userdb();
it.each([
  { name: 'a user-private group without members', passwd: 'ann:x:1000:1000::/home/ann:/bin/sh', group: 'ann:x:1000:', safe: true },
  { name: 'a group listing only the owner', passwd: 'ann:x:1000:1000::/home/ann:/bin/sh', group: 'ann:x:1000:ann', safe: true },
  { name: 'a group with another listed member', passwd: 'ann:x:1000:1000::/h:/bin/sh', group: 'ann:x:1000:bob', safe: false },
  { name: 'a group that is another user\'s primary group', passwd: 'ann:x:1000:1000::/h:/bin/sh\nbob:x:1001:1000::/h:/bin/sh', group: 'ann:x:1000:', safe: false },
  { name: 'a group that is not the owner primary group', passwd: 'ann:x:1000:100::/h:/bin/sh', group: 'users:x:100:\nann:x:1000:', safe: false },
  { name: 'a group missing from /etc/group', passwd: 'ann:x:1000:1000::/h:/bin/sh', group: '', safe: false },
  { name: 'an owner missing from /etc/passwd', passwd: 'bob:x:1001:1001::/h:/bin/sh', group: 'ann:x:1000:', safe: false },
])('classifies $name', async item => {
  await expect(isUserPrivateGroup(1000, 1000, files(item.passwd, item.group), noUserdb)).resolves.toBe(item.safe);
});

it.each([
  { name: 'a duplicate username with another uid', passwd: 'ann:x:1000:1000::/h:/bin/sh\nann:x:1002:1002::/h:/bin/sh' },
  { name: 'a duplicate uid', passwd: 'ann:x:1000:1000::/h:/bin/sh\nbob:x:1000:1000::/h:/bin/sh' },
])('refuses $name in /etc/passwd', async item => {
  await expect(isUserPrivateGroup(1000, 1000, files(item.passwd, 'ann:x:1000:'), noUserdb)).resolves.toBe(false);
});

it.each([
  { name: 'another user whose primary gid is a zero-padded spelling', passwd: 'ann:x:1000:1000::/h:/bin/sh\nbob:x:1001:01000::/h:/bin/sh', group: 'ann:x:1000:' },
  { name: 'a second account whose uid is a zero-padded spelling', passwd: 'ann:x:1000:1000::/h:/bin/sh\nbob:x:01000:1000::/h:/bin/sh', group: 'ann:x:1000:' },
  { name: 'a passwd row with a non-numeric id', passwd: 'ann:x:1000:1000::/h:/bin/sh\nbob:x:abc:1000::/h:/bin/sh', group: 'ann:x:1000:' },
  { name: 'a group row with a non-numeric gid', passwd: 'ann:x:1000:1000::/h:/bin/sh', group: 'ann:x:1000:\nmal:x:1x:bob' },
])('refuses $name', async item => {
  await expect(isUserPrivateGroup(1000, 1000, files(item.passwd, item.group), noUserdb)).resolves.toBe(false);
});

it('matches the owner and group across zero-padded spellings of the same id', async () => {
  await expect(isUserPrivateGroup(1000, 1000, files('ann:x:01000:001000::/h:/bin/sh', 'ann:x:01000:'), noUserdb)).resolves.toBe(true);
});

it('never treats the root account or group 0 as a user-private group', async () => {
  await expect(isUserPrivateGroup(0, 0, files('root:x:0:0:root:/root:/bin/bash', 'root:x:0:'), noUserdb)).resolves.toBe(false);
  await expect(isUserPrivateGroup(1000, 0, files('ann:x:1000:0::/h:/bin/sh', 'root:x:0:'), noUserdb)).resolves.toBe(false);
});

it.each([
  { name: 'files and systemd with a lookup action', nsswitch: 'passwd: files [NOTFOUND=return] systemd\ngroup: files systemd\n', safe: true },
  { name: 'files only', nsswitch: '# comment\npasswd: files\ngroup: files\nhosts: dns\n', safe: true },
  { name: 'an SSSD passwd source', nsswitch: 'passwd: files sss\ngroup: files systemd\n', safe: false },
  { name: 'an LDAP group source', nsswitch: 'passwd: files\ngroup: files ldap\n', safe: false },
  { name: 'a compat NIS source', nsswitch: 'passwd: compat\ngroup: compat\n', safe: false },
  { name: 'a separate initgroups source', nsswitch: 'passwd: files\ngroup: files\ninitgroups: files sss\n', safe: false },
  { name: 'a local-only initgroups line', nsswitch: 'passwd: files\ngroup: files\ninitgroups: files\n', safe: true },
  { name: 'no group line', nsswitch: 'passwd: files\n', safe: false },
  { name: 'no passwd line', nsswitch: 'group: files\n', safe: false },
  { name: 'an unreadable nsswitch.conf', nsswitch: null, safe: false },
  { name: 'systemd as the only passwd source', nsswitch: 'passwd: systemd\ngroup: files systemd\n', safe: false },
  { name: 'systemd as the only group source', nsswitch: 'passwd: files systemd\ngroup: systemd\n', safe: false },
])('requires local-file account sources: $name', async item => {
  await expect(isUserPrivateGroup(1000, 1000, files('ann:x:1000:1000::/h:/bin/sh', 'ann:x:1000:', item.nsswitch), noUserdb)).resolves.toBe(item.safe);
});

const systemdAccounts = 'passwd: files systemd\ngroup: files systemd\n';
it.each([
  { name: 'nss-systemd with no userdb records', nsswitch: systemdAccounts, dirs: {}, safe: true },
  { name: 'nss-systemd with empty userdb directories', nsswitch: systemdAccounts, dirs: { '/etc/userdb': [], '/run/userdb': [] }, safe: true },
  { name: 'nss-systemd with a userdb membership drop-in', nsswitch: systemdAccounts, dirs: { '/etc/userdb': ['ann.membership'] }, safe: false },
  { name: 'nss-systemd with a runtime userdb record', nsswitch: systemdAccounts, dirs: { '/run/userdb': ['bob.user'] }, safe: false },
  { name: 'nss-systemd with a vendor userdb record', nsswitch: systemdAccounts, dirs: { '/usr/lib/userdb': ['bob.user'] }, safe: false },
  { name: 'nss-systemd with a locally installed userdb record', nsswitch: systemdAccounts, dirs: { '/usr/local/lib/userdb': ['bob.user'] }, safe: false },
  { name: 'nss-systemd with only the stock userdb sockets', nsswitch: systemdAccounts, dirs: { '/run/systemd/userdb': ['io.systemd.DynamicUser', 'io.systemd.Multiplexer'] }, safe: true },
  { name: 'nss-systemd with a running systemd-homed socket', nsswitch: systemdAccounts, dirs: { '/run/systemd/userdb': ['io.systemd.Home'] }, safe: false },
  { name: 'files only, where userdb records are never consulted', nsswitch: 'passwd: files\ngroup: files\n', dirs: { '/etc/userdb': ['bob.user'] }, safe: true },
])('checks systemd userdb records only when nss-systemd answers lookups: $name', async item => {
  await expect(isUserPrivateGroup(1000, 1000, files('ann:x:1000:1000::/h:/bin/sh', 'ann:x:1000:', item.nsswitch), userdb(item.dirs))).resolves.toBe(item.safe);
});

it('fails closed when a userdb directory cannot be listed', async () => {
  const denied = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  await expect(isUserPrivateGroup(1000, 1000, files('ann:x:1000:1000::/h:/bin/sh', 'ann:x:1000:', systemdAccounts), denied)).resolves.toBe(false);
});

it.each([
  { name: 'a plain mode string', output: 'drwxrwxr-x 2 ann ann 4096 Nov 10 04:00 /home/ann\n', safe: true },
  { name: 'an SELinux context marker', output: 'drwxrwxr-x. 2 ann ann 4096 Nov 10 04:00 /home/ann\n', safe: true },
  { name: 'a POSIX ACL marker', output: 'drwxrwxr-x+ 2 ann ann 4096 Nov 10 04:00 /home/ann\n', safe: false },
  { name: 'unrecognised output', output: 'ls: cannot access\n', safe: false },
  { name: 'empty output', output: '', safe: false },
])('refuses a group-writable ancestor with a Linux ACL: $name', item => {
  const check = () => checkLinuxLockACL(item.output);
  if (item.safe) expect(check).not.toThrow(); else expect(check).toThrow('unsafe_recovery_lock_acl');
});

it('fails closed when the account databases are unreadable', async () => {
  await expect(isUserPrivateGroup(1000, 1000, files('', ''), noUserdb)).resolves.toBe(false);
  await expect(isUserPrivateGroup(1000, 1000, async () => { throw new Error('EACCES'); }, noUserdb)).resolves.toBe(false);
});

it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('works under a group-writable ancestor owned by this user when the group is private', async () => {
  const parent = await root(); await chmod(parent, 0o775); const work = vi.fn(async () => undefined);
  const info = await stat(parent);
  const outcome = withRecoveryLock(join(parent, 'child'), 'run', work);
  const acl = (await promisify(execFile)('/bin/ls', ['-ld', parent])).stdout.split(' ')[0]!.includes('+');
  if (!acl && await isUserPrivateGroup(info.uid, info.gid)) { await outcome; expect(work).toHaveBeenCalled(); }
  else { await expect(outcome).rejects.toThrow('unsafe_recovery_lock_ancestor'); expect(work).not.toHaveBeenCalled(); }
});

it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('refuses a group-writable ancestor that has a POSIX ACL even in a private group', async () => {
  const parent = await root(); await chmod(parent, 0o775); const work = vi.fn(async () => undefined);
  const info = await stat(parent);
  if (!await isUserPrivateGroup(info.uid, info.gid)) return;
  const command = lockScope.lockSystemCommand;
  vi.spyOn(lockScope, 'lockSystemCommand').mockImplementation(async (file, args, timeout) =>
    file === '/bin/ls' && args.at(-1) === parent ? `drwxrwxr-x+ 2 ann ann 4096 Nov 10 04:00 ${parent}\n` : command(file, args, timeout));
  await expect(withRecoveryLock(join(parent, 'child'), 'run', work)).rejects.toThrow(new RegExp(`unsafe_recovery_lock_ancestor.*${parent}`));
  expect(work).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)('names the offending path and the fix when an ancestor is group-writable for a shared group', async () => {
  const parent = await root(); await chmod(parent, 0o777); const work = vi.fn();
  await expect(withRecoveryLock(join(parent, 'child'), 'run', work)).rejects.toThrow(new RegExp(`unsafe_recovery_lock_ancestor.*${parent}.*chmod`));
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
