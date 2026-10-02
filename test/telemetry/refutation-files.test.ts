import { mkdtemp, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readStable } from '../../src/telemetry/recovery/files.js';

const controls = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined, missingSafeFlags: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, constants: {
    ...fs.constants,
    get O_NOFOLLOW() { return controls.missingSafeFlags ? undefined : fs.constants.O_NOFOLLOW; },
    get O_NONBLOCK() { return controls.missingSafeFlags ? undefined : fs.constants.O_NONBLOCK; },
  } };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    const read = handle.read.bind(handle);
    handle.read = (async (...readArgs: unknown[]) => {
      const result = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs);
      const hook = controls.afterRead; controls.afterRead = undefined;
      if (hook) await hook();
      return result;
    }) as typeof handle.read;
    return handle;
  } };
});
const directories: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(async () => {
  controls.afterRead = undefined;
  controls.missingSafeFlags = false;
  Object.defineProperty(process, 'platform', platform);
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function reportWithoutSafeFlags(simulatedPlatform: NodeJS.Platform): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-file-flags-')));
  directories.push(root);
  const path = join(root, 'report.json');
  await writeFile(path, '{"report":true}');
  controls.missingSafeFlags = true;
  Object.defineProperty(process, 'platform', { ...platform, value: simulatedPlatform });
  return path;
}

it('refuses missing safe file flags on Windows by default', async () => {
  const path = await reportWithoutSafeFlags('win32');
  await expect(readStable(path)).rejects.toThrow('safe_file_flags_unavailable');
});

it('reads stable regular files on Windows when missing safe flags are explicitly allowed', async () => {
  const path = await reportWithoutSafeFlags('win32');
  const file = await readStable(path, undefined, { allowMissingSafeFlagsOnWindows: true });
  expect(file.text).toBe('{"report":true}');
  expect(file.raw).toEqual(Buffer.from('{"report":true}'));
});

it('refuses missing safe file flags on POSIX even with the Windows opt-in', async () => {
  const path = await reportWithoutSafeFlags('linux');
  await expect(readStable(path, undefined, { allowMissingSafeFlagsOnWindows: true }))
    .rejects.toThrow('safe_file_flags_unavailable');
});

it('still refuses oversized files when Windows allows missing safe flags', async () => {
  const path = await reportWithoutSafeFlags('win32');
  await expect(readStable(path, 4, { allowMissingSafeFlagsOnWindows: true }))
    .rejects.toThrow('oversized');
});

it.each(['modified', 'replaced'] as const)('refuses a report %s while its bytes are being read', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-changing-report-')); directories.push(root);
  const path = join(root, 'report.json'); await writeFile(path, '{"report":true}');
  controls.afterRead = async () => {
    if (mode === 'modified') await utimes(path, new Date('2026-01-01'), new Date('2026-01-01'));
    else { const other = join(root, 'replacement.json'); await writeFile(other, '{"report":false}'); await rename(other, path); }
  };
  await expect(readStable(path)).rejects.toThrow('changing_source');
});
