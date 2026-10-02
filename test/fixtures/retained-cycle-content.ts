import { afterAll } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releasedCycleFixture } from '../evidence/recovery-validation/fixtures.js';

// Exercise the current public cycle writer without invoking later recovery writers.
export async function retainedCycleFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'retained-cycle-content-')));
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  const fixture = await releasedCycleFixture(root);
  return { bundle: { ...fixture, root, target: fixture.selection.target,
    sourceJson: fixture.selection.nativeJson, nativeJson: fixture.selection.nativeJson,
    reportJson: fixture.selection.reportJson } };
}
