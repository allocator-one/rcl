import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { win32 } from 'node:path';
import { z } from 'zod';

import {
  localLockScope,
  lockScopeSchema,
  lockSystemCommand,
} from '../evidence/original-run/lock-scope.js';

const windowsProcessScopeSchema = z.object({
  platform: z.literal('win32'),
  bootSha256: z.string().regex(/^[a-f0-9]{64}$/),
  namespace: z.literal('native'),
}).strict();

const processIdentityScopeSchema = z.union([lockScopeSchema, windowsProcessScopeSchema]);
type ProcessIdentityScope = z.infer<typeof processIdentityScopeSchema>;

export const processIdentitySchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive().safe(),
  scope: processIdentityScopeSchema,
  birthSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ProcessIdentity = z.infer<typeof processIdentitySchema>;
export type ProcessIdentityStatus = 'alive' | 'dead' | 'unverifiable';

export interface ProcessIdentityIO {
  platform: string;
  scope: () => Promise<ProcessIdentityScope>;
  probe: (pid: number) => void;
  linuxStat: (pid: number) => Promise<string>;
  command: typeof lockSystemCommand;
  windowsPowerShell: string;
}

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function defaults(overrides: Partial<ProcessIdentityIO>): ProcessIdentityIO {
  const platform = overrides.platform ?? process.platform;
  const command = overrides.command ?? lockSystemCommand;
  const windowsPowerShell = overrides.windowsPowerShell ??
    (platform === 'win32' ? defaultWindowsPowerShell() : '');
  return {
    platform,
    scope: () => localProcessScope(platform, command, windowsPowerShell),
    probe: pid => process.kill(pid, 0),
    linuxStat: readLinuxStat,
    command,
    windowsPowerShell,
    ...overrides,
  };
}

function defaultWindowsPowerShell(): string {
  const root = process.env.SystemRoot;
  if (!root || !win32.isAbsolute(root) || /[<>"|?*\r\n]/.test(root)) {
    throw new Error('unsupported_windows_process_identity');
  }
  return win32.join(win32.normalize(root), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsTicks(raw: string, error: string): string {
  const lines = raw.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length !== 1 || !/^(?:0|[1-9]\d{0,19})$/.test(lines[0]!)) throw new Error(error);
  return lines[0]!;
}

function windowsArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
}

async function localProcessScope(platform: string, command: typeof lockSystemCommand,
  windowsPowerShell: string): Promise<ProcessIdentityScope> {
  if (platform !== 'win32') return localLockScope();
  const ticks = windowsTicks(await command(windowsPowerShell, windowsArgs(
    '(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks',
  ), 5_000), 'invalid_windows_boot_identity');
  return windowsProcessScopeSchema.parse({ platform: 'win32', namespace: 'native',
    bootSha256: createHash('sha256').update(`win32\0${ticks}`, 'utf8').digest('hex') });
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
  if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error('invalid_linux_process_birth');
  return `linux:${startTicks}`;
}

function darwinBirth(started: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) ([+-])(\d{2})(\d{2})$/.exec(started);
  if (!match) throw new Error('invalid_darwin_process_birth');
  const [year, month, day, hour, minute, second, millisecond, offsetHour, offsetMinute] =
    [1, 2, 3, 4, 5, 6, 7, 9, 10].map(index => Number(match[index]));
  const localUtc = Date.UTC(year!, month! - 1, day, hour, minute, second, millisecond);
  const canonical = new Date(localUtc);
  if (year! < 1970 || month! < 1 || month! > 12 || day! < 1 ||
      canonical.getUTCFullYear() !== year || canonical.getUTCMonth() !== month! - 1 || canonical.getUTCDate() !== day ||
      canonical.getUTCHours() !== hour || canonical.getUTCMinutes() !== minute || canonical.getUTCSeconds() !== second ||
      canonical.getUTCMilliseconds() !== millisecond || offsetHour! > 23 || offsetMinute! > 59) {
    throw new Error('invalid_darwin_process_birth');
  }
  const direction = match[8] === '+' ? 1 : -1;
  const epoch = localUtc - direction * (offsetHour! * 60 + offsetMinute!) * 60_000;
  if (!Number.isSafeInteger(epoch)) throw new Error('invalid_darwin_process_birth');
  return `darwin:${epoch}`;
}

async function processBirth(pid: number, scope: ProcessIdentityScope, io: ProcessIdentityIO): Promise<string> {
  if (scope.platform === 'linux') return linuxBirth(await io.linuxStat(pid), pid);
  if (scope.platform === 'win32') {
    const marker = 'RCL_PROCESS_MISSING';
    const raw = await io.command(io.windowsPowerShell, windowsArgs(
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){'${marker}'}else{$p.StartTime.ToUniversalTime().Ticks}`,
    ), 5_000);
    if (raw.trim() === marker) throw Object.assign(new Error('windows_process_missing'), { code: 'ESRCH' });
    return `win32:${windowsTicks(raw, 'invalid_windows_process_birth')}`;
  }
  const output = await io.command('/usr/bin/vmmap', ['-summary', String(pid)], 5_000);
  const launchLines = output.split('\n').filter(line => line.startsWith('Launch Time:'));
  const match = launchLines.length === 1
    ? /^Launch Time:[ \t]+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4})$/.exec(launchLines[0]!)
    : null;
  const started = match?.[1];
  if (!started) throw new Error('invalid_darwin_process_birth');
  return darwinBirth(started);
}

function birthDigest(platform: ProcessIdentityScope['platform'], birth: string): string {
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

let currentProcessIdentity: Promise<ProcessIdentity> | undefined;

/** Capture this immutable process identity once; arbitrary PID captures remain fresh. */
export function captureCurrentProcessIdentity(): Promise<ProcessIdentity> {
  currentProcessIdentity ??= captureProcessIdentity().catch(error => {
    currentProcessIdentity = undefined;
    throw error;
  });
  return currentProcessIdentity;
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
  let scope: ProcessIdentityScope;
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
    if (nodeError(error, 'ESRCH')) return 'dead';
    if (scope.platform === 'linux' && nodeError(error, 'ENOENT')) {
      try { io.probe(expected.pid); }
      catch (probeError) { return nodeError(probeError, 'ESRCH') ? 'dead' : 'unverifiable'; }
    }
    return 'unverifiable';
  }
}
