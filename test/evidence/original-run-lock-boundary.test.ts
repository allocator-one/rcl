import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'rcl-lock-boundary-')); roots.push(path); return path; }

it('refuses an existing writable lock root before calling recovery', async () => {
  const path = await root(); await chmod(path, 0o777);
  const work = vi.fn();
  await expect(withRecoveryLock(path, 'run', work)).rejects.toThrow('unsafe_recovery_lock_root');
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(path)).toEqual([]);
});

it('does not bypass an orphaned legacy reclaim guard even without its canonical lock', async () => {
  const path = await root(); const guard = `${sha256('run')}.lock.reclaim`;
  await mkdir(join(path, guard), { mode: 0o700 });
  const work = vi.fn();
  await expect(withRecoveryLock(path, 'run', work)).rejects.toThrow('legacy_recovery_lock_requires_inspection');
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(path)).toEqual([guard]);
});
