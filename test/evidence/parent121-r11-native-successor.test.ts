import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { migratedLegacyPendingRound as pure } from '../../src/evidence/claim-recovery/validation/obligations.js';
import { migratedLegacyPendingRound as native } from '../../src/converge/semantic-state.js';
import { validateRetainedNativeEvidence, verifyNativeRecoveryLineage } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { applyNativeRecovery, deriveNativeRecovery, effectivePendingIdentities } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { legacyFixture, recoveredFixture, sha, target, uuid } from './recovery-validation/fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const cases = ['weak-fixed', 'later-weak-dismissed'] as const;
type Scenario = typeof cases[number];
const independentKey = '9999999999999999';
function weakVerdict(state: any, templateKey: string, scenario: Scenario, key = templateKey) {
  state.findings[key] = { ...structuredClone(state.findings[templateKey]), key, firstRound: 1,
    lastRound: scenario === 'weak-fixed' ? 1 : 2, severity: 'critical',
    verdict: scenario === 'weak-fixed' ? 'fixed' : 'dismissed',
    verdictRound: scenario === 'weak-fixed' ? 1 : 2, verdictSeverity: 'important' };
  delete state.findings[key].pendingRound;
  delete state.lastAnnotations;
  if (scenario === 'weak-fixed') {
    // Real v1 ledgerless history uses the retained critical entry severity.
    // Do not invent an inconsistent important verdict in a critical verdict-round ledger.
    delete state.rounds[0].severities;
  } else {
    state.rounds[0].severities = { ...state.rounds[0].severities, [key]: 'critical' };
    state.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 1, regating: 0 },
      severities: { [key]: 'important' } });
  }
  return state;
}
function acceptedLegacy(state: any) {
  expect(state.version).toBe(1);
  return verifyNativeRecoveryLineage(JSON.stringify(state), state.target).state;
}

it.each(cases)('%s cannot erase a parser-accepted critical obligation in either helper', scenario => {
  const f = legacyFixture(); weakVerdict(f.state, f.key, scenario);
  const accepted = acceptedLegacy(f.state), before = JSON.stringify(accepted);
  expect({ pure: pure(accepted.findings[f.key]!, accepted), native: native(accepted.findings[f.key]!, accepted) })
    .toEqual({ pure: 1, native: 1 });
  expect(JSON.stringify(accepted)).toBe(before);
});

it.each(cases.flatMap(scenario => (['filesystem', 'pure'] as const).map(consumer => ({ scenario, consumer }))))
('$scenario $consumer migration refuses to lose the original critical obligation', async ({ scenario, consumer }) => {
  const f = legacyFixture(); weakVerdict(f.state, f.key, scenario); acceptedLegacy(f.state);
  const original = JSON.stringify(f.state);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-r11-migration-'))); roots.push(root);
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
  current.findings[f.key].pendingRound = 1;
  const result = await read();
  const state = consumer === 'pure' ? (result as any).state : result;
  expect(state.findings[f.key]).toMatchObject({ pendingRound: 1, severity: 'critical', verdictSeverity: 'important' });
  expect(await readFile(snapshotPath, 'utf8')).toBe(original);
});

it.each(cases)('%s actual recovery apply and reload preserve the independent critical identity', async scenario => {
  const f = recoveredFixture();
  const source = weakVerdict(JSON.parse(f.sourceJson), f.selection.previousIdentity, scenario, independentKey);
  acceptedLegacy(source); const sourceJson = JSON.stringify(source);
  const selection = { ...f.selection, nativeJson: sourceJson };
  const event = prepareClaimSplit(selection).event;
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), converge_target: target, round: 1, attempt: null };
  const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(8));
  const plan = deriveNativeRecovery({ sourceJson, target, operationId: uuid(8), anchors: [anchor],
    reports: [f.reportJson], sourceReceipts: selection.sourceReceipts });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-r11-apply-'))); roots.push(root);
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
