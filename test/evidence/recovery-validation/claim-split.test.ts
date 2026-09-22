import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ClaimDescriptor } from '../../../src/evidence/claim-recovery/validation/claims.js';
import { correctionAnchor } from '../../../src/evidence/claim-recovery/validation/anchors.js';
import type { NativeCorrectionAnchor } from '../../../src/evidence/claim-recovery/validation/anchors.js';
import type { EventReceipt } from '../../../src/evidence/claim-recovery/validation/receipts.js';
import { prepareClaimSplit, type ClaimSplitInput } from '../../../src/evidence/claim-recovery/validation/claim-split.js';
import { sampleFinding, sampleResult, sampleRunHeader } from '../../telemetry/fixtures.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

// Static test assertions, not production report normalization or producer execution.
function fixtureDescriptor(finding: { file: string; title: string; description: string }): ClaimDescriptor {
  return { version: 1, operation: `${finding.file} :: ${finding.title}`,
    invariant: finding.description, evidence: [finding.title, finding.description] };
}
function retainedFixture(input: { sourceJson: string; target: string; operationId: string;
  anchors: NativeCorrectionAnchor[]; reports: string[]; sourceReceipts: EventReceipt[] }) {
  const source = JSON.parse(input.sourceJson);
  return { resultJson: JSON.stringify({ ...source, version: 3, sightings: source.sightings ?? [],
    recovery: { version: 1, operations: [{ operationId: input.operationId, sourceVersion: source.version,
      sourceSha256: sha(input.sourceJson), anchors: input.anchors, sourceReceipts: input.sourceReceipts }] } }) };
}
function input(): ClaimSplitInput {
  const run = sampleRunHeader({ converge: { target: 'pr-42', round: 2, attempt: 4 } });
  const report = sampleResult({ run });
  const rawKey = report.findings[0]!.identity!;
  const previousIdentity = '1111111111111111';
  return {
    scope: { base_url: 'https://harness.example', org_id: uuid(2), run_id: run.id, repo: 'allocator-one/rcl', pr_number: 42 },
    target: 'pr-42', eventId: uuid(3), occurredAt: '2026-09-22T12:00:00.123456Z',
    nativeJson: JSON.stringify({ version: 1, target: 'pr-42', roundCap: 15,
      rounds: [{ round: 2, runId: run.id, counts: { new: 1, repeat: 0, suppressed: 1, regating: 0 } }],
      findings: { [previousIdentity]: { key: previousIdentity, ...sampleFinding(), verdict: 'dismissed', verdictRound: 2,
        firstRound: 1, lastRound: 2, verdictReason: 'This applied to a different same-location claim.' } },
      updatedAt: '2026-09-22T11:00:00.000Z' }),
    reportJson: JSON.stringify(report), findingRef: 'f001', previousIdentity, identity: '2222222222222222',
    descriptor: fixtureDescriptor(report.findings[0]!), reason: 'Independent pagination ordering claim.',
    expectedEventSequence: 7, classificationId: uuid(4), sourceReceipts: [{
      id: uuid(4), org_id: uuid(2), run_id: run.id, repo: 'allocator-one/rcl', pr_number: 42,
      actor_user_id: uuid(5), kind: 'round_processed', converge_target: 'pr-42', round: 2, attempt: 4,
      occurred_at: '2026-09-22T11:00:00.123456Z', payload: { identities: [
        { identity_key: rawKey, matched_identity: previousIdentity, status: 'suppressed' },
      ] },
    }],
  };
}

