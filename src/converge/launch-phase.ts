import { realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LOCK_UUID } from '../evidence/original-run/lock-scope.js';
import { readStable, sha256 } from '../telemetry/recovery/files.js';
import { writeNativeStateExclusive } from './native-lock.js';
import { ownedNativeTargetCommonDir, type NativeTargetOwnership } from './target-ownership.js';

async function currentMarker(gitCommonDir: string, target: string) {
  const root = join(await realpath(resolve(gitCommonDir)), 'rcl-native-target-locks');
  const key = sha256(target.trim());
  const lock = join(root, `${key}.lock`);
  const text = (await readStable(lock, 2048)).text;
  const owner = JSON.parse(text) as { pid?: unknown; token?: unknown };
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1 ||
      typeof owner.token !== 'string' || !LOCK_UUID.test(owner.token)) throw new Error('invalid_launch_preflight_owner');
  return { lock, text, pid: owner.pid as number, path: join(root, `${key}.${owner.token}.launching`) };
}

/** This acquisition's preflight marker never changes the original pending claim or its process identity. */
export async function withLaunchPreflight<T>(ownership: NativeTargetOwnership, gitCommonDir: string, target: string,
  work: () => Promise<T>): Promise<T> {
  const common = await ownedNativeTargetCommonDir(ownership, gitCommonDir, target);
  const marker = await currentMarker(common, target);
  if (marker.pid !== process.pid) throw new Error('launch_preflight_not_owned');
  await writeNativeStateExclusive(marker.path, { version: 1, pid: process.pid });
  let failed = false, failure: unknown;
  try { return await work(); }
  catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { await finishLaunchPreflight(ownership, common, target); }
    catch (error) {
      if (failed) throw new AggregateError([failure, error], 'launch_preflight_cleanup_failed', { cause: failure });
      throw error;
    }
  }
}

/** A newly registered or resumed council has passed preflight under this acquisition. */
export async function finishLaunchPreflight(ownership: NativeTargetOwnership, gitCommonDir: string, target: string): Promise<void> {
  const common = await ownedNativeTargetCommonDir(ownership, gitCommonDir, target);
  const marker = await currentMarker(common, target);
  if (marker.pid !== process.pid) throw new Error('launch_preflight_not_owned');
  try { await unlink(marker.path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Read only the current lock generation's phase; orphaned markers cannot describe a later acquisition. */
export async function isLaunchPreflight(gitCommonDir: string, target: string): Promise<boolean> {
  try {
    const marker = await currentMarker(gitCommonDir, target);
    const phase = JSON.parse((await readStable(marker.path, 128)).text) as { version?: unknown; pid?: unknown };
    if (phase.version !== 1 || phase.pid !== marker.pid) throw new Error('invalid_launch_preflight_marker');
    return (await readStable(marker.lock, 2048)).text === marker.text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
