import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readStable, sha256 } from '../telemetry/recovery/files.js';
import { LOCK_UUID } from '../evidence/original-run/lock-scope.js';

export interface RegistryRegistration<Scope> {
  version: 1; pid: number; token: string; scope: Scope;
  state: 'choosing' | 'ready'; ticket?: number;
}
type LockStage = 'legacy_reserved' | 'choosing_published' | 'ticket_selected' | 'ready_published' | 'before_reap' | 'after_reap' | 'scan_complete';
/** Internal deterministic test seams. The CLI never accepts these overrides. */
export interface RegistryHooks<Scope> {
  scope?: () => Promise<Scope>;
  token?: () => string;
  probe?: (pid: number) => void;
  now?: () => number;
  wait?: () => Promise<void>;
  read?: (path: string) => Promise<string>;
  onEvent?: (event: { stage: LockStage; registration: RegistryRegistration<Scope>; peer?: RegistryRegistration<Scope> }) => Promise<void>;
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
export interface RegistryPolicy<Scope> {
  scope: () => Promise<Scope>;
  validScope: (value: unknown) => value is Scope;
  prepareRoot: (path: string) => Promise<string>;
  inspectRegistry: (path: string) => Promise<void>;
  sync: (path: string) => Promise<void>;
  read?: (path: string) => Promise<string>;
  mayProbePid: (scope: Scope) => boolean;
  /** Bounded waiting policy for callers that expose lock timing as part of their contract. */
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

/** Options for the pre-3.8 recovery-lock compatibility reservation.
 *
 * Older clients serialize solely with `<sha256(identity)>.lock`.  New clients
 * hold that pathname for their entire bakery critical section, so either
 * protocol observes the other.  Reclaim deliberately retains the old
 * PID-only semantics: this document has no boot or namespace binding.
 */
export interface LegacyReservationOptions {
  sync: (path: string) => Promise<void>;
  read?: (path: string) => Promise<string>;
  probe?: (pid: number) => void;
  now?: () => number;
  wait?: () => Promise<void>;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

interface LegacyOwner { pid: number; token: string }

/**
 * Reserve the legacy recovery-lock pathname for the duration of `work`.
 * Creation, stale-owner reclamation, and release are all ownership checked so
 * the bridge cannot be a check-then-act preflight beside the bakery registry.
 */
export async function withLegacyReservation<T>(root: string, identity: string, owner: LegacyOwner,
  work: () => Promise<T>, options: LegacyReservationOptions = { sync: async () => {} }): Promise<T> {
  const timeout = options.lockTimeoutMs ?? 5_000;
  const retry = options.lockRetryMs ?? 25;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || !Number.isSafeInteger(retry) || retry < 1) {
    throw new Error('invalid_registry_lock_timing');
  }
  const now = options.now ?? (() => performance.now());
  const deadline = now() + timeout;
  const wait = options.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, retry)));
  const checkTime = () => { if (now() >= deadline) throw new Error('recovery_run_locked'); };
  const path = join(root, `${sha256(identity)}.lock`);
  const reclaim = `${path}.reclaim`;
  const read = options.read ?? (async file => (await readStable(file, 2048)).text);
  const readOwner = async (): Promise<LegacyOwner | undefined> => {
    let text: string;
    try { text = await read(path); }
    catch (error) {
      if (code(error) === 'ENOENT') return undefined;
      if (error instanceof Error && error.message === 'changing_source') return undefined;
      throw error;
    }
    let current: unknown;
    try { current = JSON.parse(text); }
    catch { throw new Error('incomplete_recovery_lock_requires_inspection'); }
    if (!current || typeof current !== 'object' || !Number.isSafeInteger((current as LegacyOwner).pid) ||
        (current as LegacyOwner).pid < 1 || typeof (current as LegacyOwner).token !== 'string') {
      throw new Error('invalid_recovery_lock_requires_inspection');
    }
    return current as LegacyOwner;
  };
  const create = async (): Promise<boolean> => {
    let created = false;
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await handle.writeFile(JSON.stringify(owner) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await options.sync(root);
      return true;
    } catch (error) {
      if (code(error) === 'EEXIST') return false;
      if (created) {
        try { await unlink(path); await options.sync(root); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'legacy_recovery_lock_cleanup_failed', { cause: error }); }
      }
      throw error;
    }
  };

  for (;;) {
    let reclaiming = false;
    try { await lstat(reclaim); reclaiming = true; }
    catch (error) { if (code(error) !== 'ENOENT') throw error; }
    if (reclaiming) throw new Error('legacy_recovery_lock_requires_inspection');
    if (await create()) break;
    let snapshot: Awaited<ReturnType<typeof readStable>>;
    try { snapshot = await readStable(path, 2048); }
    catch (error) {
      if (code(error) === 'ENOENT') continue;
      if (error instanceof Error && error.message === 'changing_source') { checkTime(); await wait(); continue; }
      throw error;
    }
    let existing: LegacyOwner;
    try { existing = JSON.parse(snapshot.text) as LegacyOwner; }
    catch { throw new Error('incomplete_recovery_lock_requires_inspection'); }
    if (!Number.isSafeInteger(existing.pid) || existing.pid < 1 || typeof existing.token !== 'string') {
      throw new Error('invalid_recovery_lock_requires_inspection');
    }
    let alive = true;
    try { (options.probe ?? (pid => process.kill(pid, 0)))(existing.pid); }
    catch (error) { if (code(error) === 'ESRCH') alive = false; }
    if (!alive) {
      try {
        await mkdir(reclaim, { mode: 0o700 });
      } catch (error) {
        if (code(error) === 'EEXIST') throw new Error('legacy_recovery_lock_requires_inspection');
        if (code(error) === 'ENOENT') continue;
        throw error;
      }
      try {
        if ((await readStable(path, 2048)).sha256 === snapshot.sha256) {
          await unlink(path); await options.sync(root);
        }
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      } finally {
        try { await rmdir(reclaim); }
        catch (error) { if (code(error) !== 'ENOENT') throw error; }
      }
      continue;
    }
    checkTime(); await wait();
  }

  const release = async () => {
    const current = await readOwner();
    if (!current || current.pid !== owner.pid || current.token !== owner.token) {
      throw new Error('legacy_recovery_lock_owner_changed');
    }
    await unlink(path); await options.sync(root);
  };
  let failed = false; let failure: unknown;
  try { return await work(); }
  catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { await release(); }
    catch (error) {
      if (failed) throw new AggregateError([failure, error], 'recovery_lock_cleanup_failed', { cause: failure });
      throw error;
    }
  }
}

