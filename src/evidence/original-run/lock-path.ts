import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { dirname } from 'node:path';
import { platformPath } from '../../telemetry/recovery/files.js';
import { lockSystemCommand } from './lock-scope.js';

interface DirectoryMetadata { uid: number; mode: number; isDirectory: () => boolean; isSymbolicLink: () => boolean }

/**
 * An ancestor may be group-writable only when the group is the owner's own
 * user-private group (`privateGroup`, see isUserPrivateGroup): Ubuntu's umask
 * 002 leaves checkouts at 775 with a group nobody else belongs to. World-write,
 * a root-owned group-writable directory (even for a root caller) and the
 * private root stay refused either way.
 */
export function checkLockDirectory(info: DirectoryMetadata, uid: number, privateRoot: boolean, privateGroup = false): void {
  const mode = info.mode & 0o7777;
  const ownGroupWrite = privateGroup && info.uid === uid && uid !== 0 ? 0o020 : 0;
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (privateRoot ? info.uid !== uid || mode !== 0o700 :
        (info.uid !== 0 && info.uid !== uid) || ((mode & 0o022 & ~ownGroupWrite) !== 0 && !(info.uid === 0 && (mode & 0o1000) !== 0)))) {
    throw new Error(privateRoot ? 'unsafe_recovery_lock_root' : 'unsafe_recovery_lock_ancestor');
  }
}

type AccountReader = (path: string) => Promise<string>;
const accountRows = async (read: AccountReader, path: string): Promise<string[][]> =>
  (await read(path)).split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(':'));

