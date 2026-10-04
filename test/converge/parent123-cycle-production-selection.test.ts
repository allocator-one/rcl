import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { releasedCycleFixture } from '../evidence/recovery-validation/fixtures.js';
import { selectRecoveredProduction } from '../../src/converge/recovered-production.js';
import { retainedCycleFixture } from '../fixtures/parent123-retained-cycle.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { packNativeMaterial } from '../../src/evidence/claim-recovery/validation/native-material.js';
import { validateNativeRecoveryState } from '../../src/converge/recovery-state.js';
import { sha } from '../evidence/recovery-validation/fixtures.js';

const roots: string[] = [];
const retained = await retainedCycleFixture();
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('preserves ordinary production for a genuine released cycle-v2 native document', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl123-cycle-select-')));
  roots.push(root);
  await mkdir(join(root, 'rcl-converge-runs'), { mode: 0o700 });
  const f = await releasedCycleFixture(root);
  const native = await readFile(f.runPath, 'utf8');
  await expect(selectRecoveredProduction(root, { target: f.selection.target, round: 2 })).resolves.toBeUndefined();
  expect(await readFile(f.runPath, 'utf8')).toBe(native);
  expect(await readFile(f.attemptPath, 'utf8')).toBe(f.attemptsJson);
  expect(await readFile(f.archivePath, 'utf8')).toBe(f.archiveJson);
});

it.each([
  ['source', 'corrupt'], ['source', 'delete'],
  ['material', 'corrupt'], ['material', 'delete'],
  ['report', 'corrupt'], ['report', 'delete'],
] as const)('refuses cycle-v3 recovered production when retained %s bytes are %s before attempt work', async (kind, damage) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl123-cycle-recovered-select-')));
  roots.push(root);
  const target = retained.plan.target, path = convergeRunStatePath(root, target);
  const state = JSON.parse(retained.plan.resultJson), operation = state.recovery.operations.at(-1)!;
  const packed = packNativeMaterial({ occurrences: operation.occurrences });
  state.recovery.version = 2; operation.material = packed.reference; delete operation.occurrences;
  const native = `${JSON.stringify(state, null, 2)}\n`;
  const sourcePath = `${path}.recovery-sources/${sha(retained.plan.sourceJson)}.json`;
  const reportPath = `${path}.evidence/${sha(retained.plan.reports[0]!)}.json`;
  const materialPath = `${path}.recovery-materials/${packed.materials[0]!.sha256}`;
  for (const [file, raw] of [[path, native], [sourcePath, retained.plan.sourceJson],
    [reportPath, retained.plan.reports[0]!],
    ...packed.materials.map(row => [`${path}.recovery-materials/${row.sha256}`, row.text])] as Array<[string, string]>) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, raw, { mode: 0o600 });
  }
  await expect(validateNativeRecoveryState(state, root, Buffer.from(native))).resolves.toBeUndefined();
  const damaged = kind === 'source' ? sourcePath : kind === 'material' ? materialPath : reportPath;
  if (damage === 'delete') await unlink(damaged); else await writeFile(damaged, 'tampered retained evidence');
  await expect(selectRecoveredProduction(root, { target, round: 2 })).rejects.toThrow('native_recovery_state_invalid');
  await expect(loadConvergeAttemptState(root, target)).resolves.toBeUndefined();
});