/** Work completed; only coordination cleanup failed. Never replay the result. */
export class RegistryCleanupError<T = unknown> extends Error {
  constructor(readonly result: T, cause: unknown) {
    super(cause instanceof Error ? cause.message : 'registry_cleanup_failed', { cause });
    this.name = 'RegistryCleanupError';
  }
}

/**
 * Dynamic Lamport bakery on coherent local storage: choosing is visible before
 * ticket selection, then one fixed (ticket, token) orders this acquisition.
 * Each path is unique for all time. No shared reclaim guard or TTL is involved.
 */
export async function withRegistryLock<T, Scope>(root: string, identity: string, work: () => Promise<T>,
  policy: RegistryPolicy<Scope>, hooks: RegistryHooks<Scope> = {}): Promise<T> {
  const sync = policy.sync;
  const scope = await (hooks.scope ?? policy.scope)();
  if (!policy.validScope(scope)) throw new Error('unsupported_recovery_lock_scope');
  root = await policy.prepareRoot(root);
  const key = sha256(identity);
  const token = (hooks.token ?? randomUUID)();
  if (!LOCK_UUID.test(token)) throw new Error('invalid_recovery_lock_token');
  return withLegacyReservation(root, identity, { pid: process.pid, token }, async () => {
  // Keep this directory permanently: removing it on release could split two
  // contenders across different inodes of the same registry pathname.
  const registry = join(root, `${key}.bakery`);
  try { await mkdir(registry, { mode: 0o700 }); }
  catch (error) { if (code(error) !== 'EEXIST') throw error; }
  await sync(root);
  await policy.inspectRegistry(registry);
  const path = join(registry, `${token}.json`);
  let owner: RegistryRegistration<Scope> = { version: 1, pid: process.pid, token, scope, state: 'choosing' };
  const lockTimeoutMs = policy.lockTimeoutMs ?? 5_000;
  const lockRetryMs = policy.lockRetryMs ?? 25;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 ||
      !Number.isSafeInteger(lockRetryMs) || lockRetryMs < 1) {
    throw new Error('invalid_registry_lock_timing');
  }
  const now = hooks.now ?? (() => performance.now()); const deadline = now() + lockTimeoutMs;
  const wait = hooks.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, lockRetryMs)));
  const checkTime = () => { if (now() >= deadline) throw new Error('recovery_run_locked'); };
  const read = hooks.read ?? policy.read ?? (async file => (await readStable(file, 2048)).text);
  let published = false;
  const emit = (stage: LockStage, peer?: RegistryRegistration<Scope>) => hooks.onEvent?.({ stage, registration: owner, peer });

  const readOwner = async (file: string): Promise<RegistryRegistration<Scope> | undefined> => {
    for (;;) {
      let text: string;
      try { text = await read(file); }
      catch (error) {
        if (code(error) === 'ENOENT') return undefined;
        if (error instanceof Error && error.message === 'changing_source') { checkTime(); await wait(); continue; }
        throw error;
      }
      let value: RegistryRegistration<Scope>;
      try { value = JSON.parse(text) as RegistryRegistration<Scope>; }
      catch { throw new Error('incomplete_recovery_lock_requires_inspection'); }
      if (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
          typeof value.token !== 'string' || !LOCK_UUID.test(value.token) || file !== join(registry, `${value.token}.json`) ||
          !policy.validScope(value.scope) || !['choosing', 'ready'].includes(value.state) ||
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

  const publish = async (value: RegistryRegistration<Scope>, initial: boolean) => {
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
  const scan = async (): Promise<RegistryRegistration<Scope>[]> => {
    for (;;) {
      checkTime(); const directory = await lstat(registry, { bigint: true });
      const before = await names(); const peers: RegistryRegistration<Scope>[] = [];
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
  let failed = false; let failure: unknown; let completed = false; let result: T;
  try {
    await emit('legacy_reserved');
    await publish(owner, true); await emit('choosing_published');
    const peers = await scan();
    const maximum = peers.reduce((max, peer) => Math.max(max, peer.ticket ?? 0), 0);
    if (maximum >= Number.MAX_SAFE_INTEGER) throw new Error('recovery_lock_ticket_exhausted');
    const ready: RegistryRegistration<Scope> = { ...owner, state: 'ready', ticket: maximum + 1 };
    // The hook observes the selected value without mutating the visible owner.
    await hooks.onEvent?.({ stage: 'ticket_selected', registration: ready });
    await publish(ready, false); await emit('ready_published');
    for (;;) {
      const peers = await scan(); let blocked = false;
      // Validate the entire scan's scopes before making any local PID probe.
      for (const peer of peers) {
        if (peer.token === token) continue;
        let dead = false;
        try { if (policy.mayProbePid(peer.scope)) (hooks.probe ?? (pid => process.kill(pid, 0)))(peer.pid); }
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
        result = await work(); completed = true; return result;
      }
      checkTime(); await wait();
    }
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { await release(); }
    catch (error) {
      if (failed) throw new AggregateError([failure, error], 'recovery_lock_cleanup_failed', { cause: failure });
      if (completed) throw new RegistryCleanupError(result!, error);
      throw error;
    }
  }
  }, { sync, read: hooks.read ?? policy.read, probe: hooks.probe, now: hooks.now, wait: hooks.wait,
    lockTimeoutMs: policy.lockTimeoutMs, lockRetryMs: policy.lockRetryMs });
}
