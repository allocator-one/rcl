import { lstat, mkdir } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { dirname } from 'node:path';
import { platformPath } from '../../telemetry/recovery/files.js';
import { lockSystemCommand } from './lock-scope.js';

interface DirectoryMetadata { uid: number; mode: number; isDirectory: () => boolean; isSymbolicLink: () => boolean }

export function checkLockDirectory(info: DirectoryMetadata, uid: number, privateRoot: boolean): void {
  const mode = info.mode & 0o7777;
  if (!info.isDirectory() || info.isSymbolicLink() ||
      (privateRoot ? info.uid !== uid || mode !== 0o700 :
        (info.uid !== 0 && info.uid !== uid) || ((mode & 0o022) !== 0 && !(info.uid === 0 && (mode & 0o1000) !== 0)))) {
    throw new Error(privateRoot ? 'unsafe_recovery_lock_root' : 'unsafe_recovery_lock_ancestor');
  }
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
    checkLockDirectory(info, uid, privateRoot && current === path);
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
