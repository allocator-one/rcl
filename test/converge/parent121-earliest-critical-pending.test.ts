import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { validateRetainedNativeEvidence, verifyNativeRecoveryLineage } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { legacyFixture, sha, target } from '../evidence/recovery-validation/fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(['pure', 'filesystem'] as const)('%s migration retains an earlier critical obligation ahead of later pending evidence', async consumer => {
  const f = legacyFixture();
  Object.assign(f.state.findings[f.key], { firstRound: 1, lastRound: 5, severity: 'important',
    verdict: 'dismissed', verdictRound: 3, verdictSeverity: 'important', pendingRound: 5 });
  delete f.state.lastAnnotations;
  for (let round = 2; round <= 5; round++) f.state.rounds.push({ round,
    counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 },
    severities: { [f.key]: round === 2 ? 'critical' : 'important' } });
  const original = JSON.stringify(f.state);
  expect(verifyNativeRecoveryLineage(original, target).state.findings[f.key]!.pendingRound).toBe(5);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl121-earliest-critical-'))); roots.push(root);
  const path = convergeRunStatePath(root, target);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const snapshotPath = `${path}.v1-${sha(original)}.snapshot`;
  await writeFile(snapshotPath, original, { mode: 0o600 });
  const current = { ...structuredClone(f.state), version: 2, sightings: [],
    migration: { sourceSha256: sha(original), snapshotPath, migratedAt: '2026-09-27T12:00:00Z' } };
  const read = async () => {
    const sourceJson = JSON.stringify(current);
    if (consumer === 'pure') return validateRetainedNativeEvidence({ sourceJson, target, reports: [], nativeSourceJsons: [original] });
    await writeFile(path, sourceJson, { mode: 0o600 });
    return loadConvergeRunState(root, target);
  };
  await expect(read()).rejects.toThrow();
  current.findings[f.key].pendingRound = 2;
  const result = await read();
  const loaded = consumer === 'pure' ? (result as any).state : result;
  expect(loaded.findings[f.key]).toMatchObject({ pendingRound: 2, verdict: 'dismissed', verdictRound: 3,
    verdictSeverity: 'important' });
  expect(loaded.rounds).toEqual(f.state.rounds);
  expect(loaded.roundCap).toBe(f.state.roundCap);
  expect(await readFile(snapshotPath, 'utf8')).toBe(original);
});