describe('receipt-bound claim split preparation', () => {
  it('splits an original member without inheriting the conflated verdict or rewriting evidence', () => {
    const selection = input(); const before = structuredClone(selection);
    const prepared = prepareClaimSplit(selection);
    expect(prepared).toMatchObject({ event: { id: selection.eventId, kind: 'finding_claim_split',
      occurred_at: selection.occurredAt, run_id: selection.scope.run_id, round: 2, converge_target: selection.target,
      payload: { classification: 'new', matched_identity: selection.identity,
        native_evidence: { source: 'rcl_converge_state', state_version: 1, state_sha256: sha(selection.nativeJson) },
        report_json_sha256: sha(selection.reportJson), source_event_ids: [selection.classificationId] } },
      source: { findingRef: 'f001', reportKey: 'abc123def4567890', gating: 'consensus', belowThreshold: false } });
    expect(JSON.stringify(prepared)).not.toContain('verdict');
    expect(selection).toEqual(before);
    expect(prepareClaimSplit(selection)).toEqual(prepared);
  });

  it('uses kept/appendix position rather than a model finding ID and never gates appendix-only evidence', () => {
    const selection = input(); const report = JSON.parse(selection.reportJson);
    report.belowThresholdFindings[0].id = 'f001';
    report.belowThresholdFindings[0].gating = { reason: 'critical' };
    selection.reportJson = JSON.stringify(report); selection.findingRef = 'f002';
    selection.sourceReceipts[0]!.payload.identities = [{ identity_key: report.belowThresholdFindings[0].identity,
      matched_identity: selection.previousIdentity, status: 'suppressed' }];
    expect(prepareClaimSplit(selection)).toMatchObject({ source: { findingRef: 'f002',
      reportKey: 'fedcba9876543210', belowThreshold: true, gating: 'none' } });
  });

  it.each(['org', 'run', 'target', 'round', 'mapping', 'ambiguous', 'missing', 'duplicate', 'native-round', 'native-key', 'new-key-used', 'descriptor-scrub', 'reason-scrub'])
  ('refuses %s source conflicts before producing a replayable event', change => {
    const selection = input(); const receipt = selection.sourceReceipts[0]!;
    if (change === 'org') receipt.org_id = uuid(9);
    if (change === 'run') receipt.run_id = uuid(9);
    if (change === 'target') receipt.converge_target = 'other';
    if (change === 'round') receipt.round = 1;
    if (change === 'mapping') receipt.payload.identities = [];
    if (change === 'ambiguous') (receipt.payload.identities as unknown[]).push({ identity_key: 'abc123def4567890', matched_identity: '9999999999999999' });
    if (change === 'missing') selection.sourceReceipts = [];
    if (change === 'duplicate') selection.sourceReceipts.push(structuredClone(receipt));
    if (change === 'native-round') { const n = JSON.parse(selection.nativeJson); n.rounds[0].runId = uuid(9); selection.nativeJson = JSON.stringify(n); }
    if (change === 'native-key') { const n = JSON.parse(selection.nativeJson); n.findings = {}; selection.nativeJson = JSON.stringify(n); }
    if (change === 'new-key-used') { const n = JSON.parse(selection.nativeJson); n.findings[selection.identity] = { key: selection.identity }; selection.nativeJson = JSON.stringify(n); }
    if (change === 'descriptor-scrub') selection.descriptor.operation = 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstu';
    if (change === 'reason-scrub') selection.reason = 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstu';
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
  });

  it('requires the exact earlier correction receipt when the prior mapping was corrected', () => {
    const selection = input();
    const correction = { ...structuredClone(selection.sourceReceipts[0]!), id: uuid(6), kind: 'finding_identity_corrected', payload: {
      report_json_sha256: sha(selection.reportJson), finding_ref: selection.findingRef,
      identity_key: 'abc123def4567890', matched_identity: selection.previousIdentity,
    } };
    (selection.sourceReceipts[0]!.payload.identities as Record<string, unknown>[])[0]!.matched_identity = '9999999999999999';
    selection.sourceReceipts.push(correction);
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
    selection.correctionId = correction.id;
    expect(prepareClaimSplit(selection)).toMatchObject({ event: { payload: { source_event_ids: [selection.classificationId, correction.id] } } });
    correction.payload.report_json_sha256 = '0'.repeat(64);
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
  });

  it('refuses altered v2 original membership and never manufactures a producer descriptor', () => {
    const selection = input(); const native = JSON.parse(selection.nativeJson);
    native.version = 2; native.sightings = [{ runId: selection.scope.run_id, target: selection.target, round: 2,
      reportSha256: sha(selection.reportJson), findingRef: 'f001', reportKey: 'abc123def4567890', canonicalIdentity: selection.previousIdentity }];
    selection.nativeJson = JSON.stringify(native);
    expect(prepareClaimSplit(selection)).toMatchObject({ event: { payload: { native_evidence: { state_version: 2 } } } });
    native.sightings[0].reportSha256 = '0'.repeat(64); selection.nativeJson = JSON.stringify(native);
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
  });

  it('preserves unknown legacy gating instead of asserting a modern consensus decision', () => {
    const selection = input(); const report = JSON.parse(selection.reportJson);
    delete report.findings[0].gating; selection.reportJson = JSON.stringify(report);
    expect(prepareClaimSplit(selection)).toMatchObject({ source: { gating: 'legacy-blocking' } });
  });

  it.each(['nul-reason', 'unbound-ref', 'future-native', 'duplicate-round', 'marked-digest'])
  ('refuses %s evidence instead of silently manufacturing a usable source', change => {
    const selection = input();
    if (change === 'nul-reason') selection.reason = 'A reason\0with forbidden data';
    if (change === 'unbound-ref') selection.findingRef = 'f0001';
    if (change === 'future-native') { const n = JSON.parse(selection.nativeJson); n.version = 3; selection.nativeJson = JSON.stringify(n); }
    if (change === 'duplicate-round') { const n = JSON.parse(selection.nativeJson); n.rounds.push(structuredClone(n.rounds[0])); selection.nativeJson = JSON.stringify(n); }
    if (change === 'marked-digest') Object.assign((selection.sourceReceipts[0]!.payload.identities as object[])[0]!, {
      version: 1, finding_ref: 'f001', report_json_sha256: '0'.repeat(64),
    });
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
  });

  it('honors a retained native report binding even when the source state is legacy v1', () => {
    const selection = input(); const native = JSON.parse(selection.nativeJson);
    native.rounds[0].reportBinding = { runId: selection.scope.run_id, target: selection.target, round: 2,
      reportSha256: sha(selection.reportJson), sourcePath: '/synthetic/original-report.json' };
    selection.nativeJson = JSON.stringify(native);
    expect(prepareClaimSplit(selection).source.reportSha256).toBe(sha(selection.reportJson));
    native.rounds[0].reportBinding.reportSha256 = '0'.repeat(64);
    selection.nativeJson = JSON.stringify(native);
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
  });

  it.each(['digest', 'version', 'unmarked-members', 'unknown-status'])
  ('refuses a %s conflict in the classification snapshot protocol', change => {
    const selection = input(); const classification = selection.sourceReceipts[0]!;
    if (change === 'unknown-status') (classification.payload.identities as Record<string, unknown>[])[0]!.status = 'approved';
    else Object.assign(classification.payload, {
      classification_version: change === 'version' ? 99 : 1,
      report_json_sha256: change === 'digest' ? '0'.repeat(64) : sha(selection.reportJson),
    });
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
  });

  it('accepts an exact complete marked snapshot and rejects a changed top-level digest independently of its rows', () => {
    const selection = input(); const report = JSON.parse(selection.reportJson);
    const findings = [...report.findings, ...report.belowThresholdFindings];
    for (const finding of findings) finding.claimDescriptor = fixtureDescriptor(finding);
    selection.reportJson = JSON.stringify(report);
    const payload = selection.sourceReceipts[0]!.payload;
    payload.classification_version = 1; payload.report_json_sha256 = sha(selection.reportJson);
    payload.identities = findings.map((finding, i) => ({
      version: 1, finding_ref: `f${String(i + 1).padStart(3, '0')}`, report_json_sha256: sha(selection.reportJson),
      identity_key: finding.identity, matched_identity: selection.previousIdentity, status: 'suppressed',
      claim_descriptor: finding.claimDescriptor, match_rationale: 'exact_descriptor', pending_round: null,
    }));
    expect(prepareClaimSplit(selection).source.reportSha256).toBe(sha(selection.reportJson));
    payload.report_json_sha256 = '0'.repeat(64);
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
    payload.report_json_sha256 = sha(selection.reportJson); payload.classification_version = 99;
    expect(() => prepareClaimSplit(selection)).toThrow(/claim_split/);
  });
});

