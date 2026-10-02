import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { migratedLegacyPendingRound as pure } from '../../src/evidence/claim-recovery/validation/obligations.js';
import { validateRetainedNativeEvidence, verifyNativeRecoveryLineage } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { deriveCurrentClaimProjection } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { legacyFixture, sha, target, uuid } from './recovery-validation/fixtures.js';
import { setup } from './parent-r9-projection-fixture.js';

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

it.each(cases)('%s cannot erase a parser-accepted critical obligation in the pure helper', scenario => {
  const f = legacyFixture(); weakVerdict(f.state, f.key, scenario);
  const accepted = acceptedLegacy(f.state), before = JSON.stringify(accepted);
  expect(pure(accepted.findings[f.key]!, accepted)).toBe(1);
  expect(JSON.stringify(accepted)).toBe(before);
});

it.each(cases.flatMap(scenario => (['pure'] as const).map(consumer => ({ scenario, consumer }))))
('$scenario $consumer migration refuses to lose the original critical obligation', async ({ scenario }) => {
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
    return validateRetainedNativeEvidence({ sourceJson: raw, target, reports: [], nativeSourceJsons: [original] });
  };
  await expect(read()).rejects.toThrow();
  current.findings[f.key].pendingRound = 1;
  const result = await read();
  const state = result.state;
  expect(state.findings[f.key]).toMatchObject({ pendingRound: 1, severity: 'critical', verdictSeverity: 'important' });
  expect(await readFile(snapshotPath, 'utf8')).toBe(original);
});

it.each(cases)('%s retained-history projection preserves critical pending while the recovered claim stays dismissed', scenario => {
  const f = setup('dismissed');
  weakVerdict(f.state, f.f.transfer.split.selection.previousIdentity, scenario, independentKey);
  acceptedLegacy(f.state);
  if (scenario === 'later-weak-dismissed') {
    f.confirm((report, _stored, event) => {
      const finding = structuredClone(f.f.report.findings[0]);
      finding.identity = `report:${report.run.id}:independent`;
      report.findings = [finding]; const digest = sha(JSON.stringify(report));
      event.payload.identities = [{ identity_key: finding.identity, matched_identity: independentKey, status: 'new',
        version: 1, finding_ref: 'f001', report_json_sha256: digest, claim_descriptor: finding.claimDescriptor,
        match_rationale: 'exact_descriptor', pending_round: 1 }];
    });
    f.state.rounds[1].runId = uuid(900);
  }
  const before = JSON.stringify({ state: f.state, history: f.history });
  const projected = deriveCurrentClaimProjection(f.state, [f.anchor], [{ transfers: [f.transfer],
    dispositions: [f.disposition], carriers: [], pendingIdentities: [] } as any], f.history, [], JSON.stringify(f.state));
  expect(projected.residuals).toEqual([]);
  expect(projected.claims[0]).toMatchObject({ identity: f.anchor.identity, standing: 'dismissed' });
  expect(projected.actionableIdentities).toContain(independentKey);
  expect(JSON.stringify({ state: f.state, history: f.history })).toBe(before);
});