// Scope of the private-group claim: local files, the listed userdb locations, no ACL. The
// local files must answer passwd and group lookups (`files` listed in both), and no other
// source (sss, ldap, nis, compat, winbind…) may answer any lookup, since it can add members
// these files do not list. nss-systemd may follow `files`; it adds users and memberships from
// userdb records, so it counts as local only while none of the userdb directories below holds
// a record and no systemd-homed socket exists. A userdb service that registers elsewhere, or
// a daemon added after this check, is outside the claim.
const localAccountSources = new Set(['files', 'systemd']);
const userdbDirectories = ['/etc/userdb', '/run/userdb', '/run/host/userdb', '/usr/lib/userdb', '/usr/local/lib/userdb'];
const userdbServiceDirectory = '/run/systemd/userdb'; const homedService = 'io.systemd.Home';
type DirectoryLister = (path: string) => Promise<string[]>;
async function usesOnlyLocalAccounts(read: AccountReader, list: DirectoryLister): Promise<boolean> {
  const lines = (await read('/etc/nsswitch.conf')).split('\n').map(line => line.replace(/#.*/, '').trim());
  // A line spelled other than `name: sources`, or a repeated one, is read differently by glibc; null fails closed.
  const sourcesOf = (database: string): string[] | undefined | null => {
    const matches = lines.filter(candidate => new RegExp(`^${database}\\s*:`).test(candidate));
    if (matches.length === 0) return undefined;
    if (matches.length > 1 || !matches[0]!.startsWith(`${database}:`)) return null;
    return matches[0]!.slice(database.length + 1).replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean);
  };
  // glibc falls back to the group database when there is no initgroups line.
  const initgroups = sourcesOf('initgroups');
  if (initgroups === null) return false;
  const databases = [sourcesOf('passwd'), sourcesOf('group'), initgroups ?? []];
  if (databases.slice(0, 2).some(sources => !sources?.includes('files')) || databases.some(sources => sources!.some(source => !localAccountSources.has(source)))) return false;
  if (!databases.some(sources => sources!.includes('systemd'))) return true;
  for (const directory of userdbDirectories) {
    try { if ((await list(directory)).length > 0) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  }
  try { if ((await list(userdbServiceDirectory)).includes(homedService)) return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  return true;
}

/**
 * True when `gid` is the primary group of `uid` and nobody else is in it, as
 * with Debian/Ubuntu user-private groups. The claim covers local files, the
 * listed userdb locations and no ACL (checked by the caller), nothing more. It
 * reads only /etc/passwd, /etc/group, /etc/nsswitch.conf and the systemd userdb
 * locations, and answers false when any is unreadable, when `files` is not
 * listed for passwd and group or another source answers a lookup, when a userdb
 * record or a systemd-homed socket exists, when a username or the owner's uid
 * appears twice in /etc/passwd, when an id is not plain decimal (ids compare as
 * numbers, so 01000 is 1000), when /etc/group holds a group password hash, when the
 * owner is not shown and for root or group 0. A password kept in /etc/gshadow is not readable
 * without root and stays outside the claim.
 */
export async function isUserPrivateGroup(uid: number, gid: number, read: AccountReader = path => readFile(path, 'utf8'),
  list: DirectoryLister = path => readdir(path)): Promise<boolean> {
  if (uid === 0 || gid === 0) return false;
  try {
    if (!await usesOnlyLocalAccounts(read, list)) return false;
    const passwd = await accountRows(read, '/etc/passwd'); const groups = await accountRows(read, '/etc/group');
    // Compare parsed ids: "01000" and "1000" name the same account or group; anything not plain decimal fails closed.
    const id = (value: string | undefined): number => /^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN;
    if (passwd.some(row => Number.isNaN(id(row[2])) || Number.isNaN(id(row[3]))) || groups.some(row => Number.isNaN(id(row[2])))) return false;
    const owner = passwd.find(row => id(row[2]) === uid);
    if (new Set(passwd.map(row => row[0])).size !== passwd.length || passwd.filter(row => id(row[2]) === uid).length > 1) return false;
    // A password hash in /etc/group lets anyone who knows it join through newgrp; `x` defers to gshadow, which a
    // non-root process cannot read, so a shadowed password is outside the claim.
    const matching = groups.filter(row => id(row[2]) === gid);
    if (matching.some(row => !['', 'x', '!', '*'].includes(row[1] ?? ''))) return false;
    return owner !== undefined && id(owner[3]) === gid && matching.length > 0 &&
      passwd.every(row => id(row[3]) !== gid || row === owner) &&
      matching.every(row => (row[3] ?? '').split(',').every(member => member === '' || member === owner[0]));
  } catch { return false; }
}

/**
 * A POSIX ACL (`+` after the mode in `ls -ld`) can give another user write access
 * while the group bits only show the ACL mask, so it voids the private-group exemption.
 */
export function checkLinuxLockACL(output: string): void {
  if (!/^d[rwxstST-]{9}[. ]/.test(output.split('\n')[0] ?? '')) throw new Error('unsafe_recovery_lock_acl');
}

async function hasNoLinuxLockACL(path: string): Promise<boolean> {
  try { checkLinuxLockACL(await lockSystemCommand('/bin/ls', ['-ld', path])); return true; } catch { return false; }
}

/** Darwin ACL allow entries can grant access despite mode 0700. Deny-only ACLs are safe. */
export function checkDarwinLockACL(output: string): void {
  const [header, ...entries] = output.trimEnd().split('\n');
  if (!/^d[rwxstST-]{9}[+@ ]/.test(header ?? '') ||
      entries.some(line => !/^\s*\d+: .+ deny [a-z_,]+$/.test(line)) ||
      (header[10] === '+' && entries.length === 0)) throw new Error('unsafe_recovery_lock_acl');
}

/** Match path-bound statfs information from df, including firmlink/case aliases. */
export function checkDarwinLockMount(output: string, filesystemOutput: string): void {
  let filesystems;
  try { filesystems = JSON.parse(filesystemOutput)?.['storage-system-information']?.filesystem; }
  catch { throw new Error('unsupported_recovery_lock_filesystem'); }
  if (!Array.isArray(filesystems) || filesystems.length !== 1 ||
      typeof filesystems[0]?.name !== 'string' || !filesystems[0].name || /[\r\n\0]/.test(filesystems[0].name) ||
      typeof filesystems[0]?.['mounted-on'] !== 'string' || !filesystems[0]['mounted-on'].startsWith('/') ||
      /[\r\n\0]/.test(filesystems[0]['mounted-on'])) throw new Error('unsupported_recovery_lock_filesystem');
  const filesystem = filesystems[0];
  let selected: string[] | undefined;
  for (const line of output.trimEnd().split('\n')) {
    if (line.indexOf(' on ') !== line.lastIndexOf(' on ')) throw new Error('unsupported_recovery_lock_filesystem');
    const match = /^(.+) on (\/.*) \(([^\n]+)\)$/.exec(line);
    if (!match) throw new Error('unsupported_recovery_lock_filesystem');
    if (match[1] === filesystem.name && match[2] === filesystem['mounted-on']) {
      if (selected) throw new Error('unsupported_recovery_lock_filesystem');
      selected = match[3]!.split(', ');
    }
  }
  if (!selected || !['apfs', 'hfs'].includes(selected[0]!) || !selected.includes('local') || selected.includes('noowners')) {
    throw new Error('unsupported_recovery_lock_filesystem');
  }
}

export function checkLinuxLockFilesystem(type: bigint): void {
  // ext2/3/4, tmpfs, XFS and Btrfs. Network, FUSE, overlay and unknown storage
  // need separate qualification; a PID namespace match does not qualify them.
  if (![0xef53n, 0x01021994n, 0x58465342n, 0x9123683en].includes(type)) throw new Error('unsupported_recovery_lock_filesystem');
}

/** Inspect existing recovery storage without creating or adopting missing state. */
export function inspectRecoveryDirectory(input: string, privateRoot: boolean): Promise<string> {
  return recoveryDirectory(input, privateRoot, false);
}

/** Validate before creating children, then recheck after concurrent mkdir. */
export function prepareLockRoot(input: string): Promise<string> {
  return recoveryDirectory(input, true, true);
}

async function recoveryDirectory(input: string, privateRoot: boolean, createMissing: boolean): Promise<string> {
  const path = platformPath(input); const uid = process.geteuid?.();
  if (uid === undefined || /[\r\n]/.test(path)) throw new Error('unsafe_recovery_lock_root');
  const chain: string[] = [];
  for (let current = path;; current = dirname(current)) { chain.unshift(current); if (dirname(current) === current) break; }
  for (const current of chain) {
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!createMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      info = await lstat(current);
    }
    const groupWritable = !(privateRoot && current === path) && process.platform === 'linux' && info.uid === uid && uid !== 0 && (info.mode & 0o020) !== 0;
    try {
      checkLockDirectory(info, uid, privateRoot && current === path,
        groupWritable && await isUserPrivateGroup(uid, info.gid) && await hasNoLinuxLockACL(current));
    }
    catch (error) {
      if ((error as Error).message === 'unsafe_recovery_lock_ancestor') {
        const mode = (info.mode & 0o7777).toString(8);
        throw new Error(`unsafe_recovery_lock_ancestor: ${current} is owned by uid ${info.uid} with mode ${mode}; ` +
          'remove group and other write access (chmod go-w) or use a recovery directory under a directory only you can write');
      }
      throw error;
    }
    if (process.platform === 'darwin') {
      checkDarwinLockACL(await lockSystemCommand('/bin/ls', ['-lde', current]));
    }
  }
  if (process.platform === 'darwin') {
    try {
      const filesystem = await lockSystemCommand('/bin/df', ['--libxo', 'json', '-P', '-k', path]);
      checkDarwinLockMount(await lockSystemCommand('/sbin/mount', []), filesystem);
    } catch { throw new Error('unsupported_recovery_lock_filesystem'); }
  }
  else if (process.platform === 'linux' && typeof filesystem.statfs === 'function') checkLinuxLockFilesystem((await filesystem.statfs(path, { bigint: true })).type);
  else throw new Error('unsupported_recovery_lock_filesystem');
  return path;
}
