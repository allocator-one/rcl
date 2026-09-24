import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { withRecoveryLock } from '../../src/evidence/original-run/journal.js';
import { platformPath, sha256 } from '../../src/telemetry/recovery/files.js';

const controls = vi.hoisted(() => ({ path: '', armed: false, releaseChoosing: () => {}, ready: Promise.resolve() }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (controls.armed && String(args[0]) === controls.path) {
      controls.armed = false; controls.releaseChoosing(); await controls.ready;
    }
    return fs.open(...args);
  } };
});

it('rereads an actual choosing-to-ready inode replacement between lstat and open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-ready-transition-')); const identity = 'same run';
  let choose!: () => void; const chosen = new Promise<void>(resolve => { choose = resolve; });
  const holdChoosing = new Promise<void>(resolve => { controls.releaseChoosing = resolve; });
  let ready!: () => void; controls.ready = new Promise<void>(resolve => { ready = resolve; });
  let active = 0; let maximum = 0; let completed = 0; let secondTicket = 0;
  const work = async () => { maximum = Math.max(maximum, ++active); await new Promise(r => setImmediate(r)); active--; completed++; };
  const first = withRecoveryLock(root, identity, work, { legacy: false, onEvent: async event => {
    if (event.stage === 'choosing_published') {
      controls.path = join(platformPath(root), `${sha256(identity)}.bakery`, `${event.registration.token}.json`);
      choose(); await holdChoosing;
    }
    if (event.stage === 'ready_published') ready();
  } });
  try {
    await chosen; controls.armed = true;
    const second = withRecoveryLock(root, identity, work, { legacy: false, onEvent: async event => {
      if (event.stage === 'ticket_selected') secondTicket = event.registration.ticket!;
    } });
    await Promise.all([first, second]);
    expect(controls.armed).toBe(false); expect(secondTicket).toBe(2); expect(completed).toBe(2); expect(maximum).toBe(1);
  } finally { controls.releaseChoosing(); ready(); await first; await rm(root, { recursive: true, force: true }); }
});
