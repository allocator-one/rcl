import { describe, expect, it } from 'vitest';
import { prepareClaimDisposition, prepareObligationTransfer } from '../../../src/evidence/claim-recovery/validation/occurrence.js';
import { prepareClaimSplit } from '../../../src/evidence/claim-recovery/validation/claim-split.js';
import type { StoredEventReceipt } from '../../../src/evidence/claim-recovery/validation/receipts.js';
import { fixture, laterSource, preserved, rebind } from './occurrence-fixtures.js';
import { sha, uuid } from './fixtures.js';

describe('pure occurrence preparation', () => {
  it('prepares one transfer with exact original wire fields and no invented receipt or attempt', () => {
    const { transfer: input } = fixture(); const before = structuredClone(input);
    const prepared = prepareObligationTransfer(input);
    expect(prepared.event).toEqual({ id: input.eventId, kind: 'finding_obligation_transferred', run_id: input.sourceContext.scope.run_id,
      converge_target: input.sourceContext.target, round: 1, occurred_at: input.occurredAt, payload: {
        version: 1, org_id: input.sourceContext.scope.org_id, repo: input.sourceContext.scope.repo, pr_number: 7,
        head_sha: input.sourceContext.headSha, report_json_sha256: sha(input.split.selection.reportJson), expected_event_sequence: 3,
        carrier: { kind: 'classified_group', classification_event_id: input.carrier.classification.id, identity_key: input.carrierIdentity },
        source: { run_id: input.sourceContext.scope.run_id, round: 1, head_sha: input.sourceContext.headSha,
          report_json_sha256: sha(input.split.selection.reportJson), classification_event_id: input.split.selection.classificationId,
          correction_event_id: null, finding_ref: 'f001', identity_key: 'report:00000000-0000-7000-8000-000000000001:original',
          previous_identity: input.carrierIdentity },
        split_event_id: input.split.receipt.id, claim_identity: input.split.selection.identity, expected_source_event_sequence: 3,
        native_evidence: { source: 'rcl_converge_state', state_version: 1, state_sha256: sha(input.split.selection.nativeJson) }, reason: input.reason,
      } });
    expect(prepared.coverage).toBe('one-occurrence'); expect(prepared.qualification).toBe('content-only');
    expect(prepared.assertionReceipt).toEqual({ kind: 'pending-server-receipt' });
    expect(input).toEqual(before); expect(prepareObligationTransfer(input)).toEqual(prepared);
  });

  it.each(['report', 'stored-descriptor', 'stored-ref', 'stored-head', 'stored-run', 'artifact-bytes', 'artifact-digest',
    'appendix-omitted', 'ambiguous', 'target', 'actor', 'context-head', 'context-sequence',
    'classification-sequence', 'split-sequence', 'split-time', 'split-actor', 'split-payload', 'native', 'new-id-collision'])
  ('refuses %s drift before preparing a transfer', change => {
    const { transfer: input } = fixture();
    const source = input.split.source; const rows = source.classification.payload.identities as Record<string, unknown>[];
    const stored = source.storedRun as any;
    if (change === 'report') source.reportJson += ' ';
    if (change === 'stored-descriptor') stored.findings[0].claim_descriptor.invariant += ' changed';
    if (change === 'stored-ref') stored.findings[0].ref = 'f004';
    if (change === 'stored-head') stored.target.head_sha = 'b'.repeat(40);
    if (change === 'stored-run') stored.id = uuid(99);
    if (change === 'artifact-bytes') stored.artifacts[0].declared_bytes++;
    if (change === 'artifact-digest') stored.artifacts[0].declared_sha256 = 'b'.repeat(64);
    if (change === 'appendix-omitted') stored.findings.pop();
    if (change === 'ambiguous') rows.push({ ...rows[0], matched_identity: 'ffffffffffffffff' });
    if (change === 'target') source.classification.converge_target = 'another-target';
    if (change === 'actor') input.sourceContext.actorUserId = uuid(99);
    if (change === 'context-head') input.sourceContext.headSha = 'b'.repeat(40);
    if (change === 'context-sequence') input.sourceContext.eventSequence = 2;
    if (change === 'classification-sequence') source.classification.sequence = 0;
    if (change === 'split-sequence') input.split.receipt.sequence = 1;
    if (change === 'split-time') input.split.receipt.received_at = '2026-09-22T11:00:00.123455Z';
    if (change === 'split-actor') input.split.receipt.actor_user_id = uuid(99);
    if (change === 'split-payload') input.split.receipt.payload.finding_ref = 'f002';
    if (change === 'native') input.split.native.sourceJson += ' ';
    if (change === 'new-id-collision') input.eventId = input.split.receipt.id;
    expect(() => prepareObligationTransfer(input)).toThrow(/occurrence/);
  });

  it('keeps fresh assertion time pending and historical split actor separate from the operator', () => {
    const { disposition: input } = fixture();
    const result = prepareClaimDisposition(input);
    expect(result.assertionReceipt).toEqual({ kind: 'pending-server-receipt' });
    expect(result.assertingActorUserId).toBe(uuid(8)); expect(result.splitAttribution.actorUserId).toBe(uuid(7));
    expect(result.event.payload).toMatchObject({ mode: 'fresh', verdict: 'fixed', previous_disposition_event_id: null });
    expect(result.event.payload).not.toHaveProperty('original_verdict');
    expect(result.event).not.toHaveProperty('received_at');
  });

  it('preserves a fully bound co-key subject and exact original attribution/receipt microseconds', () => {
    const { disposition: input } = preserved(); const before = structuredClone(input);
    const result = prepareClaimDisposition(input);
    expect(result.originalVerdictAttribution).toEqual({ eventId: uuid(10), actorUserId: uuid(9),
      occurredAt: '2026-09-22T11:10:00.123456Z', receivedAt: '2026-09-22T11:10:00.123457Z', sequence: 2 });
    expect(result.assertionReceipt).toEqual({ kind: 'preserved', receipt: result.originalVerdictAttribution });
    expect(result.assertingActorUserId).toBe(uuid(8)); expect(input).toEqual(before);
    expect(prepareClaimDisposition(input)).toEqual(result);
  });

  it.each(['descriptorless', 'mixed-appendix', 'classification-descriptor', 'stored-descriptor', 'split-descriptor', 'actorless',
    'wrong-target', 'wrong-run', 'late-verdict', 'verdict-before-classification', 'wrong-key', 'duplicate-verdict', 'reason', 'severity',
    'missing-sequence', 'bad-time'])('refuses preserved %s proof', change => {
    const { disposition: input } = preserved(); const source = input.split.source;
    const rows = source.classification.payload.identities as any[];
    const verdict = input.originalVerdict!;
    if (change === 'descriptorless') { const r = JSON.parse(source.reportJson); delete r.findings[0].claimDescriptor; source.reportJson = JSON.stringify(r); }
    if (change === 'mixed-appendix') { const r = JSON.parse(source.reportJson); r.belowThresholdFindings[0].claimDescriptor.invariant += ' different'; source.reportJson = JSON.stringify(r); }
    if (change === 'classification-descriptor') rows[1].claim_descriptor = { ...rows[1].claim_descriptor, invariant: 'A different original assertion.' };
    if (change === 'stored-descriptor') (source.storedRun.findings as any[])[2].claim_descriptor = null;
    if (change === 'split-descriptor') input.split.selection.descriptor.invariant += ' changed';
    if (change === 'actorless') verdict.actor_user_id = null;
    if (change === 'wrong-target') verdict.converge_target = 'other';
    if (change === 'wrong-run') verdict.run_id = uuid(99);
    if (change === 'late-verdict') verdict.sequence = 4;
    if (change === 'verdict-before-classification') verdict.received_at = '2026-09-22T11:00:00.123455Z';
    if (change === 'wrong-key') (verdict.payload.verdicts as any[])[0].identity_key = 'ffffffffffffffff';
    if (change === 'duplicate-verdict') (verdict.payload.verdicts as any[]).push(structuredClone((verdict.payload.verdicts as any[])[0]));
    if (change === 'reason') input.reason += ' rewritten';
    if (change === 'severity') input.severity = 'minor';
    if (change === 'missing-sequence') delete (verdict as any).sequence;
    if (change === 'bad-time') verdict.received_at = '2026-02-30T00:00:00Z';
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it('keeps appendix refs separate even when raw keys and embedded model IDs collide', () => {
    const { transfer: input, report } = fixture();
    report.belowThresholdFindings[0].identity = report.findings[0].identity;
    input.split.selection.findingRef = 'f003'; rebind(input, report);
    const out = prepareObligationTransfer(input);
    expect(out.event.payload.source).toMatchObject({ finding_ref: 'f003', identity_key: report.findings[0].identity });
    expect(out.coverage).toBe('one-occurrence');
  });

  it('transfers one earlier occurrence into an actual empty legacy carrier without asserting prefix closure', () => {
    const { transfer: input } = fixture(); const carrier = laterSource(input, 3);
    const report = JSON.parse(carrier.reportJson); report.findings = []; carrier.reportJson = JSON.stringify(report);
    carrier.storedRun.findings = [];
    carrier.storedRun.artifacts = [{ kind: 'report_json', stored: true, declared_sha256: sha(carrier.reportJson),
      declared_bytes: Buffer.byteLength(carrier.reportJson) }];
    carrier.classification.payload = { classification_version: 1, report_json_sha256: sha(carrier.reportJson),
      identities: [], legacy_pending_identities: [input.carrierIdentity] };
    input.carrier = carrier; input.carrierKind = 'legacy_pending';
    input.carrierContext = { ...input.sourceContext, scope: carrier.scope, round: 3,
      reportSha256: sha(carrier.reportJson), eventSequence: 1 };
    const out = prepareObligationTransfer(input);
    expect(out.event).toMatchObject({ run_id: carrier.scope.run_id, round: 3, payload: {
      source: { run_id: input.sourceContext.scope.run_id, round: 1 }, expected_event_sequence: 1, expected_source_event_sequence: 3 } });
    expect(out.coverage).toBe('one-occurrence'); expect(JSON.stringify(out)).not.toMatch(/complete|retired|approved/);
    input.carrierKind = 'classified_group'; expect(() => prepareObligationTransfer(input)).toThrow(/occurrence/);
    input.carrierKind = 'legacy_pending'; carrier.classification.payload.legacy_pending_identities = ['ffffffffffffffff'];
    expect(() => prepareObligationTransfer(input)).toThrow(/occurrence/);
  });

  it.each(['descriptorless', 'mixed-kept', 'mixed-appendix'])('rejects preserved %s with fully rebound original sources', change => {
    const { disposition: input, originalVerdict, report } = fixture();
    input.mode = 'preserved'; input.originalVerdict = originalVerdict; input.originalVerdictActorUserId = uuid(9);
    if (change === 'descriptorless') for (const f of [...report.findings, ...report.belowThresholdFindings]) delete f.claimDescriptor;
    if (change === 'mixed-kept') report.findings[1].claimDescriptor.invariant += ' a different claim';
    if (change === 'mixed-appendix') report.belowThresholdFindings[0].claimDescriptor.invariant += ' a different claim';
    rebind(input, report);
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
    input.mode = 'fresh'; delete input.originalVerdict; delete input.originalVerdictActorUserId;
    expect(prepareClaimDisposition(input).event.payload.mode).toBe('fresh');
  });

  it('refuses a changed original actor instead of reattributing the decision', () => {
    const { disposition: input } = preserved(); input.originalVerdict!.actor_user_id = uuid(99);
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it('requires critical triage for a legacy critical occurrence with no recorded round severities', () => {
    const { disposition: input, report } = fixture(); report.findings[0].severity = 'critical';
    const native = JSON.parse(input.split.selection.nativeJson);
    delete native.rounds[0].severities; native.findings[input.split.selection.previousIdentity].severity = 'critical';
    input.split.selection.nativeJson = JSON.stringify(native); input.split.native.sourceJson = input.split.selection.nativeJson;
    rebind(input, report);
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
    input.severity = 'critical'; expect(prepareClaimDisposition(input).event.payload.severity).toBe('critical');
  });

  it('a later nongating batch cannot lower critical severity; a real later gated batch can change it', () => {
    const { disposition: input, report } = fixture(); report.findings[0].severity = 'critical'; rebind(input, report);
    input.laterSources = [laterSource(input, 2, false)];
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
    input.laterSources = [laterSource(input, 2, true)];
    expect(prepareClaimDisposition(input).event.payload.severity).toBe('important');
    input.laterSources.push(laterSource(input, 3, true, 'critical'));
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it.each(['target', 'descriptor', 'same-round', 'duplicate-round', 'unmarked', 'earlier-receipt'])('refuses unproven later %s severity', change => {
    const { disposition: input, report } = fixture(); report.findings[0].severity = 'critical'; rebind(input, report);
    const later = laterSource(input); input.laterSources = [later];
    if (change === 'target') later.classification.converge_target = 'other';
    if (change === 'descriptor') (later.classification.payload.identities as any[])[0].claim_descriptor.invariant += ' changed';
    if (change === 'same-round') later.classification.round = 1;
    if (change === 'duplicate-round') input.laterSources.push(structuredClone(later));
    if (change === 'unmarked') delete later.classification.payload.classification_version;
    if (change === 'earlier-receipt') later.classification.received_at = '2026-09-22T12:00:00.123455Z';
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it('binds an exact predecessor without claiming this local view proves it is the server latest', () => {
    const { disposition: input } = fixture(); const first = prepareClaimDisposition(input);
    const receipt = { ...input.split.receipt, ...first.event, actor_user_id: uuid(8), sequence: 4,
      received_at: '2026-09-22T13:00:00.123458Z' };
    input.previousDispositionEventId = receipt.id; input.previousDisposition = receipt;
    input.eventId = uuid(21); input.sourceContext.eventSequence = 4; input.verdict = 'dismissed';
    expect(prepareClaimDisposition(input).event.payload.previous_disposition_event_id).toBe(receipt.id);
    receipt.payload.finding_ref = 'f002'; expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it.each(['org', 'destination', 'repo', 'pr', 'ref', 'unsafe-sequence', 'invalid-time', 'reason-scrub'])('refuses %s selection changes', change => {
    const { disposition: input } = fixture();
    if (change === 'org') input.sourceContext = { ...input.sourceContext, scope: { ...input.sourceContext.scope, org_id: uuid(99) } };
    if (change === 'destination') input.sourceContext = { ...input.sourceContext, scope: { ...input.sourceContext.scope, base_url: 'https://other.example' } };
    if (change === 'repo') input.sourceContext = { ...input.sourceContext, scope: { ...input.sourceContext.scope, repo: 'other/repo' } };
    if (change === 'pr') input.sourceContext = { ...input.sourceContext, scope: { ...input.sourceContext.scope, pr_number: 8 } };
    if (change === 'ref') input.split.selection.findingRef = 'f002';
    if (change === 'unsafe-sequence') input.sourceContext.eventSequence = Number.MAX_SAFE_INTEGER + 1;
    if (change === 'invalid-time') input.occurredAt = '2026-02-30T00:00:00Z';
    if (change === 'reason-scrub') input.reason = 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstu';
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it('supports an exact prior per-ref correction and refuses an omitted or altered correction', () => {
    const { transfer: input } = fixture(); const selection = input.split.selection;
    (input.split.source.classification.payload.identities as any[])[0].matched_identity = 'eeeeeeeeeeeeeeee';
    const correction: StoredEventReceipt = { ...input.split.source.classification, id: uuid(11), sequence: 2,
      kind: 'finding_identity_corrected', received_at: '2026-09-22T11:30:00.123456Z', payload: {
        org_id: selection.scope.org_id, repo: selection.scope.repo, pr_number: selection.scope.pr_number,
        head_sha: input.sourceContext.headSha, report_json_sha256: sha(selection.reportJson), finding_ref: 'f001',
        identity_key: (input.split.source.storedRun.findings as any[])[0].identity_key, matched_identity: selection.previousIdentity } };
    selection.correctionId = correction.id; selection.sourceReceipts.push(correction); input.split.source.corrections.push(correction);
    input.split.receipt = { ...input.split.receipt, ...prepareClaimSplit(selection).event } as StoredEventReceipt;
    expect(prepareObligationTransfer(input).event.payload.source).toMatchObject({ correction_event_id: correction.id });
    correction.payload.head_sha = 'b'.repeat(40); expect(() => prepareObligationTransfer(input)).toThrow(/occurrence/);
    correction.payload.head_sha = input.sourceContext.headSha; input.split.source.corrections = [];
    expect(() => prepareObligationTransfer(input)).toThrow(/occurrence/);
  });

  it('can preserve exact unmarked descriptors without adding modern source markers', () => {
    const { disposition: input, originalVerdict } = fixture();
    input.mode = 'preserved'; input.originalVerdict = originalVerdict; input.originalVerdictActorUserId = uuid(9);
    const out = prepareClaimDisposition(input);
    expect(out.event.payload.original_verdict).toEqual({ run_id: input.sourceContext.scope.run_id, event_id: originalVerdict.id,
      identity_key: input.split.selection.previousIdentity, classification_event_id: input.split.selection.classificationId,
      report_json_sha256: input.sourceContext.reportSha256, finding_ref: 'f001' });
    expect(Object.keys(out.event).sort()).toEqual(['id', 'kind', 'run_id', 'converge_target', 'round', 'occurred_at', 'payload'].sort());
    expect(Object.keys(out.event.payload).sort()).toEqual(['version', 'org_id', 'repo', 'pr_number', 'head_sha', 'report_json_sha256',
      'expected_event_sequence', 'finding_ref', 'identity_key', 'split_event_id', 'claim_identity', 'previous_disposition_event_id',
      'mode', 'verdict', 'severity', 'reason', 'original_verdict'].sort());
    expect(input.split.source.classification.payload).not.toHaveProperty('classification_version');
    delete (input.split.source.classification.payload.identities as any[])[2].claim_descriptor;
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it('does not treat an unrelated original verdict entry as evidence for the selected claim', () => {
    const { disposition: input } = preserved();
    (input.originalVerdict!.payload.verdicts as any[])[0].identity_key = input.split.selection.identity;
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it.each(['omitted-receipt', 'absent-id', 'other-split', 'actorless', 'future-sequence', 'before-split'])
  ('refuses predecessor %s', change => {
    const { disposition: input } = fixture(); const first = prepareClaimDisposition(input);
    const receipt: StoredEventReceipt = { ...input.split.receipt, ...first.event, actor_user_id: uuid(8), sequence: 4,
      received_at: '2026-09-22T13:00:00.123458Z' };
    input.previousDisposition = receipt; input.previousDispositionEventId = receipt.id;
    input.eventId = uuid(21); input.sourceContext.eventSequence = 4;
    if (change === 'omitted-receipt') delete input.previousDisposition;
    if (change === 'absent-id') input.previousDispositionEventId = null;
    if (change === 'other-split') receipt.payload.split_event_id = uuid(99);
    if (change === 'actorless') receipt.actor_user_id = null;
    if (change === 'future-sequence') receipt.sequence = 5;
    if (change === 'before-split') receipt.received_at = '2026-09-22T12:00:00.123455Z';
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it('accepts a frozen input and returns detached mutable wire data', () => {
    const { transfer: input } = fixture();
    function freeze(value: unknown) {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value); for (const child of Object.values(value)) freeze(child);
      }
    }
    const before = JSON.stringify(input); freeze(input);
    const a = prepareObligationTransfer(input); const b = prepareObligationTransfer(input);
    expect(a).toEqual(b); (a.event.payload.source as any).finding_ref = 'f999';
    expect(JSON.stringify(input)).toBe(before); expect(b.event.payload.source).toMatchObject({ finding_ref: 'f001' });
  });

  it('refuses duplicate JSON keys in original bytes rather than choosing one source', () => {
    const { transfer: input } = fixture();
    input.split.source.reportJson = input.split.source.reportJson.replace('"findings":', '"findings":[],"findings":');
    expect(() => prepareObligationTransfer(input)).toThrow(/occurrence/);
  });

  it('transfers a proven kept occurrence while retaining an unmapped legacy appendix as unresolved', () => {
    const { transfer: input } = fixture();
    (input.split.source.classification.payload.identities as any[]).pop();
    const before = structuredClone(input); const out = prepareObligationTransfer(input);
    expect(out.event.payload.source).toMatchObject({ finding_ref: 'f001' });
    expect(out.unresolvedMembers).toEqual([{ runId: input.sourceContext.scope.run_id, target: input.sourceContext.target,
      reportSha256: input.sourceContext.reportSha256, findingRef: 'f003', reportKey: 'raw-appendix', reason: 'classification-unavailable' }]);
    expect(input).toEqual(before); expect(out.coverage).toBe('one-occurrence');
  });

  it('allows fresh exact triage with an unknown legacy sibling but refuses preserved subject inheritance', () => {
    const { disposition: input, originalVerdict } = fixture();
    (input.split.source.classification.payload.identities as any[]).pop();
    expect(prepareClaimDisposition(input).unresolvedMembers).toHaveLength(1);
    input.mode = 'preserved'; input.originalVerdict = originalVerdict; input.originalVerdictActorUserId = uuid(9);
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
    input.mode = 'fresh'; delete input.originalVerdict; delete input.originalVerdictActorUserId;
    input.split.selection.findingRef = 'f003';
    expect(() => prepareClaimDisposition(input)).toThrow(/occurrence/);
  });

  it('retains ambiguous unselected legacy membership instead of guessing it is outside the selected family', () => {
    const { transfer: input } = fixture();
    const rows = input.split.source.classification.payload.identities as any[];
    rows.push({ ...rows[2], matched_identity: 'eeeeeeeeeeeeeeee' });
    expect(prepareObligationTransfer(input).unresolvedMembers).toEqual([{ runId: input.sourceContext.scope.run_id,
      target: input.sourceContext.target, reportSha256: input.sourceContext.reportSha256, findingRef: 'f003',
      reportKey: 'raw-appendix', reason: 'classification-ambiguous' }]);
  });

  it('still refuses an incomplete marked classification rather than treating it as a legacy unknown', () => {
    const { transfer: input } = fixture(true); (input.split.source.classification.payload.identities as any[]).pop();
    expect(() => prepareObligationTransfer(input)).toThrow(/occurrence/);
  });
});
