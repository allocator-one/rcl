import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  localLockScope,
  lockScopeSchema,
  lockSystemCommand,
  type LockScope,
} from '../evidence/original-run/lock-scope.js';

export const processIdentitySchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive().safe(),
  scope: lockScopeSchema,
  birthSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ProcessIdentity = z.infer<typeof processIdentitySchema>;
export type ProcessIdentityStatus = 'alive' | 'dead' | 'unverifiable';

export interface ProcessIdentityIO {
  platform: string;
  scope: () => Promise<LockScope>;
  probe: (pid: number) => void;
  linuxStat: (pid: number) => Promise<string>;
  command: typeof lockSystemCommand;
}

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function defaults(overrides: Partial<ProcessIdentityIO>): ProcessIdentityIO {
  return {
    platform: process.platform,
    scope: localLockScope,
    probe: pid => process.kill(pid, 0),
    linuxStat: readLinuxStat,
    command: lockSystemCommand,
    ...overrides,
  };
}

async function readLinuxStat(pid: number): Promise<string> {
  const handle = await open(`/proc/${pid}/stat`, 'r');
  try {
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead === bytes.length) throw new Error('oversized_linux_process_stat');
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

function linuxBirth(raw: string, pid: number): string {
  const closing = raw.lastIndexOf(')');
  const prefix = `${pid} (`;
  if (!raw.startsWith(prefix) || closing < prefix.length) throw new Error('invalid_linux_process_stat');
  // Fields after comm start at field 3; process start time is field 22.
  const fields = raw.slice(closing + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  if (!startTicks || !/^[1-9]\d*$/.test(startTicks)) throw new Error('invalid_linux_process_birth');
  return `linux:${startTicks}`;
}

async function processBirth(pid: number, scope: LockScope, io: ProcessIdentityIO): Promise<string> {
  if (scope.platform === 'linux') return linuxBirth(await io.linuxStat(pid), pid);
  const started = (await io.command('/bin/ps', ['-p', String(pid), '-o', 'lstart='])).trim();
  if (!started || started.length > 224 || /[\r\n]/.test(started)) throw new Error('invalid_darwin_process_birth');
  return `darwin:${started}`;
}

function birthDigest(platform: LockScope['platform'], birth: string): string {
  return createHash('sha256').update(`${platform}\0${birth}`, 'utf8').digest('hex');
}

/** Capture one process on this boot and PID namespace, including its OS birth marker. */
export async function captureProcessIdentity(
  pid = process.pid,
  overrides: Partial<ProcessIdentityIO> = {},
): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('process_identity_invalid_pid');
  const io = defaults(overrides);
  const scope = await io.scope();
  if (io.platform !== scope.platform) throw new Error('process_identity_platform_mismatch');
  io.probe(pid);
  return processIdentitySchema.parse({ version: 1, pid, scope,
    birthSha256: birthDigest(scope.platform, await processBirth(pid, scope, io)) });
}

/** Determine whether the exact saved process still exists; uncertainty never proves death. */
export async function inspectProcessIdentity(
  expectedValue: ProcessIdentity,
  overrides: Partial<ProcessIdentityIO> = {},
): Promise<ProcessIdentityStatus> {
  const parsed = processIdentitySchema.safeParse(expectedValue);
  if (!parsed.success) return 'unverifiable';
  const expected = parsed.data;
  const io = defaults(overrides);
  let scope: LockScope;
  try { scope = await io.scope(); }
  catch { return 'unverifiable'; }
  if (io.platform !== scope.platform || !isDeepStrictEqual(scope, expected.scope)) return 'unverifiable';
  try { io.probe(expected.pid); }
  catch (error) {
    if (nodeError(error, 'ESRCH')) return 'dead';
    return 'unverifiable';
  }
  try {
    const currentBirth = birthDigest(scope.platform, await processBirth(expected.pid, scope, io));
    return currentBirth === expected.birthSha256 ? 'alive' : 'dead';
  } catch (error) {
    return nodeError(error, 'ESRCH') ||
      (scope.platform === 'linux' && nodeError(error, 'ENOENT')) ? 'dead' : 'unverifiable';
  }
}
