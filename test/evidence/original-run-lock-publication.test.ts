import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

const controls = vi.hoisted(() => ({ fault: '', ready: false, releasing: false }));
const fail = (name: string) => {
  if (controls.fault === name) { controls.fault = ''; throw Object.assign(new Error('readonly fixture'), { code: 'EROFS' }); }
};
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    link: async (...args: Parameters<typeof fs.link>) => { fail('choosing publication'); return fs.link(...args); },
    rename: async (...args: Parameters<typeof fs.rename>) => { fail('ready publication'); await fs.rename(...args); controls.ready = true; },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      if (controls.releasing && String(args[0]).endsWith('.json')) fail('release unlink'); return fs.unlink(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args); const write = handle.writeFile.bind(handle); const sync = handle.sync.bind(handle); let state = '';
      handle.writeFile = (async (...values: Parameters<typeof handle.writeFile>) => {
        if (String(args[0]).endsWith('.tmp')) { state = String(values[0]).includes('"state":"ready"') ? 'ready' : 'choosing'; fail('write'); }
        return write(...values);
      }) as typeof handle.writeFile;
      handle.sync = async () => {
        if ((await handle.stat()).isDirectory()) {
          if (controls.releasing) fail('release sync'); else if (controls.ready) fail('ready directory sync');
        } else fail(`${state} file sync`);
        return sync();
      };
      return handle;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  controls.fault = ''; controls.ready = false; controls.releasing = false;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const path = await mkdtemp(join(tmpdir(), 'rcl-lock-publication-')); roots.push(path); return path; }
async function registryEntries(path: string) {
  try { return await readdir(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

it.each(['write', 'choosing file sync', 'choosing publication', 'ready file sync', 'ready publication', 'ready directory sync'])('enters no work after %s fails and permits a clean retry', async fault => {
  const path = await root(); controls.fault = fault; const work = vi.fn();
  await expect(withRecoveryLock(path, 'run', work)).rejects.toMatchObject({ code: 'EROFS' });
  expect(work).not.toHaveBeenCalled(); expect(await registryEntries(join(path, `${sha256('run')}.bakery`))).toEqual([]);
  await expect(withRecoveryLock(path, 'run', async () => 'retry')).resolves.toBe('retry');
});

it.each(['release unlink', 'release sync'])('does not report successful completion after %s fails', async fault => {
  const path = await root(); const work = vi.fn(async () => { controls.fault = fault; controls.releasing = true; return 'complete'; });
  await expect(withRecoveryLock(path, 'run', work)).rejects.toMatchObject({ code: 'EROFS' }); expect(work).toHaveBeenCalledOnce();
});
