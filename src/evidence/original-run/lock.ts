import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withLegacyReservation } from '../../coordination/registry-lock.js';
import { readStable, sha256 } from '../../telemetry/recovery/files.js';
import { checkLockDirectory, prepareLockRoot } from './lock-path.js';
import { localLockScope, LOCK_UUID, validLockScope, type LockScope } from './lock-scope.js';

export interface LockRegistration {
  version: 1; pid: number; token: string; scope: LockScope;
  state: 'choosing' | 'ready'; ticket?: number;
}
type LockStage = 'legacy_reserved' | 'choosing_published' | 'ticket_selected' | 'ready_published' | 'before_reap' | 'after_reap' | 'scan_complete';
/** Internal deterministic test seams. The CLI never accepts these overrides. */
export interface LockHooks {
  /** Test-only: exercises bakery mechanics independently of legacy bridging. */
  legacy?: boolean;
  scope?: () => Promise<LockScope>;
  token?: () => string;
  probe?: (pid: number) => void;
  now?: () => number;
  wait?: () => Promise<void>;
  read?: (path: string) => Promise<string>;
  onEvent?: (event: { stage: LockStage; registration: LockRegistration; peer?: LockRegistration }) => Promise<void>;
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
async function sync(path: string): Promise<void> {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Dynamic Lamport bakery on coherent local storage: choosing is visible before
 * ticket selection, then one fixed (ticket, token) orders this acquisition.
 * Each path is unique for all time. No shared reclaim guard or TTL is involved.
 */
export async function withRecoveryLock<T>(root: string, identity: string, work: () => Promise<T>, hooks: LockHooks = {}): Promise<T> {
  const scope = await (hooks.scope ?? localLockScope)();
  if (!validLockScope(scope)) throw new Error('unsupported_recovery_lock_scope');
  root = await prepareLockRoot(root);
  const key = sha256(identity);
  const token = (hooks.token ?? randomUUID)();
  if (!LOCK_UUID.test(token)) throw new Error('invalid_recovery_lock_token');
  const acquire = async () => {
  // Keep this directory permanently: removing it on release could split two
  // contenders across different inodes of the same registry pathname.
  const registry = join(root, `${key}.bakery`);
  try { await mkdir(registry, { mode: 0o700 }); }
  catch (error) { if (code(error) !== 'EEXIST') throw error; }
  await sync(root);
  checkLockDirectory(await lstat(registry), process.geteuid!(), true);
  // Includes inherited Darwin ACL and mount inspection for the registry itself.
  await prepareLockRoot(registry);
  const path = join(registry, `${token}.json`);
  let owner: LockRegistration = { version: 1, pid: process.pid, token, scope, state: 'choosing' };
  const now = hooks.now ?? (() => performance.now()); const deadline = now() + 5000;
  const wait = hooks.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 25)));
  const checkTime = () => { if (now() >= deadline) throw new Error('recovery_run_locked'); };
  const read = hooks.read ?? (async file => (await readStable(file, 2048)).text);
  let published = false;
  const emit = (stage: LockStage, peer?: LockRegistration) => hooks.onEvent?.({ stage, registration: owner, peer });

