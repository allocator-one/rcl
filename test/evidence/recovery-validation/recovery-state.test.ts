import { expect, it } from 'vitest';
import { validateRetainedNativeEvidence, verifyNativeRecoveryLineage } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { recoveredFixture, sha, target, uuid } from './fixtures.js';

it.each([1, 2] as const)('revalidates retained v3 from v%i without adding rounds, verdicts or producer sightings', version => {
  const f = recoveredFixture(version); const input = f.input(); const before = structuredClone(input);
  const result = validateRetainedNativeEvidence(input);
  expect(result.qualification).toBe('content-only');
  expect(result.state).toEqual(f.state);
  expect(result.sourceSha256).toBe(sha(input.sourceJson));
  expect(result.reservedIdentities).toEqual([f.anchor.identity]);
  expect(result.actionableIdentities).toContain(f.anchor.identity);
  expect(input).toEqual(before);
  expect(validateRetainedNativeEvidence(input)).toEqual(result);
  expect(result.filesystemRequirements).toContainEqual({ kind: 'native-predecessor', sha256: sha(f.sourceJson),
    nativePathSuffix: `.recovery-sources/${sha(f.sourceJson)}.json` });
  expect(result).not.toHaveProperty('filesystemVerified');
  expect(result).not.toHaveProperty('authenticatedReceipt');
  if (version === 1) {
    expect(result.legacyClaims).toContainEqual({ kind: 'legacy-identity', identity: f.key, migrationPendingRound: 1 });
    expect(result.state.findings[f.key]).not.toHaveProperty('pendingRound');
    expect(result.state.findings[f.key]).not.toHaveProperty('claimDescriptor');
  }
});

it.each(['source-bytes', 'missing-source', 'extra-source', 'source-version', 'duplicate-operation', 'duplicate-anchor',
  'actor', 'time', 'payload', 'destination', 'membership', 'missing-report', 'report-bytes', 'source-receipt',
  'retired-original', 'changed-original-round', 'invented-sighting', 'invented-verdict', 'unknown-operation-field'])
('refuses v3 %s tampering in pure content validation', change => {
  const f = recoveredFixture(); const input = f.input(); const state = JSON.parse(input.sourceJson);
  const operation = state.recovery.operations[0]; const anchor = operation.anchors[0];
  if (change === 'source-bytes') input.nativeSourceJsons[0] += ' ';
  if (change === 'missing-source') input.nativeSourceJsons = [];
  if (change === 'extra-source') input.nativeSourceJsons.push(JSON.stringify({ ...JSON.parse(f.sourceJson), updatedAt: 'unrelated' }));
  if (change === 'source-version') operation.sourceVersion = 2;
  if (change === 'duplicate-operation') state.recovery.operations.push(structuredClone(operation));
  if (change === 'duplicate-anchor') operation.anchors.push(structuredClone(anchor));
  if (change === 'actor') anchor.receipt.actor_user_id = null;
  if (change === 'time') anchor.receipt.occurred_at = '2026-09-22T12:00:00.123457Z';
  if (change === 'payload') anchor.receipt.payload.reason = 'Different accepted assertion';
  if (change === 'destination') anchor.destination.org_id = uuid(99);
  if (change === 'membership') anchor.source.findingRef = 'f002';
  if (change === 'missing-report') input.reports = [];
  if (change === 'report-bytes') input.reports[0] += ' ';
  if (change === 'source-receipt') operation.sourceReceipts[0].payload.identities = [];
  if (change === 'retired-original') delete state.findings[f.key];
  if (change === 'changed-original-round') state.rounds[0].counts.new = 2;
  if (change === 'invented-sighting') state.sightings.push({ canonicalIdentity: anchor.identity, round: 1 });
  if (change === 'invented-verdict') state.findings[f.key].verdict = 'fixed';
  if (change === 'unknown-operation-field') operation.transfers = [{ identity: f.key }];
  input.sourceJson = JSON.stringify(state);
  expect(() => validateRetainedNativeEvidence(input)).toThrow('native_recovery_content_invalid');
});

it('distinguishes lineage proof from full report and receipt content qualification', () => {
  const f = recoveredFixture(); const input = f.input(); const state = JSON.parse(input.sourceJson);
  state.recovery.operations[0].anchors[0].receipt.payload.reason = 'Conflicting receipt';
  input.sourceJson = JSON.stringify(state);
  expect(verifyNativeRecoveryLineage(input.sourceJson, target, input.nativeSourceJsons).reservedIdentities).toEqual([f.anchor.identity]);
  expect(() => validateRetainedNativeEvidence(input)).toThrow('native_recovery_content_invalid');
});

it('returns unperformed canonical-path requirements while preserving exact stored aliases', () => {
  const f = recoveredFixture(2); const input = f.input();
  const result = validateRetainedNativeEvidence(input);
  const binding = result.state.rounds[0]!.reportBinding!;
  expect(result.filesystemRequirements).toContainEqual({ kind: 'report', sha256: binding.reportSha256,
    storedPath: binding.sourcePath, nativePathSuffix: `.evidence/${binding.reportSha256}.json` });
  expect(JSON.parse(input.sourceJson).rounds[0].reportBinding.sourcePath).toBe(binding.sourcePath);
});