describe('claim splits after an earlier native recovery', () => {
  function recovered() {
    const selection = input(); const native = JSON.parse(selection.nativeJson);
    native.findings[selection.previousIdentity].firstRound = 2;
    native.findings[selection.previousIdentity].models = ['reviewer'];
    selection.nativeJson = JSON.stringify(native);
    (selection.sourceReceipts[0]!.payload.identities as unknown[]).push({ identity_key: 'fedcba9876543210',
      matched_identity: selection.previousIdentity, status: 'suppressed' });
    const event = prepareClaimSplit(selection).event;
    const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7),
      converge_target: selection.target, round: 2, attempt: null };
    const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(8));
    const plan = retainedFixture({ sourceJson: selection.nativeJson, target: selection.target,
      operationId: uuid(8), anchors: [anchor], reports: [selection.reportJson], sourceReceipts: selection.sourceReceipts });
    const next = { ...selection, nativeJson: plan.resultJson, nativeSourceJsons: [selection.nativeJson],
      eventId: uuid(10), identity: '3333333333333333', findingRef: 'f002',
      descriptor: fixtureDescriptor(JSON.parse(selection.reportJson).belowThresholdFindings[0]) };
    return { next, original: selection.nativeJson, reserved: anchor.identity };
  }

  it('binds a second correction to current v3 bytes and the exact retained legacy origin', () => {
    const { next } = recovered(); const before = structuredClone(next);
    expect(prepareClaimSplit(next)).toMatchObject({ event: { payload: {
      matched_identity: next.identity, native_evidence: { state_version: 3, state_sha256: sha(next.nativeJson) },
    } }, source: { previousIdentity: next.previousIdentity, findingRef: next.findingRef } });
    expect(next).toEqual(before);
  });

  it.each(['missing', 'altered', 'duplicate', 'unused', 'round-history', 'reserved-identity'])
  ('refuses %s lineage evidence before preparing a second correction', change => {
    const { next, reserved } = recovered();
    if (change === 'missing') next.nativeSourceJsons = [];
    if (change === 'altered') next.nativeSourceJsons[0] += ' ';
    if (change === 'duplicate') next.nativeSourceJsons.push(next.nativeSourceJsons[0]!);
    if (change === 'unused') next.nativeSourceJsons.push(next.nativeSourceJsons[0]! + ' ');
    if (change === 'round-history') {
      const native = JSON.parse(next.nativeJson); native.rounds[0].counts.new++;
      next.nativeJson = JSON.stringify(native);
    }
    if (change === 'reserved-identity') next.identity = reserved;
    expect(() => prepareClaimSplit(next)).toThrow(/claim_split/);
  });

  it('refuses an already-corrected occurrence selected with its original stale mapping', () => {
    const { next } = recovered(); next.findingRef = 'f001';
    expect(() => prepareClaimSplit(next)).toThrow(/claim_split/);
  });

  it('refuses a conflicting current sighting even when exact legacy membership exists', () => {
    const { next } = recovered(); const native = JSON.parse(next.nativeJson);
    native.sightings = [{ runId: next.scope.run_id, findingRef: next.findingRef, target: next.target, round: 2,
      reportSha256: '0'.repeat(64), reportKey: 'abc123def4567890', canonicalIdentity: next.previousIdentity }];
    next.nativeJson = JSON.stringify(native);
    expect(() => prepareClaimSplit(next)).toThrow(/claim_split/);
  });
});

