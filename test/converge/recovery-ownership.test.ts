import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRecoveryTargetOwnership, withNativeTarget, withOwnedNativeOperation, withRecoveryTarget,
  type NativeTargetOwnership } from '../../src/converge/target-ownership.js';

let dir: string;
const target = 'synthetic-recovery-qualification';
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-recovery-qualification-'))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it('refuses ordinary ownership as authority for recovery effects', async () => {
  let entered = false;
  await withNativeTarget(dir, target, async owner => {
    await expect(withOwnedNativeOperation(owner, dir, target, async child => {
      await assertRecoveryTargetOwnership(child, dir, target);
      entered = true;
    })).rejects.toThrow('native_target_recovery_not_owned');
  }).catch(error => { expect(error.message).toBe('native_target_recovery_not_owned'); });
  expect(entered).toBe(false);
});

it('preserves strict recovery qualification through nested owned operations', async () => {
  await withRecoveryTarget(dir, target, async owner => {
    await assertRecoveryTargetOwnership(owner, dir, target);
    await withOwnedNativeOperation(owner, dir, target, async child => {
      await assertRecoveryTargetOwnership(child, dir, target);
      await withOwnedNativeOperation(child, dir, target,
        grandchild => assertRecoveryTargetOwnership(grandchild, dir, target));
    });
  });
});

it('never lets qualification revive forged, wrong-target or released authority', async () => {
  await expect(assertRecoveryTargetOwnership({ target }, dir, target)).rejects.toThrow('native_target_not_owned');
  let released!: NativeTargetOwnership;
  await withRecoveryTarget(dir, target, async owner => {
    released = owner;
    await expect(assertRecoveryTargetOwnership(owner, dir, 'another')).rejects.toThrow('native_target_not_owned');
  });
  await expect(assertRecoveryTargetOwnership(released, dir, target)).rejects.toThrow('native_target_not_owned');
});
