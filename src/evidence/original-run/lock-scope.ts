import { execFile } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const LOCK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface LockScope { platform: 'darwin' | 'linux'; boot: string; namespace: string }

/** Absolute system utilities only; no shell, caller environment or unbounded output. */
export async function lockSystemCommand(file: string, args: string[]): Promise<string> {
  const { stdout } = await exec(file, args, {
    encoding: 'utf8', timeout: 1000, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
  });
  return stdout;
}

async function linuxBoot(): Promise<string> {
  // procfs reports size zero. A fixed read still bounds the bytes we accept.
  const handle = await open('/proc/sys/kernel/random/boot_id', 'r');
  try {
    const bytes = Buffer.alloc(128); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
interface ScopeIO {
  platform: string;
  command: typeof lockSystemCommand;
  boot: () => Promise<string>;
  namespace: () => Promise<{ dev: bigint; ino: bigint }>;
}

export function validLockScope(value: unknown): value is LockScope {
  if (!value || typeof value !== 'object') return false;
  const scope = value as LockScope;
  return typeof scope.boot === 'string' && LOCK_UUID.test(scope.boot) &&
    ((scope.platform === 'darwin' && scope.namespace === 'native') ||
      (scope.platform === 'linux' && typeof scope.namespace === 'string' && /^\d+:[1-9]\d*$/.test(scope.namespace)));
}

/** PID absence proves death only on this kernel boot and PID namespace. */
export async function localLockScope(overrides: Partial<ScopeIO> = {}): Promise<LockScope> {
  const io: ScopeIO = {
    platform: process.platform, command: lockSystemCommand, boot: linuxBoot,
    namespace: () => stat('/proc/self/ns/pid', { bigint: true }), ...overrides,
  };
  try {
    let result: LockScope;
    if (io.platform === 'darwin') {
      const boot = (await io.command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).trim().toLowerCase();
      result = { platform: 'darwin', boot, namespace: 'native' };
    } else if (io.platform === 'linux') {
      const boot = (await io.boot()).trim().toLowerCase(); const ns = await io.namespace();
      result = { platform: 'linux', boot, namespace: `${ns.dev}:${ns.ino}` };
    } else throw new Error('unsupported');
    if (!validLockScope(result)) throw new Error('invalid');
    return result;
  } catch { throw new Error('unsupported_recovery_lock_scope'); }
}
