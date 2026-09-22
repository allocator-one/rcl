import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { platformPath, readStable, sha256, writeRecoveryArtifact } from '../../telemetry/recovery/files.js';

async function parentSafe(path: string): Promise<void> {
  if (await realpath(dirname(path)) !== dirname(path)) throw new Error('symlink_directory');
}
export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
/** One byte representation for size checks, immutable writes and digests. */
export function serializeRecoveryDocument(value: unknown, limit = Infinity): string {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('recovery_document_too_large');
  return text;
}
/** Exclusive named publication; a failed write is retained and never overwritten. */
export async function writeExclusive(path: string, value: unknown, limit = Infinity): Promise<void> {
  const text = serializeRecoveryDocument(value, limit);
  const file = platformPath(path); await parentSafe(file);
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(file));
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
  let existing = path;
  for (;;) {
    try { await lstat(existing); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; existing = dirname(existing); }
  }
  if (await realpath(existing) !== existing) throw new Error('symlink_directory');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error('unsafe_recovery_directory');
}

/** Cross-manifest, per-destination/org/run serialization, isolated from native/accounting locks. */
export async function withRecoveryLock<T>(root: string, identity: string, work: () => Promise<T>): Promise<T> {
  root = platformPath(root); await ensurePrivateDirectory(root);
  const path = join(root, `${sha256(identity)}.lock`); const token = randomUUID();
  const owner = { pid: process.pid, token }; const deadline = Date.now() + 5000;
  const releaseOwnedLock = async () => {
    const current = JSON.parse((await readStable(path, 1000)).text) as typeof owner;
    if (current.pid !== owner.pid || current.token !== owner.token) throw new Error('recovery_lock_owner_changed');
    await unlink(path); await syncDirectory(root);
  };
  for (;;) {
    // Readers must only observe a complete owner document. Journal checkpoints
    // intentionally retain interrupted writes, but a lock is published atomically.
    try { await parentSafe(path); await writeRecoveryArtifact(path, owner); await syncDirectory(root); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Publication may have succeeded before temp cleanup or directory sync
        // failed. Release only a provably owned lock; retain the original error.
        await releaseOwnedLock().catch(() => undefined);
        throw error;
      }
      let stale: { pid?: number; token?: string };
      let snapshot: Awaited<ReturnType<typeof readStable>>;
      try { snapshot = await readStable(path, 1000); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // Removing the publisher's temporary hard link changes the owner's
        // ctime. Retry a fresh lock read within the existing contention bound.
        if (e instanceof Error && e.message === 'changing_source' && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 25));
          continue;
        }
        throw e;
      }
      try { stale = JSON.parse(snapshot.text); } catch { throw new Error('incomplete_recovery_lock_requires_inspection'); }
      if (!Number.isSafeInteger(stale.pid) || stale.pid! < 1 || typeof stale.token !== 'string') throw new Error('invalid_recovery_lock_requires_inspection');
      let alive = true;
      try { process.kill(stale.pid!, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (!alive) {
        const guard = `${path}.reclaim`;
        try {
          await mkdir(guard, { mode: 0o700 });
          try {
            if ((await readStable(path, 1000)).sha256 === snapshot.sha256) { await unlink(path); await syncDirectory(root); }
          } finally { await rmdir(guard); }
          continue;
        } catch (e) { if (!['EEXIST','ENOENT'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
      }
      if (Date.now() >= deadline) throw new Error('recovery_run_locked');
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await work(); }
  finally { await releaseOwnedLock(); }
}

export interface Journal {
  append: (phase: string, data?: unknown) => Promise<void>;
}
/** Checkpoints are audit facts, never a substitute for fresh server readback. */
export async function openJournal(path: string, manifestSha: string, operation: string, mode: 'apply' | 'resume', beforeWrite?: (phase: string) => Promise<void>): Promise<Journal> {
  path = platformPath(path); await parentSafe(path);
  if (mode === 'apply') { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)); }
  else if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error('recovery_journal_unavailable');
  const files = (await readdir(path)).sort();
  if (files.some(n => !/^\d{8}\.json$/.test(n))) throw new Error('unknown_recovery_journal_file');
  let sequence = 0; let previous = manifestSha;
  let torn: Array<{ file: string; sha256: string }> = [];
  for (const name of files) {
    if (name !== `${String(++sequence).padStart(8,'0')}.json`) throw new Error('recovery_journal_sequence_gap');
    const snapshot = await readStable(join(path, name), 1024 * 1024);
    let record: Record<string, unknown>;
    try { record = JSON.parse(snapshot.text) as Record<string, unknown>; }
    catch {
      // Only an explicitly hash-bound acknowledgment can bridge interrupted
      // appends. That acknowledgment remains traversable on every later resume.
      torn.push({ file: name, sha256: snapshot.sha256 });
      previous = snapshot.sha256; continue;
    }
    if (record.operation_id !== operation || record.manifest_sha256 !== manifestSha || record.sequence !== sequence || record.previous_sha256 !== previous) throw new Error('recovery_journal_binding_conflict');
    if (torn.length && (record.phase !== 'interrupted_checkpoints_retained' || !isDeepStrictEqual(record.data, { files: torn }))) throw new Error('corrupt_recovery_journal');
    torn = [];
    previous = snapshot.sha256;
  }
  const journal: Journal = { append: async (phase, data = null) => {
    await beforeWrite?.(phase);
    const record = { operation_id: operation, manifest_sha256: manifestSha, sequence: sequence + 1, previous_sha256: previous, phase, recorded_at: new Date().toISOString(), data };
    const name = join(path, `${String(sequence + 1).padStart(8,'0')}.json`);
    await writeExclusive(name, record); sequence++;
    previous = sha256(JSON.stringify(record, null, 2) + '\n');
  } };
  if (torn.length) await journal.append('interrupted_checkpoints_retained', { files: torn });
  return journal;
}
