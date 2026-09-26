import { describe, expect, it } from 'vitest';
import { validateOccurrenceSource } from '../../../src/evidence/claim-recovery/validation/occurrence-source.js';
import { fixture, rebind } from './occurrence-fixtures.js';
import { sha, uuid } from './fixtures.js';

describe('original occurrence classification', () => {
  it('retains unambiguous unmarked membership, including a separately named appendix occurrence', () => {
    const { transfer } = fixture();
    const result = validateOccurrenceSource(transfer.split.source);
    expect(result.members.map(member => member.identity)).toEqual(Array(3).fill(transfer.split.selection.previousIdentity));
    expect(result.members.every(member => member.unresolvedReason === undefined)).toBe(true);
  });

  it.each(['kept', 'appendix'])('leaves a shared unmarked identity unresolved across %s occurrences', kind => {
    const { transfer, report } = fixture();
    const source = transfer.split.source;
    const duplicate = kind === 'kept' ? report.findings[1] : report.belowThresholdFindings[0];
    const originalIdentity = duplicate.identity;
    duplicate.identity = report.findings[0].identity;
    source.reportJson = JSON.stringify(report);
    const artifact = (source.storedRun.artifacts as Array<Record<string, unknown>>)[0]!;
    artifact.declared_sha256 = sha(source.reportJson);
    artifact.declared_bytes = Buffer.byteLength(source.reportJson);
    const members = source.storedRun.findings as Array<Record<string, unknown>>;
    members[kind === 'kept' ? 1 : 2]!.identity_key = duplicate.identity;
    source.classification.payload.identities = (source.classification.payload.identities as Array<Record<string, unknown>>)
      .filter(row => row.identity_key !== originalIdentity);

    const result = validateOccurrenceSource(source);
    const repeated = result.members.filter(member => member.raw.identity === duplicate.identity);
    expect(repeated).toHaveLength(2);
    expect(repeated.map(member => ({ identity: member.identity, reason: member.unresolvedReason }))).toEqual([
      { identity: undefined, reason: 'classification-ambiguous' },
      { identity: undefined, reason: 'classification-ambiguous' },
    ]);
  });

  it('accepts shared report keys when each occurrence has an exact positional classification', () => {
    const { transfer, report } = fixture(true);
    report.belowThresholdFindings[0].identity = report.findings[0].identity;
    rebind(transfer, report);
    const members = validateOccurrenceSource(transfer.split.source).members;
    expect(members).toHaveLength(3);
    expect(members.every(member => member.identity === transfer.split.selection.previousIdentity &&
      member.unresolvedReason === undefined)).toBe(true);
  });

  it.each(['unavailable', 'ambiguous'])('clears an %s classification residual after an exact positional correction', kind => {
    const { transfer } = fixture();
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const original = rows[0]!;
    source.classification.payload.identities = kind === 'unavailable' ? rows.slice(1) :
      [...rows, { ...original, matched_identity: '4444444444444444' }];
    expect(validateOccurrenceSource(source).members[0]!.unresolvedReason).toBe(`classification-${kind}`);
    const correction = { ...source.classification, id: uuid(950), kind: 'finding_identity_corrected',
      actor_user_id: uuid(951), sequence: 2, received_at: '2026-09-22T11:30:00.123456Z',
      payload: { org_id: source.scope.org_id, repo: source.scope.repo, pr_number: source.scope.pr_number,
        head_sha: transfer.sourceContext.headSha, report_json_sha256: sha(source.reportJson),
        finding_ref: 'f001', identity_key: original.identity_key, matched_identity: '3333333333333333' } };
    source.corrections = [correction];

    const member = validateOccurrenceSource(source).members[0]!;
    expect(member.identity).toBe('3333333333333333');
    expect(member.correction).toEqual(correction);
    expect(member.unresolvedReason).toBeUndefined();
  });
});
