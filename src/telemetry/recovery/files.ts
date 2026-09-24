import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const MAX_REPORT_BYTES = 25 * 1024 * 1024;

export function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Only the operating system's standard aliases may precede an explicit reference. */
export function platformPath(path: string): string {
  const absolute = resolve(path);
  if (process.platform !== 'darwin') return absolute;
  return absolute.replace(/^\/tmp(?=\/|$)/, '/private/tmp').replace(/^\/var(?=\/|$)/, '/private/var');
}

/** Stable, bounded, regular-file read. In particular, opening a FIFO cannot block. */
export async function readStable(path: string, limit = MAX_REPORT_BYTES, options: { sync?: boolean } = {}): Promise<{ text: string; raw: Buffer; sha256: string; mtime: string }> {
  return readStableFile(path, limit, options, true);
}

/** Ordinary native storage preserves platform compatibility; it does not qualify recovery inputs. */
export function readOrdinaryNativeFile(path: string, limit = MAX_REPORT_BYTES, options: { sync?: boolean } = {}): ReturnType<typeof readStable> {
  return readStableFile(path, limit, options, false);
}

async function readStableFile(path: string, limit: number, options: { sync?: boolean }, strict: boolean): ReturnType<typeof readStable> {
  if (strict && (constants.O_NOFOLLOW === undefined || constants.O_NONBLOCK === undefined)) throw new Error('safe_file_flags_unavailable');
  const canonical = platformPath(path);
  if (await realpath(dirname(canonical)) !== dirname(canonical)) throw new Error('symlink_directory');
  const entry = await lstat(canonical);
  if (!entry.isFile()) throw new Error(entry.isSymbolicLink() ? 'symlink_file' : 'not_regular');
  const flags = !strict && options.sync ? constants.O_RDWR : constants.O_RDONLY;
  const handle = await open(canonical, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('not_regular');
    if (entry.ino !== before.ino || entry.dev !== before.dev) throw new Error('changing_source');
    if (before.size > limit) throw new Error('oversized');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    // Resuming a retained write can require a fresh durability acknowledgment.
    // Keep the flush inside the same descriptor and subsequent stability checks.
    if (options.sync) await handle.sync();
    const after = await handle.stat();
    const current = await lstat(canonical);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev ||
        current.ino !== before.ino || current.dev !== before.dev || !current.isFile() ||
        await realpath(dirname(canonical)) !== dirname(canonical)) throw new Error('changing_source');
    const raw = buffer.subarray(0, length);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new Error('invalid_utf8'); }
    return { raw, text, sha256: sha256(raw), mtime: before.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

/** Local manifests contain evidence, so neither partial writes nor broad permissions are acceptable. */
export async function writeRecoveryArtifact(path: string, value: unknown): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomBytes(12).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  try {
    // Exclusive publication cannot overwrite a source report or a reviewed plan.
    await link(temporary, destination);
  } finally {
    await unlink(temporary);
  }
}

/** Never echo parser messages or source content in discovery diagnostics. */
export function fileFailure(error: unknown): string {
  const known = new Set(['safe_file_flags_unavailable', 'symlink_directory', 'symlink_file', 'not_regular', 'oversized', 'changing_source', 'invalid_utf8']);
  if (error instanceof Error && known.has(error.message)) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'unreadable';
}

/** Explicit synthetic markers apply to referenced files and every retained alias. */
export async function hasSyntheticAncestor(path: string, cache = new Map<string, boolean>()): Promise<boolean> {
  const directory = dirname(platformPath(path));
  const cached = cache.get(directory);
  if (cached !== undefined) return cached;
  let marked = false;
  try { marked = (await lstat(resolve(directory, 'SYNTHETIC_TEST_ONLY'))).isFile(); }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  const found = marked || (directory !== dirname(directory) && await hasSyntheticAncestor(directory, cache));
  cache.set(directory, found);
  return found;
}
