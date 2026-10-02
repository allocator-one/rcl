import { retainedCycleFixture } from '../../fixtures/retained-cycle-content.js';
import { expect, it } from 'vitest';
import { correctionAnchor } from '../../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimSplit, type ClaimSplitInput } from '../../../src/evidence/claim-recovery/validation/claim-split.js';
import { validateRetainedNativeEvidence, verifyNativeRecoveryLineage } from '../../../src/evidence/claim-recovery/validation/native-state.js';
import { recoveredFixture, sha, uuid } from './fixtures.js';

const { bundle: retained } = await retainedCycleFixture();

function recoveredCycle() {
  const original = JSON.parse(retained.sourceJson);
  const report = JSON.parse(retained.reportJson);
  const findings = [...report.findings, ...report.belowThresholdFindings];
  const previousIdentity = Object.keys(original.findings)[0]!;
  const selection: ClaimSplitInput = {
    scope: { base_url: 'https://harness.example', org_id: uuid(2), run_id: report.run.id, repo: 'allocator-one/rcl', pr_number: 42 },
    target: retained.target, eventId: uuid(403), occurredAt: '2026-09-26T12:00:00.123456Z',
    nativeJson: retained.sourceJson, reportJson: retained.reportJson, findingRef: 'f001', previousIdentity,
    identity: '2222222222222222', descriptor: { version: 1, operation: 'lib/foo.ex :: pagination',
      invariant: 'Ordering by inserted_at alone is unstable.', evidence: ['Add id as a tiebreak.'] },
    reason: 'Independent pagination ordering claim.', expectedEventSequence: 1, classificationId: uuid(404),
    sourceReceipts: [{ id: uuid(404), org_id: uuid(2), run_id: report.run.id, repo: 'allocator-one/rcl', pr_number: 42,
      actor_user_id: uuid(5), kind: 'round_processed', converge_target: retained.target, round: 1, attempt: 1,
      occurred_at: '2026-09-26T12:00:00.000Z', payload: { identities: findings.map((finding, index) => ({
        identity_key: finding.identity, matched_identity: original.lastAnnotations.identities[index].identity,
        status: original.lastAnnotations.identities[index].status,
      })) } }],
  };
  const event = prepareClaimSplit(selection).event;
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), attempt: null };
  const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(803));
  // Same retained-v3 fixture shape as the source-backed claim-split test. The
  // real recovery writer adds an empty sightings array to a cycle predecessor;
  // no producer sightings or successful content validation are invented here.
  const state = { ...original, version: 3, sightings: original.sightings ?? [], recovery: { version: 1, operations: [{
    operationId: uuid(803), sourceVersion: original.version, sourceSha256: sha(retained.sourceJson),
    anchors: [anchor], sourceReceipts: selection.sourceReceipts,
  }] } };
  return { state, original, selection, input: { sourceJson: JSON.stringify(state), target: retained.target,
    reports: [retained.reportJson], nativeSourceJsons: [retained.sourceJson] } };
}

it('keeps non-cycle recovered-v3 controls accepted for legacy and semantic predecessors', () => {
  for (const version of [1, 2] as const) {
    expect(validateRetainedNativeEvidence(recoveredFixture(version).input()).qualification).toBe('content-only');
  }
});

it('proves the recovered-v3 cycle lineage and retains the actual public writer accounting', () => {
  const f = recoveredCycle();
  expect(f.state.sightings).toEqual([]);
  expect(f.original).not.toHaveProperty('sightings');
  expect(verifyNativeRecoveryLineage(f.input.sourceJson, f.input.target, f.input.nativeSourceJsons).original).toEqual(f.original);
  expect(f.state.rounds).toEqual(f.original.rounds);
  expect(f.state.roundCap).toBe(15);
  expect(f.state.cycle.history).toEqual({ attempts: 3, rounds: 1 });
  expect(JSON.parse(retained.attemptsJson).attemptsUsed).toBe(1);
  const archive = JSON.parse(retained.archiveJson);
  expect(Buffer.from(archive.files.run.bytes, 'base64').toString()).toBe(retained.oldRun);
  expect(Buffer.from(archive.files.attempts.bytes, 'base64').toString()).toBe(retained.oldAttempts);
});

it('accepts recovered-v3 content descended from the genuine public cycle-v2 snapshot', () => {
  const f = recoveredCycle(); const before = structuredClone(f.input);
  const result = validateRetainedNativeEvidence(f.input);
  expect(result).toMatchObject({ qualification: 'content-only', state: f.state });
  expect(result.state.cycle).toEqual(f.original.cycle);
  expect(result.state.rounds).toEqual(f.original.rounds);
  expect(result.state.sightings).toEqual([]);
  expect(f.input).toEqual(before);
});

it('refuses recovered-v3 cycle tampering even when the original bytes remain supplied', () => {
  const f = recoveredCycle(); const altered = structuredClone(f.state);
  altered.cycle.history.attempts++;
  expect(() => validateRetainedNativeEvidence({ ...f.input, sourceJson: JSON.stringify(altered) })).toThrow();
});
