import { expect, it } from 'vitest';
import { validateRetainedNativeEvidence } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { legacyFixture, semanticFixture, sha, target, uuid } from './fixtures.js';

it('validates v1 content without assigning a descriptor, sighting or migration', () => {
  const f = legacyFixture(); const input = f.input(); const before = structuredClone(input);
  const result = validateRetainedNativeEvidence(input);
  expect(result).toMatchObject({ qualification: 'content-only', state: f.state });
  expect(result.state.findings[f.key]).not.toHaveProperty('claimDescriptor');
  expect(result.state).not.toHaveProperty('sightings');
  expect(result.state).not.toHaveProperty('migration');
  expect(input).toEqual(before);
});

it('accepts exact retained v2 report membership without running a producer', () => {
  const f = semanticFixture(); const input = f.input(); const before = structuredClone(input);
  const result = validateRetainedNativeEvidence(input);
  expect(result).toMatchObject({ qualification: 'content-only', state: f.state });
  expect(input).toEqual(before);
});

it('accepts legacy-to-v2 lineage only with exact retained original bytes', () => {
  const f = legacyFixture(); const original = JSON.stringify(f.state);
  const current = { ...f.state, version: 2, sightings: [],
    findings: { [f.key]: { ...f.state.findings[f.key], pendingRound: 1 } },
    migration: { sourceSha256: sha(original), snapshotPath: `/synthetic/native.v1-${sha(original)}.snapshot`, migratedAt: '2026-09-22T01:00:00Z' } };
  expect(validateRetainedNativeEvidence({ sourceJson: JSON.stringify(current), target, reports: [], nativeSourceJsons: [original] }).state).toEqual(current);
});

it.each(['report-bytes', 'digest', 'run', 'target', 'round', 'ref', 'key', 'descriptor', 'category', 'location', 'counts', 'severity', 'pending', 'annotation', 'missing-member'])
('refuses retained v2 %s tampering', change => {
  const f = semanticFixture(); const input = f.input(); const state = JSON.parse(input.sourceJson);
  if (change === 'report-bytes') input.reports[0] += ' ';
  if (change === 'digest') state.rounds[0].reportBinding.reportSha256 = 'b'.repeat(64);
  if (change === 'run') state.rounds[0].runId = '00000000-0000-7000-8000-000000000099';
  if (change === 'target') state.rounds[0].reportBinding.target = 'other-target';
  if (change === 'round') state.rounds[0].reportBinding.round = 2;
  if (change === 'ref') state.sightings[0].findingRef = 'f002';
  if (change === 'key') state.sightings[0].reportKey = 'another-original';
  if (change === 'descriptor') state.sightings[0].claimDescriptor.invariant = 'A separate different assertion';
  if (change === 'category') state.sightings[0].category = 'security';
  if (change === 'location') state.sightings[0].startLine = 9;
  if (change === 'counts') state.rounds[0].counts.new = 2;
  if (change === 'severity') state.rounds[0].severities[f.key] = 'minor';
  if (change === 'pending') delete state.findings[f.key].pendingRound;
  if (change === 'annotation') state.lastAnnotations.identities[0].status = 'repeat';
  if (change === 'missing-member') state.sightings = [];
  input.sourceJson = JSON.stringify(state);
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
});

it.each(['duplicate-key', 'rounded-counter', 'wrong-target', 'extra-recovery', 'unsupported-version'])
('refuses ambiguous or unsupported source %s', change => {
  const f = legacyFixture(); const input = f.input();
  if (change === 'duplicate-key') input.sourceJson = input.sourceJson.replace('"version":1', '"version":2,"version":1');
  if (change === 'rounded-counter') input.sourceJson = input.sourceJson.replace('"roundCap":15', '"roundCap":15.0000000000000001');
  if (change === 'wrong-target') input.target = 'other-target';
  if (change === 'extra-recovery') input.sourceJson = JSON.stringify({ ...f.state, recovery: { version: 1, operations: [] } });
  if (change === 'unsupported-version') input.sourceJson = JSON.stringify({ ...f.state, version: 4 });
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
});

it('retains a critical pending source despite an earlier important verdict', () => {
  const f = semanticFixture(); const state = JSON.parse(JSON.stringify(f.state));
  const report = structuredClone(f.report); report.run.id = uuid(2); report.run.converge.round = 2;
  report.findings[0]!.identity = `report:${uuid(2)}:critical-repeat`;
  report.findings[0]!.severity = 'critical'; report.findings[0]!.gating.reason = 'critical';
  const reportJson = JSON.stringify(report); const digest = sha(reportJson);
  const binding = { runId: uuid(2), target, round: 2, reportSha256: digest, sourcePath: `/synthetic/native.evidence/${digest}.json` };
  state.rounds.push({ round: 2, runId: uuid(2), reportBinding: binding,
    counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 }, severities: { [f.key]: 'critical' } });
  state.sightings.push({ ...state.sightings[0], runId: uuid(2), round: 2, reportSha256: digest,
    reportKey: report.findings[0]!.identity, severity: 'critical', gating: 'critical', status: 'repeat', pendingRound: 2 });
  Object.assign(state.findings[f.key], { lastRound: 2, severity: 'critical', pendingRound: 2,
    verdict: 'dismissed', verdictRound: 1, verdictSeverity: 'important' });
  state.lastAnnotations = { round: 2, identities: [{ identity: f.key, status: 'repeat', gating: 'critical' }] };
  const input = { sourceJson: JSON.stringify(state), target, reports: [f.reportJson, reportJson] };
  expect(validateRetainedNativeEvidence(input).actionableIdentities).toEqual([f.key]);
  delete state.findings[f.key].pendingRound; input.sourceJson = JSON.stringify(state);
  expect(() => validateRetainedNativeEvidence(input)).toThrow();
});

it('keeps unresolved legacy claims typed separately from producer descriptors and recorded pending rounds', () => {
  const f = legacyFixture(); const result = validateRetainedNativeEvidence(f.input());
  expect(result.legacyClaims).toEqual([{ kind: 'legacy-identity', identity: f.key, migrationPendingRound: 1 }]);
  expect(result.state.findings[f.key]).not.toHaveProperty('pendingRound');
  expect(result.state.findings[f.key]).not.toHaveProperty('claimDescriptor');
});
