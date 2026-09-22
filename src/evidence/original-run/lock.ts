import { lstat, open } from 'node:fs/promises';
import { withRegistryLock, RegistryCleanupError, type RegistryHooks, type RegistryRegistration } from '../../coordination/registry-lock.js';
import { checkLockDirectory, prepareLockRoot } from './lock-path.js';
import { localLockScope, validLockScope, type LockScope } from './lock-scope.js';

export type LockRegistration = RegistryRegistration<LockScope>;
export type LockHooks = RegistryHooks<LockScope>;

/** Recovery always qualifies scope, ancestors, ACLs and filesystem before work. */
export async function withRecoveryLock<T>(root: string, identity: string, work: () => Promise<T>, hooks: LockHooks = {}): Promise<T> {
  try {
    return await withRegistryLock(root, identity, work, {
      scope: localLockScope, validScope: validLockScope, prepareRoot: prepareLockRoot,
      inspectRegistry: async path => {
        checkLockDirectory(await lstat(path), process.geteuid!(), true);
        await prepareLockRoot(path);
      },
      sync: async path => {
        const handle = await open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      },
      mayProbePid: () => true,
    }, hooks);
  } catch (error) {
    // Preserve the existing strict recovery API. Its operation journal, not a
    // callback return value, remains the authority for interrupted recovery.
    if (error instanceof RegistryCleanupError) throw error.cause;
    throw error;
  }
}
