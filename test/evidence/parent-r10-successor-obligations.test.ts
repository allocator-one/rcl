import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { migratedLegacyPendingRound as pure } from '../../src/evidence/claim-recovery/validation/obligations.js';
import { validateRetainedNativeEvidence } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { deriveCurrentClaimProjection } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { legacyFixture, sha, target, uuid } from './recovery-validation/fixtures.js';
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

it.each([['pure', pure]] as const)('%s preserves chronology and valid later regating', (_label, derive) => {
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

it.each(['pure'] as const)('%s migration refuses the erased obligation despite an earlier legacy verdict', async () => {
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
    return validateRetainedNativeEvidence({ sourceJson: raw, target, reports: [], nativeSourceJsons: [original] });
  };
  await expect(read()).rejects.toThrow();
  current.findings[f.key].pendingRound = 2;
  const accepted = await read();
  const state = accepted.state;
  expect(state.findings[f.key]).toMatchObject({ pendingRound: 2, verdict: 'fixed', verdictRound: 1 });
  expect(await readFile(snapshotPath, 'utf8')).toBe(original);
});

it('retained-history projection preserves an independent early-verdict obligation while the recovered claim stays dismissed', () => {
  const f = setup('dismissed');
  addEarlyVerdict(f.state, f.f.transfer.split.selection.previousIdentity, independentKey);
  f.confirm((report, _stored, event) => {
    const finding = structuredClone(f.f.report.findings[0]);
    finding.identity = `report:${report.run.id}:independent`;
    report.findings = [finding];
    const digest = sha(JSON.stringify(report));
    event.payload.identities = [{ identity_key: finding.identity, matched_identity: independentKey, status: 'new',
      version: 1, finding_ref: 'f001', report_json_sha256: digest, claim_descriptor: finding.claimDescriptor,
      match_rationale: 'exact_descriptor', pending_round: 2 }];
  });
  f.state.rounds[1].runId = uuid(900);
  const before = JSON.stringify({ state: f.state, history: f.history });
  const projected = deriveCurrentClaimProjection(f.state, [f.anchor], [{ transfers: [f.transfer],
    dispositions: [f.disposition], carriers: [], pendingIdentities: [] } as any], f.history, [], JSON.stringify(f.state));
  expect(projected.residuals).toEqual([]);
  expect(projected.claims[0]).toMatchObject({ identity: f.anchor.identity, standing: 'dismissed' });
  expect(projected.actionableIdentities).toContain(independentKey);
  expect(JSON.stringify({ state: f.state, history: f.history })).toBe(before);
});
