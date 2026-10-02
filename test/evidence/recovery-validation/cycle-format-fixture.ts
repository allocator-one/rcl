import { retainedCycleFixture } from '../../fixtures/retained-cycle-content.js';
import { correctionAnchor } from '../../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimSplit, type ClaimSplitInput } from '../../../src/evidence/claim-recovery/validation/claim-split.js';
import { sha, uuid } from './fixtures.js';

export const { bundle: retained } = await retainedCycleFixture();

export function recoveredCycle() {
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
  // Synthetic stored chronology for the pure unavailable-history residual control.
  // This never represents an authenticated server read or native write authority.
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), attempt: null,
    sequence: 2, received_at: '2026-09-26T12:01:00.000Z' };
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

