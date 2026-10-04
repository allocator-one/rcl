import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { migratedLegacyPendingRound as pure } from '../../src/evidence/claim-recovery/validation/obligations.js';
import { migratedLegacyPendingRound as native } from '../../src/converge/semantic-state.js';
import { validateRetainedNativeEvidence, verifyNativeRecoveryLineage } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { applyNativeRecovery, deriveNativeRecovery, effectivePendingIdentities } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath, loadConvergeRunState } from '../../src/converge/run-state.js';
import { claimConvergeAttempt, convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { legacyFixture, recoveredFixture, sha, target, uuid } from '../evidence/recovery-validation/fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const scenarios = ['important-fixed', 'critical-fixed', 'critical-dismissed', 'later-important-dismissed'] as const;
type Scenario = typeof scenarios[number];
const independentKey = '9999999999999999';

function laterCritical(state: any, templateKey: string, scenario: Scenario, key = templateKey) {
  const initialCritical = scenario.startsWith('critical');
  const laterDismissal = scenario === 'later-important-dismissed';
  state.findings[key] = { ...structuredClone(state.findings[templateKey]), key, firstRound: 1,
    lastRound: laterDismissal ? 3 : 2, severity: 'critical',
    verdict: scenario.endsWith('fixed') ? 'fixed' : 'dismissed', verdictRound: laterDismissal ? 3 : 1,
    verdictSeverity: initialCritical ? 'critical' : 'important' };
  delete state.findings[key].pendingRound;
  delete state.lastAnnotations;
  state.rounds[0].severities = { ...state.rounds[0].severities, [key]: initialCritical ? 'critical' : 'important' };
  state.rounds.push({ round: 2, counts: { new: 0, repeat: 0, suppressed: 0, regating: 1 },
    severities: { [key]: 'critical' } });
  if (laterDismissal) state.rounds.push({ round: 3, counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 },
    severities: { [key]: 'important' } });
  return state;
}

it.each(scenarios.flatMap(scenario => ([['pure', pure], ['native', native]] as const)
  .map(([consumer, derive]) => ({ scenario, consumer, derive }))))
('$scenario keeps the round-two critical obligation through $consumer derivation', ({ scenario, derive }) => {
  const f = legacyFixture(); laterCritical(f.state, f.key, scenario);
  const original = JSON.stringify(f.state);
  const accepted = verifyNativeRecoveryLineage(original, target).state;
  expect(derive(accepted.findings[f.key]!, accepted as any)).toBe(2);
  expect(JSON.stringify(f.state)).toBe(original);
});

it.each(scenarios.flatMap(scenario => (['pure', 'filesystem'] as const).map(consumer => ({ scenario, consumer }))))
('$scenario migration refuses erased critical evidence through $consumer reads', async ({ scenario, consumer }) => {
  const f = legacyFixture(); laterCritical(f.state, f.key, scenario);
  const original = JSON.stringify(f.state);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl121-later-critical-'))); roots.push(root);
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
  const result = await read();
  const state = consumer === 'pure' ? (result as any).state : result;
  expect(state.findings[f.key]).toMatchObject({ pendingRound: 2, verdict: f.state.findings[f.key].verdict,
    verdictRound: f.state.findings[f.key].verdictRound, verdictSeverity: f.state.findings[f.key].verdictSeverity });
  expect(await readFile(snapshotPath, 'utf8')).toBe(original);
});

it.each(scenarios)('%s recovery preserves the independent critical claim and exact spent accounting', async scenario => {
  const f = recoveredFixture();
  const source = laterCritical(JSON.parse(f.sourceJson), f.selection.previousIdentity, scenario, independentKey);
  const sourceJson = JSON.stringify(source);
  expect(verifyNativeRecoveryLineage(sourceJson, target).state.findings[independentKey].lastRound).toBe(source.findings[independentKey].lastRound);
  const selection = { ...f.selection, nativeJson: sourceJson };
  const event = prepareClaimSplit(selection).event;
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), converge_target: target, round: 1, attempt: null };
  const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(8));
  const plan = deriveNativeRecovery({ sourceJson, target, operationId: uuid(8), anchors: [anchor],
    reports: [f.reportJson], sourceReceipts: selection.sourceReceipts });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl121-critical-apply-'))); roots.push(root);
  const path = convergeRunStatePath(root, target); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, sourceJson, { mode: 0o600 });
  const claim = await claimConvergeAttempt({ gitCommonDir: root, target, maxAttempts: 20 });
  const attemptsPath = convergeAttemptStatePath(root, target), attemptsBefore = await readFile(attemptsPath, 'utf8');
  expect(claim.attemptsUsed).toBeGreaterThan(0);
  await withRecoveryTarget(root, target, ownership => applyNativeRecovery({ gitCommonDir: root, plan, ownership }));
  const loaded = (await loadConvergeRunState(root, target))!;
  const content = validateRetainedNativeEvidence({ sourceJson: await readFile(path, 'utf8'), target,
    reports: [f.reportJson], nativeSourceJsons: [sourceJson] });
  expect(loaded.findings[independentKey]).toEqual(source.findings[independentKey]);
  expect(loaded.rounds).toEqual(source.rounds);
  expect(loaded.roundCap).toBe(source.roundCap);
  expect(await readFile(`${path}.recovery-sources/${sha(sourceJson)}.json`, 'utf8')).toBe(sourceJson);
  expect(await readFile(attemptsPath, 'utf8')).toBe(attemptsBefore);
  expect(plan.actionableIdentities).toContain(independentKey);
  expect(effectivePendingIdentities(loaded)).toContain(independentKey);
  expect(content.actionableIdentities).toContain(independentKey);
});
