import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { platformPath, readStable, sha256 } from '../../telemetry/recovery/files.js';
import { inspectRecoveryDirectory } from './lock-path.js';

// Prepared checkpoint data copies manifest subtrees at the same indentation,
// except for the destination's extra level and the longer source field name.
// Reserve 1 KiB beyond the manifest for those bytes and the bounded journal
// wrapper (UUID, hashes, sequence, phase and timestamp); do not truncate audit.
export const MAX_RECOVERY_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_RECOVERY_CHECKPOINT_BYTES = MAX_RECOVERY_DOCUMENT_BYTES + 1024;

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
  await writeExclusiveBytes(path, text);
}
/** Preserve original bytes with the same exclusive, fsynced publication contract. */
export async function writeExclusiveBytes(path: string, bytes: string | Uint8Array): Promise<void> {
  const pinned = typeof bytes === 'string' ? bytes : Buffer.from(bytes);
  const file = platformPath(path); await parentSafe(file);
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(pinned); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(file));
}
export { withRecoveryLock } from './lock.js';

async function inspectJournalDirectory(path: string, privateRoot: boolean): Promise<void> {
  try { await inspectRecoveryDirectory(path, privateRoot); }
  catch (error) {
    if (error instanceof Error && /^(unsafe|unsupported)_recovery_lock_/.test(error.message)) {
      throw new Error(error.message.replace('_lock_', '_journal_'));
    }
    throw error;
  }
}

export interface Journal {
  append: (phase: string, data?: unknown) => Promise<void>;
}
export interface JournalCheckpoint {
  operation_id: string; manifest_sha256: string; sequence: number;
  previous_sha256: string; phase: string; recorded_at: string; data: unknown;
}
export interface ReadableJournal extends Journal {
  /** Local audit facts only; a remote acknowledgment still needs exact readback. */
  checkpoints: () => JournalCheckpoint[];
}

/** Storage qualification is explicit; recovery callers retain the strict default. */
export interface JournalStorage {
  inspect: (path: string, privateRoot: boolean) => Promise<void>;
  read: typeof readStable;
  write: typeof writeExclusive;
  sync: typeof syncDirectory;
}
const recoveryStorage: JournalStorage = { inspect: inspectJournalDirectory, read: readStable,
  write: writeExclusive, sync: syncDirectory };

/** Checkpoints are audit facts, never a substitute for fresh server readback. */
export async function openJournal(path: string, manifestSha: string, operation: string, mode: 'apply' | 'resume', beforeWrite?: (phase: string) => Promise<void>, storage: JournalStorage = recoveryStorage): Promise<ReadableJournal> {
  storage = { ...storage };
  path = platformPath(path); await parentSafe(path);
  await storage.inspect(dirname(path), false);
  if (mode === 'apply') { await mkdir(path, { mode: 0o700 }); await storage.sync(dirname(path)); }
  else if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error('recovery_journal_unavailable');
  await storage.inspect(path, true);
  const directory = await lstat(path, { bigint: true });
  const files = (await readdir(path)).sort();
  if (files.some(n => !/^\d{8}\.json$/.test(n))) throw new Error('unknown_recovery_journal_file');
  let sequence = 0; let previous = manifestSha;
  let torn: Array<{ file: string; sha256: string }> = [];
  const checkpoints: JournalCheckpoint[] = [];
  for (const name of files) {
    if (name !== `${String(++sequence).padStart(8,'0')}.json`) throw new Error('recovery_journal_sequence_gap');
    // A prior write may have reached the filesystem before its flush failed.
    // Readable bytes alone are not a new durability acknowledgment.
    const snapshot = await storage.read(join(path, name), MAX_RECOVERY_CHECKPOINT_BYTES, { sync: true });
    let record: Record<string, unknown>;
    try { record = JSON.parse(snapshot.text) as Record<string, unknown>; }
    catch {
      // Only an explicitly hash-bound acknowledgment can bridge interrupted
      // appends. That acknowledgment remains traversable on every later resume.
      torn.push({ file: name, sha256: snapshot.sha256 });
      previous = snapshot.sha256; continue;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid_recovery_checkpoint');
    if (record.operation_id !== operation || record.manifest_sha256 !== manifestSha || record.sequence !== sequence || record.previous_sha256 !== previous) throw new Error('recovery_journal_binding_conflict');
    if (typeof record.phase !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(record.phase) ||
        typeof record.recorded_at !== 'string' || !Number.isFinite(Date.parse(record.recorded_at)) ||
        !Object.hasOwn(record, 'data')) throw new Error('invalid_recovery_checkpoint');
    if (torn.length && (record.phase !== 'interrupted_checkpoints_retained' || !isDeepStrictEqual(record.data, { files: torn }))) throw new Error('corrupt_recovery_journal');
    torn = [];
    previous = snapshot.sha256;
    checkpoints.push(record as unknown as JournalCheckpoint);
  }
  await storage.sync(path);
  await storage.sync(dirname(path));
  const journal: ReadableJournal = { checkpoints: () => structuredClone(checkpoints), append: async (phase, data = null) => {
    if (typeof phase !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(phase)) throw new Error('invalid_recovery_checkpoint');
    const retainedData: unknown = JSON.parse(JSON.stringify(data));
    await beforeWrite?.(phase);
    const current = await lstat(path, { bigint: true });
    if (!current.isDirectory() || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error('recovery_journal_replaced');
    const record = { operation_id: operation, manifest_sha256: manifestSha, sequence: sequence + 1, previous_sha256: previous, phase, recorded_at: new Date().toISOString(), data: retainedData };
    const name = join(path, `${String(sequence + 1).padStart(8,'0')}.json`);
    await storage.write(name, record, MAX_RECOVERY_CHECKPOINT_BYTES); sequence++;
    previous = sha256(JSON.stringify(record, null, 2) + '\n');
    checkpoints.push(record);
  } };
  if (torn.length) await journal.append('interrupted_checkpoints_retained', { files: torn });
  return journal;
}
