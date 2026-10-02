import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { migratedLegacyPendingRound as pure } from '../../src/evidence/claim-recovery/validation/obligations.js';
import { migratedLegacyPendingRound as native } from '../../src/converge/semantic-state.js';
import { validateRetainedNativeEvidence } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { deriveCurrentClaimProjection } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import { applyNativeRecovery, deriveNativeRecovery, effectivePendingIdentities } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { legacyFixture, recoveredFixture, sha, target, uuid } from './recovery-validation/fixtures.js';
import { setup } from './parent-r9-projection-fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const independentKey = '9999999999999999';
function addEarlyVerdict(state: any, templateKey: string, key = templateKey) {
  delete state.rounds[0].severities;
  state.rounds.push({ round: 2, counts: { new: 1, repeat: 0, suppressed: 0, regating: 0 }, severities: { [key]: 'important' } });
  state.findings[key] = { ...structuredClone(state.findings[templateKey]), key, firstRound: 2, lastRound: 2,
    severity: 'important', verdict: 'fixed', verdictRound: 1, verdictSeverity: 'important' };
  delete state.findings[key].pendingRound;
  delete state.lastAnnotations;
  return state;
}

it.each([['native', native]] as const)('%s preserves chronology and valid later regating', (_label, derive) => {
  const f = legacyFixture(); addEarlyVerdict(f.state, f.key);
  const before = JSON.stringify(f.state);
  expect(derive(f.state.findings[f.key], f.state as any)).toBe(2);
  expect(JSON.stringify(f.state)).toBe(before);
  const entry = f.state.findings[f.key];
  Object.assign(entry, { firstRound: 1, lastRound: 3, pendingRound: 1, verdict: 'dismissed', verdictRound: 2 });
  f.state.rounds.push({ round: 3, counts: { new: 0, repeat: 0, suppressed: 0, regating: 1 } });
  f.state.lastAnnotations = { round: 3, identities: [{ identity: f.key, status: 'regating', gating: 'consensus' }] };
  expect(derive(entry, f.state as any)).toBe(3);
  f.state.rounds[0].severities = { [f.key]: 'critical' };
  expect(derive(entry, f.state as any)).toBe(1);
});

it('native helper handles the same large retained-history bound as the donor helper', () => {
  const f = legacyFixture(); const entry = f.state.findings[f.key];
  Object.assign(entry, { verdict: 'dismissed', verdictRound: 1, verdictSeverity: 'important' });
  f.state.rounds = Array.from({ length: 140_000 }, (_, index) => ({ round: index + 1,
    counts: { new: 0, repeat: 0, suppressed: 0, regating: 0 }, severities: { [f.key]: 'critical' } }));
  expect(native(entry, f.state as any)).toBe(1);
});

it.each(['filesystem'] as const)('%s migration refuses the erased obligation despite an earlier legacy verdict', async consumer => {
  const f = legacyFixture(); addEarlyVerdict(f.state, f.key);
  const original = JSON.stringify(f.state);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-r10-migration-'))); roots.push(root);
  const path = convergeRunStatePath(root, target); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const snapshotPath = `${path}.v1-${sha(original)}.snapshot`;
  await writeFile(snapshotPath, original, { mode: 0o600 });
  const current = { ...structuredClone(f.state), version: 2, sightings: [],
    migration: { sourceSha256: sha(original), snapshotPath, migratedAt: '2026-09-22T01:00:00Z' } };
  const read = async () => {
    const raw = JSON.stringify(current);
    if (consumer === 'pure') return validateRetainedNativeEvidence({ sourceJson: raw, target, reports: [], nativeSourceJsons: [original] });
    await writeFile(path, raw, { mode: 0o600 }); return loadConvergeRunState(root, target);
  };
  await expect(read()).rejects.toThrow();
  current.findings[f.key].pendingRound = 2;
  const accepted = await read();
  const state = consumer === 'pure' ? (accepted as any).state : accepted;
  expect(state.findings[f.key]).toMatchObject({ pendingRound: 2, verdict: 'fixed', verdictRound: 1 });
  expect(await readFile(snapshotPath, 'utf8')).toBe(original);
});

it('actual v3 recovery apply and reload retain the independent malformed-chronology obligation', async () => {
  const f = recoveredFixture();
  const source = addEarlyVerdict(JSON.parse(f.sourceJson), f.selection.previousIdentity, independentKey);
  const sourceJson = JSON.stringify(source);
  const selection = { ...f.selection, nativeJson: sourceJson };
  const event = prepareClaimSplit(selection).event;
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), converge_target: target, round: 1, attempt: null };
  const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(8));
  const plan = deriveNativeRecovery({ sourceJson, target, operationId: uuid(8), anchors: [anchor],
    reports: [f.reportJson], sourceReceipts: selection.sourceReceipts });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-r10-apply-'))); roots.push(root);
  const path = convergeRunStatePath(root, target); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, sourceJson, { mode: 0o600 });
  await withRecoveryTarget(root, target, ownership => applyNativeRecovery({ gitCommonDir: root, plan, ownership }));
  const loaded = (await loadConvergeRunState(root, target))!;
  const content = validateRetainedNativeEvidence({ sourceJson: await readFile(path, 'utf8'), target,
    reports: [f.reportJson], nativeSourceJsons: [sourceJson] });
  expect(loaded.findings[independentKey]).toEqual(source.findings[independentKey]);
  expect(await readFile(`${path}.recovery-sources/${sha(sourceJson)}.json`, 'utf8')).toBe(sourceJson);
  expect(plan.actionableIdentities).toContain(independentKey);
  expect(effectivePendingIdentities(loaded)).toContain(independentKey);
  expect(content.actionableIdentities).toContain(independentKey);
});
