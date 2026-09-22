import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';
const controls = vi.hoisted(() => ({ pauseTemp: false, observeBefore: false, snapshots: [] as Array<{nlink:number;ctimeMs:number;size:number}>, linked: (() => {}) as () => void, allowUnlink: Promise.resolve(), releaseUnlink: (() => {}) as () => void, releaseWork: (() => {}) as () => void, unlinked: Promise.resolve(), unlinkDone: (() => {}) as () => void }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const snapshot = await fs.lstat(...args);
    // Release after the contender has captured the changed owner stat, so the
    // immutable read reports its real ctime conflict before acquisition retries.
    if (String(args[0]).endsWith('.lock') && controls.snapshots.length === 2) controls.releaseWork();
    return snapshot;
  }, unlink: async (path: Parameters<typeof fs.unlink>[0]) => {
    if (controls.pauseTemp && String(path).endsWith('.tmp')) {
      controls.pauseTemp = false; controls.linked(); await controls.allowUnlink;
      await new Promise(r => setTimeout(r, 5));
      const result = await fs.unlink(path); controls.unlinkDone(); return result;
    }
    return fs.unlink(path);
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args); const stat = handle.stat.bind(handle);
    if (String(args[0]).endsWith('.lock')) handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
      const snapshot = await stat(...statArgs); controls.snapshots.push({nlink:Number(snapshot.nlink),ctimeMs:Number(snapshot.ctimeMs),size:Number(snapshot.size)});
      if (controls.observeBefore) { controls.observeBefore = false; controls.releaseUnlink(); await controls.unlinked; }
      return snapshot;
    }) as typeof handle.stat;
    return handle;
  } };
});
it('retries lock metadata changes during hard-link cleanup and enters recovery only after acquiring ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-hardlink-transition-'));
  const visible = new Promise<void>(resolve => { controls.linked = resolve; });
  controls.allowUnlink = new Promise<void>(resolve => { controls.releaseUnlink = resolve; });
  controls.unlinked = new Promise<void>(resolve => { controls.unlinkDone = resolve; });
  const holdWork = new Promise<void>(resolve => { controls.releaseWork = resolve; });
  controls.pauseTemp = true; controls.observeBefore = true;
  let active = 0; let maximum = 0; let completed = 0;
  const first = withRecoveryLock(root, 'same destination/org/run', async () => {
    active++; maximum = Math.max(maximum, active);
    await holdWork; active--; completed++;
  });
  try {
    await visible;
    const second = withRecoveryLock(root, 'same destination/org/run', async () => {
      active++; maximum = Math.max(maximum, active); active--; completed++;
    });
    await expect(second).resolves.toBeUndefined();
    await first;
    expect(completed).toBe(2); expect(maximum).toBe(1);
    expect(controls.snapshots[0]!.nlink).toBe(2);
    expect(controls.snapshots[1]!.nlink).toBe(1);
    expect(controls.snapshots[0]!.ctimeMs).not.toBe(controls.snapshots[1]!.ctimeMs);
  } finally {
    controls.releaseUnlink(); controls.releaseWork();
    await first; await rm(root, { recursive: true, force: true });
  }
});
