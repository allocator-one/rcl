import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withRecoveryLock } from '../evidence/original-run/lock.js';
import { withNativeLock } from './native-lock.js';

/** Opaque authority; its started operations drain before the registry is released. */
export interface NativeTargetOwnership { readonly target: string }
type Qualification = 'ordinary' | 'recovery';
interface NativeTargetOptions {
  qualification?: Qualification;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}
interface Registration {
  commonDir: string; target: string; active: boolean; accepting: boolean;
  qualification: Qualification;
  tail: Promise<void>;
  pending: Set<Promise<void>>; errors: unknown[];
}
const registrations = new WeakMap<NativeTargetOwnership, Registration>();

async function scope<T>(commonDir: string, target: string, qualification: Qualification,
  work: (ownership: NativeTargetOwnership) => Promise<T>): Promise<T> {
  const ownership = Object.freeze({ target });
  const registration: Registration = { commonDir, target, qualification, active: true, accepting: true,
    tail: Promise.resolve(), pending: new Set(), errors: [] };
  registrations.set(ownership, registration);
  let value: T | undefined;
  try { value = await work(ownership); }
  catch (error) { registration.errors.push(error); }
  finally {
    registration.accepting = false;
    await Promise.all(registration.pending);
    registration.active = false;
  }
  const errors = [...new Set(registration.errors)];
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'native_target_operations_failed');
  return value as T;
}

/** Ordinary writers share the qualified protocol without inheriting recovery fallback. */
export async function withNativeTarget<T>(gitCommonDir: string, target: string,
  work: (ownership: NativeTargetOwnership) => Promise<T>,
  options: NativeTargetOptions = {}): Promise<T> {
  target = target.trim();
  if (!target) throw new Error('native_target_required');
  const qualification = options.qualification ?? 'ordinary';
  if (qualification !== 'ordinary' && qualification !== 'recovery') throw new Error('native_target_invalid_qualification');
  const commonDir = await realpath(resolve(gitCommonDir));
  const lock = qualification === 'recovery' ? withRecoveryLock : withNativeLock;
  return qualification === 'ordinary'
    ? lock(join(commonDir, 'rcl-native-target-locks'), target, () => scope(commonDir, target, qualification, work), {}, {
      lockTimeoutMs: options.lockTimeoutMs,
      lockRetryMs: options.lockRetryMs,
    })
    : lock(join(commonDir, 'rcl-native-target-locks'), target, () => scope(commonDir, target, qualification, work));
}

/** Explicit recovery entry point: strict qualification cannot silently fall back. */
export function withRecoveryTarget<T>(gitCommonDir: string, target: string,
  work: (ownership: NativeTargetOwnership) => Promise<T>): Promise<T> {
  return withNativeTarget(gitCommonDir, target, work, { qualification: 'recovery' });
}

/** A token cannot authorize another repository, target, or a later invocation. */
export async function assertNativeTargetOwnership(ownership: NativeTargetOwnership,
  gitCommonDir: string, target: string): Promise<void> {
  const registration = registrations.get(ownership);
  const commonDir = await realpath(resolve(gitCommonDir));
  if (!registration?.active || !registration.accepting || registration.target !== target.trim() ||
      registration.commonDir !== commonDir) throw new Error('native_target_not_owned');
}

/** Recovery effects require authority acquired through strict filesystem qualification. */
export async function assertRecoveryTargetOwnership(ownership: NativeTargetOwnership,
  gitCommonDir: string, target: string): Promise<void> {
  await assertNativeTargetOwnership(ownership, gitCommonDir, target);
  if (registrations.get(ownership)?.qualification !== 'recovery') throw new Error('native_target_recovery_not_owned');
}

/**
 * Register synchronously before the first await. Each operation gets explicit
 * child authority, so it may finish its own nested writes while its parent
 * drains; unrelated work cannot reuse a closing token or infer reentrancy.
 * Siblings queue for the entire read/derive/write operation. Each explicit
 * child owns its own queue, so awaited nested writes do not deadlock.
 */
export function withOwnedNativeOperation<T>(ownership: NativeTargetOwnership, gitCommonDir: string, target: string,
  work: (operation: NativeTargetOwnership) => Promise<T>): Promise<T> {
  const registration = registrations.get(ownership);
  if (!registration?.active || !registration.accepting || registration.target !== target.trim()) {
    return Promise.reject(new Error('native_target_not_owned'));
  }
  const operation = registration.tail.then(() => scope(registration.commonDir, registration.target, registration.qualification, async child => {
    await assertNativeTargetOwnership(child, gitCommonDir, target);
    return work(child);
  }));
  const completion = operation.then(() => {}, error => { registration.errors.push(error); });
  registration.tail = completion;
  registration.pending.add(completion);
  void completion.then(() => { registration.pending.delete(completion); });
  return operation;
}