  const readOwner = async (file: string): Promise<LockRegistration | undefined> => {
    for (;;) {
      let text: string;
      try { text = await read(file); }
      catch (error) {
        if (code(error) === 'ENOENT') return undefined;
        if (error instanceof Error && error.message === 'changing_source') { checkTime(); await wait(); continue; }
        throw error;
      }
      let value: LockRegistration;
      try { value = JSON.parse(text) as LockRegistration; }
      catch { throw new Error('incomplete_recovery_lock_requires_inspection'); }
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
          typeof value.token !== 'string' || !LOCK_UUID.test(value.token) || file !== join(registry, `${value.token}.json`) ||
          !validLockScope(value.scope) || !['choosing', 'ready'].includes(value.state) ||
          (value.state === 'choosing' ? value.ticket !== undefined : !Number.isSafeInteger(value.ticket) || value.ticket! < 1)) {
        throw new Error('invalid_recovery_lock_requires_inspection');
      }
      if (!isDeepStrictEqual(value.scope, scope)) throw new Error('foreign_recovery_lock_scope');
      return value;
    }
  };
  const verifyOwned = async () => {
    if (!isDeepStrictEqual(await readOwner(path), owner)) throw new Error('recovery_lock_owner_changed');
  };

  const publish = async (value: LockRegistration, initial: boolean) => {
    const temporary = join(registry, `${token}.${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      if (initial) await link(temporary, path);
      else { await verifyOwned(); await rename(temporary, path); created = false; }
      // Set ownership before any fallible post-publication operation, including
      // temp unlink and directory fsync, so the finally block can release it.
      published = true; owner = value;
    } finally { if (created) await unlink(temporary); }
    await sync(registry);
  };
  const names = async (): Promise<string[]> => {
    const all = await readdir(registry);
    const result: string[] = [];
    for (const name of all) {
      // An interrupted private write is not a choosing registration. Only
      // atomic publication into the .json namespace joins the protocol.
      const parts = name.split('.');
      if (parts.length === 3 && parts[2] === 'tmp' && LOCK_UUID.test(parts[0]!) && LOCK_UUID.test(parts[1]!)) continue;
      if (!name.endsWith('.json') || !LOCK_UUID.test(name.slice(0, -5))) throw new Error('invalid_recovery_lock_registration');
      result.push(name);
    }
    return result.sort();
  };
  const scan = async (): Promise<LockRegistration[]> => {
    for (;;) {
      checkTime(); const directory = await lstat(registry, { bigint: true });
      const before = await names(); const peers: LockRegistration[] = [];
      for (const name of before) {
        checkTime();
        const peer = await readOwner(join(registry, name)); if (peer) peers.push(peer);
      }
      // Under the supported local visibility contract, unchanged full name
      // scans prevent a disappearing registration from hiding a chooser that
      // predated our ready publication. A newly arriving chooser must see us.
      const after = await names(); const current = await lstat(registry, { bigint: true });
      if (peers.length === before.length && isDeepStrictEqual(before, after) &&
          directory.ino === current.ino && directory.dev === current.dev &&
          directory.ctimeNs === current.ctimeNs && directory.mtimeNs === current.mtimeNs) return peers;
      await wait();
    }
  };
  const release = async () => {
    if (!published) return;
    await verifyOwned(); await unlink(path); published = false; await sync(registry);
  };
  let failed = false; let failure: unknown;
  try {
    await emit('legacy_reserved');
    await publish(owner, true); await emit('choosing_published');
    const peers = await scan();
    const maximum = peers.reduce((max, peer) => Math.max(max, peer.ticket ?? 0), 0);
    if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error('recovery_lock_ticket_exhausted');
    const ready: LockRegistration = { ...owner, state: 'ready', ticket: maximum + 1 };
    // The hook observes the selected value without mutating the visible owner.
    await hooks.onEvent?.({ stage: 'ticket_selected', registration: ready });
    await publish(ready, false); await emit('ready_published');
    for (;;) {
      const peers = await scan(); let blocked = false;
      // Validate the entire scan's scopes before making any local PID probe.
      for (const peer of peers) {
        if (peer.token === token) continue;
        let dead = false;
        try { (hooks.probe ?? (pid => process.kill(pid, 0)))(peer.pid); }
        catch (error) {
          if (code(error) !== 'ESRCH') throw new Error('recovery_lock_liveness_unknown');
          dead = true;
        }
        if (dead) {
          await emit('before_reap', peer);
          // This pathname is never reused, so another/delayed reaper can only
          // unlink this dead generation; ENOENT means it already did so.
          try { await unlink(join(registry, `${peer.token}.json`)); await sync(registry); }
          catch (error) { if (code(error) !== 'ENOENT') throw error; }
          await emit('after_reap', peer);
        } else if (peer.state === 'choosing' || peer.ticket! < owner.ticket! ||
            (peer.ticket === owner.ticket && peer.token < token)) blocked = true;
      }
      if (!blocked) {
        await verifyOwned(); checkTime(); await emit('scan_complete');
        return await work();
      }
      checkTime(); await wait();
    }
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { await release(); }
    catch (error) { if (failed) throw new AggregateError([failure, error], 'recovery_lock_cleanup_failed', { cause: failure }); throw error; }
  }
  };
  if (hooks.legacy === false) {
    if (process.env.NODE_ENV !== 'test') throw new Error('test_only_bakery_hook');
    return acquire();
  }
  return withLegacyReservation(root, identity, { pid: process.pid, token, scope }, acquire,
    { sync, read: hooks.read, probe: hooks.probe, now: hooks.now, wait: hooks.wait, reclaimLegacy: false, qualifiedLegacy: owner => validLockScope((owner as { scope?: unknown }).scope) });
}
