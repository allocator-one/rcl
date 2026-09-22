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

/** Inspect the mount name/flags, not Darwin's nonportable numeric f_type. */
export function checkDarwinLockMount(path: string, output: string): void {
  let selected: { path: string; flags: string[] } | undefined;
  for (const line of output.trimEnd().split('\n')) {
    if (line.indexOf(' on ') !== line.lastIndexOf(' on ')) throw new Error('unsupported_recovery_lock_filesystem');
    const match = /^.+ on (\/.*) \(([^\n]+)\)$/.exec(line);
    if (!match) throw new Error('unsupported_recovery_lock_filesystem');
    const mount = match[1]!;
    if ((mount === '/' || path === mount || path.startsWith(`${mount}/`)) && (!selected || mount.length > selected.path.length)) {
      selected = { path: mount, flags: match[2]!.split(', ') };
    }
  }
  if (!selected || !['apfs', 'hfs'].includes(selected.flags[0]!) || !selected.flags.includes('local') || selected.flags.includes('noowners')) {
    throw new Error('unsupported_recovery_lock_filesystem');
  }
}

export function checkLinuxLockFilesystem(type: bigint): void {
  // ext2/3/4, tmpfs, XFS and Btrfs. Network, FUSE, overlay and unknown storage
  // need separate qualification; a PID namespace match does not qualify them.
  if (![0xef53n, 0x01021994n, 0x58465342n, 0x9123683en].includes(type)) throw new Error('unsupported_recovery_lock_filesystem');
}

/** Validate before creating children, then recheck after concurrent mkdir. */
export async function prepareLockRoot(input: string): Promise<string> {
  const path = platformPath(input); const uid = process.geteuid?.();
  if (uid === undefined || /[\r\n]/.test(path)) throw new Error('unsafe_recovery_lock_root');
  const chain: string[] = [];
  for (let current = path;; current = dirname(current)) { chain.unshift(current); if (dirname(current) === current) break; }
  for (const current of chain) {
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      info = await lstat(current);
    }
    checkLockDirectory(info, uid, current === path);
    if (process.platform === 'darwin') {
      checkDarwinLockACL(await lockSystemCommand('/bin/ls', ['-lde', current]));
    }
  }
  if (process.platform === 'darwin') checkDarwinLockMount(path, await lockSystemCommand('/sbin/mount', []));
  else if (process.platform === 'linux' && typeof filesystem.statfs === 'function') checkLinuxLockFilesystem((await filesystem.statfs(path, { bigint: true })).type);
  else throw new Error('unsupported_recovery_lock_filesystem');
  return path;
}
