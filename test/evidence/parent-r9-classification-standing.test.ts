import { describe, expect, it } from 'vitest';
import { setup } from './parent-r9-projection-fixture.js';
import { fixture, laterSource } from './recovery-validation/occurrence-fixtures.js';
import { sha, uuid } from './recovery-validation/fixtures.js';
import { validateOccurrenceSource } from '../../src/evidence/claim-recovery/validation/occurrence-source.js';
import { projectOccurrenceCarrier } from '../../src/evidence/claim-recovery/validation/carrier-projection.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { prepareObligationTransfer } from '../../src/evidence/claim-recovery/validation/occurrence.js';
import type { OccurrenceSource } from '../../src/evidence/claim-recovery/validation/occurrence-types.js';
import type { StoredEventReceipt } from '../../src/evidence/claim-recovery/validation/receipts.js';

function correction(source: OccurrenceSource, identity: string): StoredEventReceipt {
  const report = JSON.parse(source.reportJson);
  return { ...source.classification, id: uuid(977), kind: 'finding_identity_corrected', actor_user_id: uuid(8),
    sequence: 2, received_at: '2026-09-22T14:00:01.123456Z', payload: {
      org_id: source.scope.org_id, repo: source.scope.repo, pr_number: source.scope.pr_number,
      head_sha: report.run.target.head_sha, report_json_sha256: sha(source.reportJson), finding_ref: 'f001',
      identity_key: report.findings[0].identity, matched_identity: identity } };
}
function correctedLater(kind: 'uniform' | 'mixed' | 'missing' | 'bound-first' | 'unbound-first') {
  const f = setup('dismissed');
  expect(f.run(1).claims[0]!.standing).toBe('dismissed');
  const source = laterSource(f.f.disposition, 2, true, 'important');
  delete source.classification.payload.classification_version;
  const bound = (source.classification.payload.identities as Record<string, unknown>[])[0]!;
  const first = { identity_key: bound.identity_key, matched_identity: bound.matched_identity,
    claim_descriptor: bound.claim_descriptor, status: 'new' };
  const second = { ...first, matched_identity: 'eeeeeeeeeeeeeeee', status: kind === 'uniform' ? 'new' : 'regating' };
  source.classification.payload.identities = kind === 'missing' ? [] : kind === 'bound-first' ?
    [{ ...bound, status: 'new' }, second] : kind === 'unbound-first' ? [second, { ...bound, status: 'new' }] : [first, second];
  source.corrections = [correction(source, f.anchor.identity)];
  f.add(source);
  return { ...f, source };
}

describe('classification standing survives exact identity correction through real consumers', () => {
  it('uniform new/new classification reopens a previously dismissed claim in current v1 projection', () => {
    const f = correctedLater('uniform');
    const projected = f.run(1);
    expect(projected.claims[0]).toMatchObject({ standing: 'pending', reasons: ['adverse_later_sighting'] });
    expect(projected.actionableIdentities).toContain(f.anchor.identity);
    expect(projected.residuals).toEqual([]);
    const member = validateOccurrenceSource(f.source).members[0]!;
    expect(member).toMatchObject({ identity: f.anchor.identity, classificationStanding: { kind: 'known', status: 'new' } });
    expect(member.mapping).toBeUndefined();
    expect(member.unresolvedReason).toBeUndefined();
  });

  it.each(['mixed', 'missing', 'bound-first', 'unbound-first'] as const)
  ('%s classification remains unresolved after correction in both current projection versions', kind => {
    const f = correctedLater(kind);
    for (const version of [1, 2] as const) {
      const projected = f.run(version);
      expect(projected.claims[0]).toMatchObject({ standing: 'pending', reasons: ['current_source_inventory_unresolved'] });
      expect(projected.actionableIdentities).toContain(f.anchor.identity);
      expect(projected.residuals).toContainEqual({ reason: 'source_classification_unknown', runId: f.source.scope.run_id, round: 2 });
    }
    const member = validateOccurrenceSource(f.source).members[0]!;
    expect(member).toMatchObject({ identity: f.anchor.identity, classificationStanding: { kind: 'unknown' } });
    expect(member.mapping).toBeUndefined();
  });

  it.each(['uniform', 'mixed', 'missing'] as const)('%s corrected carrier retains independent classification coverage', kind => {
    const f = correctedLater(kind);
    const row = f.history.sources.at(-1)!;
    const result = projectOccurrenceCarrier({ carrier: { ...row.selector, kind: 'classified_group',
      classificationId: f.source.classification.id, identity: f.anchor.identity }, inventoryStatus: 'complete',
      sources: [row], transfers: [], nativePredecessors: [] });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.identity).toBe(f.anchor.identity);
    const residual = result.residuals.find(r => r.reason === 'classification-ambiguous');
    if (kind === 'uniform') expect(residual).toBeUndefined();
    else expect(residual).toMatchObject({ occurrence: { findingRef: 'f001', correctionId: f.source.corrections[0]!.id } });
  });

  it('identity-only correction can prepare the exact transfer while explicitly retaining unknown classification', () => {
    const { transfer: input } = fixture();
    const source = input.split.source, selection = input.split.selection;
    const rows = source.classification.payload.identities as Record<string, unknown>[];
    source.classification.payload.identities = [rows[0], { ...rows[0], matched_identity: 'eeeeeeeeeeeeeeee', status: 'regating' }, ...rows.slice(1)];
    const proof = correction(source, selection.previousIdentity);
    proof.received_at = '2026-09-22T11:30:00.123456Z';
    selection.correctionId = proof.id;
    selection.sourceReceipts.push(proof);
    source.corrections.push(proof);
    input.split.receipt = { ...input.split.receipt, ...prepareClaimSplit(selection).event } as StoredEventReceipt;
    const prepared = prepareObligationTransfer(input);
    expect(prepared.event.payload.source).toMatchObject({ correction_event_id: proof.id, finding_ref: 'f001' });
    expect(prepared.unresolvedMembers).toContainEqual(expect.objectContaining({ findingRef: 'f001', reason: 'classification-ambiguous' }));
    expect(validateOccurrenceSource(source).members[0]).toMatchObject({ identity: selection.previousIdentity, classificationStanding: { kind: 'unknown' } });
    source.corrections = [];
    expect(() => prepareObligationTransfer(input)).toThrow('occurrence_transfer_source_conflict');
  });
});
