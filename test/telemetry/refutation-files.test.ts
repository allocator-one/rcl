import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readStable } from '../../src/telemetry/recovery/files.js';

const controls = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined }));
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
afterEach(async () => { controls.afterRead = undefined; await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it.each(['modified', 'replaced'] as const)('refuses a report %s while its bytes are being read', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-changing-report-')); directories.push(root);
  const path = join(root, 'report.json'); await writeFile(path, '{"report":true}');
  controls.afterRead = async () => {
    if (mode === 'modified') await utimes(path, new Date('2026-01-01'), new Date('2026-01-01'));
    else { const other = join(root, 'replacement.json'); await writeFile(other, '{"report":false}'); await rename(other, path); }
  };
  await expect(readStable(path)).rejects.toThrow('changing_source');
});