describe('native correction anchors', () => {
  function accepted(selection: ClaimSplitInput) {
    const event = prepareClaimSplit(selection).event;
    return { ...selection.scope, ...event, run_id: selection.scope.run_id, actor_user_id: uuid(7),
      converge_target: selection.target, round: 2, attempt: null, payload: event.payload };
  }

  it('retains an exact accepted receipt and separate recovery attribution, without invented producer history', () => {
    const selection = input(); const receipt = accepted(selection);
    const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(8));
    expect(anchor).toMatchObject({ version: 1, operationId: uuid(8), identity: selection.identity,
      descriptor: selection.descriptor, source: { runId: selection.scope.run_id, findingRef: 'f001' },
      nativeSource: { version: 1, sha256: sha(selection.nativeJson) }, receipt });
    for (const field of ['firstRound', 'lastRound', 'verdict', 'verdictRound', 'pendingRound', 'sightings']) {
      expect(Object.hasOwn(anchor as object, field)).toBe(false);
    }
    selection.descriptor.evidence.push('later mutation');
    expect((anchor as { descriptor: { evidence: string[] } }).descriptor.evidence).not.toContain('later mutation');
  });

  it.each(['actor', 'microsecond', 'event-id', 'claim', 'native-digest', 'unknown-operation'])
  ('refuses %s acknowledgement differences before creating a native anchor', change => {
    const selection = input(); const receipt = accepted(selection);
    let operation = uuid(8);
    if (change === 'actor') receipt.actor_user_id = uuid(9);
    if (change === 'microsecond') receipt.occurred_at = '2026-09-22T12:00:00.123457Z';
    if (change === 'event-id') receipt.id = uuid(9);
    if (change === 'claim') receipt.payload.matched_identity = '9999999999999999';
    if (change === 'native-digest') (receipt.payload.native_evidence as Record<string, unknown>).state_sha256 = '0'.repeat(64);
    if (change === 'unknown-operation') operation = '';
    expect(() => correctionAnchor(selection, receipt, uuid(7), operation)).toThrow(/correction_anchor/);
  });

  it('retains the destination so identical receipt values cannot silently resume against another host', () => {
    const selection = input(); const receipt = accepted(selection);
    const anchor = correctionAnchor(selection, receipt, uuid(7), uuid(8));
    const other = { ...selection, scope: { ...selection.scope, base_url: 'https://other.example' } };
    const switched = correctionAnchor(other, receipt, uuid(7), uuid(8));
    expect(anchor).toMatchObject({ destination: selection.scope });
    expect(switched).not.toEqual(anchor);
  });
});
