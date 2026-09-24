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
  await writeExclusiveBytes(path, Buffer.from(serializeRecoveryDocument(value, limit)));
}
/** Exact original bytes with the same exclusive, fsynced recovery publication contract. */
export async function writeExclusiveBytes(path: string, bytes: Buffer): Promise<void> {
  const pinned = Buffer.from(bytes);
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
/** Checkpoints are audit facts, never a substitute for fresh server readback. */
export async function openJournal(path: string, manifestSha: string, operation: string, mode: 'apply' | 'resume', beforeWrite?: (phase: string) => Promise<void>): Promise<Journal> {
  path = platformPath(path); await parentSafe(path);
  await inspectJournalDirectory(dirname(path), false);
  if (mode === 'apply') { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)); }
  else if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw new Error('recovery_journal_unavailable');
  await inspectJournalDirectory(path, true);
  const directory = await lstat(path, { bigint: true });
  const files = (await readdir(path)).sort();
  if (files.some(n => !/^\d{8}\.json$/.test(n))) throw new Error('unknown_recovery_journal_file');
  let sequence = 0; let previous = manifestSha;
  let torn: Array<{ file: string; sha256: string }> = [];
  for (const name of files) {
    if (name !== `${String(++sequence).padStart(8,'0')}.json`) throw new Error('recovery_journal_sequence_gap');
    const snapshot = await readStable(join(path, name), MAX_RECOVERY_CHECKPOINT_BYTES);
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
    const current = await lstat(path, { bigint: true });
    if (!current.isDirectory() || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error('recovery_journal_replaced');
    const record = { operation_id: operation, manifest_sha256: manifestSha, sequence: sequence + 1, previous_sha256: previous, phase, recorded_at: new Date().toISOString(), data };
    const name = join(path, `${String(sequence + 1).padStart(8,'0')}.json`);
    await writeExclusive(name, record, MAX_RECOVERY_CHECKPOINT_BYTES); sequence++;
    previous = sha256(JSON.stringify(record, null, 2) + '\n');
  } };
  if (torn.length) await journal.append('interrupted_checkpoints_retained', { files: torn });
  return journal;
}
