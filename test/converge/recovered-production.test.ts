import { mkdtemp, readFile, readdir, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { selectRecoveredProduction, materializeRecoveredClaims } from '../../src/converge/recovered-production.js';
import { installRecoveredProduction } from '../fixtures/recovered-production.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import { sha } from '../evidence/recovery-validation/fixtures.js';
const roots: string[] = [];
async function root() { const p = await mkdtemp(join(tmpdir(), 'rcl-recovered-producer-')); roots.push(p); return p; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('selects the complete canonical recovered-v3 predecessor without writes or accounting changes', async () => {
  const dir = await root(); const f = await installRecoveredProduction(dir);
  const before = await readFile(f.path, 'utf8');
  const mode = await selectRecoveredProduction(dir, { target: f.plan.target, round: 2, attempt: 6 });
  expect(mode).toEqual({ version: 1, nativeSha256: sha(before) });
  expect(Object.isFrozen(mode)).toBe(true);
  expect(await readFile(f.path, 'utf8')).toBe(before);
});
it('leaves absent and v1 targets on the unchanged ordinary producer', async () => {
  const dir = await root();
  expect(await selectRecoveredProduction(dir, { target: 'absent', round: 1 })).toBeUndefined();
  expect(await readdir(dir)).toEqual([]);
  const f = await installRecoveredProduction(dir); await writeFile(f.path, f.sourceJson);
  expect(await selectRecoveredProduction(dir, { target: f.plan.target, round: 2 })).toBeUndefined();
  expect(await readFile(f.path, 'utf8')).toBe(f.sourceJson);
  const findings = [sampleFinding()];
  expect(materializeRecoveredClaims(findings, undefined)).toBe(findings);
});
it.each(['predecessor', 'original', 'receipt', 'target'] as const)('refuses changed %s proof before selecting provider mode', async missing => {
  const dir = await root(); const f = await installRecoveredProduction(dir);
  if (missing === 'predecessor') await rm(`${f.path}.recovery-sources/${f.plan.sourceSha256}.json`);
  if (missing === 'original') await rm(`${f.path}.evidence/${sha(f.reportJson)}.json`);
  if (missing === 'receipt' || missing === 'target') {
    const state = JSON.parse(f.plan.resultJson);
    if (missing === 'receipt') state.recovery.operations[0].sourceReceipts = [];
    else state.target = 'other-target';
    await writeFile(f.path, JSON.stringify(state));
  }
  const before = await readFile(f.path, 'utf8');
  await expect(selectRecoveredProduction(dir, { target: f.plan.target, round: 2 })).rejects.toThrow();
  expect(await readFile(f.path, 'utf8')).toBe(before);
});
it.each([undefined, 1, 3, 16])('refuses a recovered review for non-next round %s before providers', async round => {
  const dir = await root(); const f = await installRecoveredProduction(dir);
  await expect(selectRecoveredProduction(dir, { target: f.plan.target, round })).rejects.toThrow(/round/i);
});
it('materializes fresh kept and appendix descriptors only for the selected recovery mode', async () => {
  const dir = await root(); const f = await installRecoveredProduction(dir);
  const mode = await selectRecoveredProduction(dir, { target: f.plan.target, round: 2 });
  const findings = [sampleFinding(), sampleFinding({ title: 'Independent appendix claim', description: 'Independent appendix evidence.' })];
  const before = JSON.stringify(findings);
  const fresh = materializeRecoveredClaims(findings, mode);
  expect(fresh).toHaveLength(2);
  expect(fresh.every(finding => finding.claimDescriptor?.version === 1)).toBe(true);
  expect(fresh[0]!.claimDescriptor).not.toEqual(fresh[1]!.claimDescriptor);
  expect(JSON.stringify(findings)).toBe(before);
});

it.each(['symlink', 'missing'] as const)('refuses a %s native file without falling back to ordinary production', async kind => {
  const dir = await root(); const f = await installRecoveredProduction(dir);
  if (kind === 'symlink') { await rename(f.path, `${f.path}.moved`); await symlink(`${f.path}.moved`, f.path); }
  else await rm(f.path);
  await expect(selectRecoveredProduction(dir, { target: f.plan.target, round: 2 })).rejects.toThrow(/symlink|unavailable/);
});
