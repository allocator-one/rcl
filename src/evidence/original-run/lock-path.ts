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

// Only the local files may answer passwd, group and initgroups lookups. Any other source
// (sss, ldap, nis, compat, winbind…) can add members these files do not list. nss-systemd
// adds users and group memberships from userdb records, so it counts as local only while no
// userdb directory holds a record.
const localAccountSources = new Set(['files', 'systemd']);
const userdbDirectories = ['/etc/userdb', '/run/userdb', '/run/host/userdb', '/usr/lib/userdb'];
type DirectoryLister = (path: string) => Promise<string[]>;
async function usesOnlyLocalAccounts(read: AccountReader, list: DirectoryLister): Promise<boolean> {
  const lines = (await read('/etc/nsswitch.conf')).split('\n').map(line => line.replace(/#.*/, '').trim());
  const sourcesOf = (database: string): string[] | undefined => {
    const line = lines.find(candidate => candidate.startsWith(`${database}:`));
    return line?.slice(database.length + 1).replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(Boolean);
  };
  // glibc falls back to the group database when there is no initgroups line.
  const databases = [sourcesOf('passwd'), sourcesOf('group'), sourcesOf('initgroups') ?? []];
  if (databases.slice(0, 2).some(sources => !sources?.length) || databases.some(sources => sources!.some(source => !localAccountSources.has(source)))) return false;
  if (!databases.some(sources => sources!.includes('systemd'))) return true;
  for (const directory of userdbDirectories) {
    try { if ((await list(directory)).length > 0) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
  }
  return true;
}

/**
 * True when `gid` is the primary group of `uid` and nobody else is in it, as
 * with Debian/Ubuntu user-private groups. Reads only /etc/passwd, /etc/group,
 * /etc/nsswitch.conf and the systemd userdb directories; answers false when any
 * is unreadable, when the lookup order names a source other than local files,
 * when a userdb record exists, when the owner is not shown and for root or group 0.
 */
export async function isUserPrivateGroup(uid: number, gid: number, read: AccountReader = path => readFile(path, 'utf8'),
  list: DirectoryLister = path => readdir(path)): Promise<boolean> {
  if (uid === 0 || gid === 0) return false;
  try {
    if (!await usesOnlyLocalAccounts(read, list)) return false;
    const passwd = await accountRows(read, '/etc/passwd'); const groups = await accountRows(read, '/etc/group');
    const owner = passwd.find(row => row[2] === String(uid));
    const matching = groups.filter(row => row[2] === String(gid));
    return owner !== undefined && owner[3] === String(gid) && matching.length > 0 &&
      passwd.every(row => row[3] !== String(gid) || row[2] === String(uid)) &&
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
