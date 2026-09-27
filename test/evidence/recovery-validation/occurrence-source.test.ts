import { describe, expect, it, vi } from 'vitest';
import { requireReason, validateOccurrenceSource } from '../../../src/evidence/claim-recovery/validation/occurrence-source.js';
import { fixture, rebind } from './occurrence-fixtures.js';
import { sha, uuid } from './fixtures.js';

describe('original occurrence classification', () => {
  it('rejects an oversized reason before enumerating its code points', () => {
    const value = 'x'.repeat(4001); const iterator = String.prototype[Symbol.iterator];
    let enumerated = false;
    const spy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (this: string) {
      if (this.valueOf() === value) enumerated = true;
      return iterator.call(this);
    });
    try {
      expect(() => requireReason(value)).toThrow('occurrence_source_conflict');
      expect(enumerated).toBe(false);
    }
    finally { spy.mockRestore(); }
  });

  it('accepts a 2,000-code-point astral reason at the UTF-16 boundary', () => {
    expect(() => requireReason('😀'.repeat(2000))).not.toThrow();
  });

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

  it('keeps a uniform classification status after an identity-only correction without choosing a mapping row', () => {
    const { transfer } = fixture();
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const original = rows[0]!;
    delete source.classification.payload.classification_version;
    source.classification.payload.identities = [
      { ...original, status: 'new' },
      { ...original, status: 'new', matched_identity: '4444444444444444' },
      ...rows.slice(1),
    ];
    source.corrections = [{ ...source.classification, id: uuid(952), kind: 'finding_identity_corrected', actor_user_id: uuid(953),
      sequence: 2, received_at: '2026-09-22T11:30:00.123456Z', payload: { org_id: source.scope.org_id,
        repo: source.scope.repo, pr_number: source.scope.pr_number, head_sha: transfer.sourceContext.headSha,
        report_json_sha256: sha(source.reportJson), finding_ref: 'f001', identity_key: original.identity_key,
        matched_identity: '3333333333333333' } }];

    const member = validateOccurrenceSource(source).members[0]!;
    expect(member).toMatchObject({ identity: '3333333333333333', classificationStanding: { kind: 'known', status: 'new' } });
    expect(member.mapping).toBeUndefined();
  });

  it('keeps classification standing unknown when an identity-only correction follows conflicting statuses', () => {
    const { transfer } = fixture();
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const original = rows[0]!;
    delete source.classification.payload.classification_version;
    source.classification.payload.identities = [
      { ...original, status: 'new' },
      { ...original, status: 'regating', matched_identity: '4444444444444444' },
      ...rows.slice(1),
    ];
    source.corrections = [{ ...source.classification, id: uuid(954), kind: 'finding_identity_corrected', actor_user_id: uuid(955),
      sequence: 2, received_at: '2026-09-22T11:30:00.123456Z', payload: { org_id: source.scope.org_id,
        repo: source.scope.repo, pr_number: source.scope.pr_number, head_sha: transfer.sourceContext.headSha,
        report_json_sha256: sha(source.reportJson), finding_ref: 'f001', identity_key: original.identity_key,
        matched_identity: '3333333333333333' } }];

    const member = validateOccurrenceSource(source).members[0]!;
    expect(member).toMatchObject({ identity: '3333333333333333', classificationStanding: { kind: 'unknown' } });
    expect(member.mapping).toBeUndefined();
  });

  it.each([false, true])('keeps standing unknown for conflicting bound and unbound rows in either order (bound first: %s)', boundFirst => {
    const { transfer } = fixture(true);
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const bound = rows[0]!;
    const unbound = { identity_key: bound.identity_key, matched_identity: '4444444444444444', status: 'regating',
      claim_descriptor: bound.claim_descriptor };
    delete source.classification.payload.classification_version;
    source.classification.payload.identities = boundFirst ? [...rows, unbound] : [unbound, ...rows];
    source.corrections = [{ ...source.classification, id: uuid(boundFirst ? 956 : 957), kind: 'finding_identity_corrected',
      actor_user_id: uuid(958), sequence: 2, received_at: '2026-09-22T11:30:00.123456Z', payload: {
        org_id: source.scope.org_id, repo: source.scope.repo, pr_number: source.scope.pr_number, head_sha: transfer.sourceContext.headSha,
        report_json_sha256: sha(source.reportJson), finding_ref: 'f001', identity_key: bound.identity_key,
        matched_identity: '3333333333333333' } }];

    const member = validateOccurrenceSource(source).members[0]!;
    expect(member).toMatchObject({ identity: '3333333333333333', classificationStanding: { kind: 'unknown' } });
    expect(member.mapping).toBeUndefined();
  });

  it.each([false, true])('preserves receipt order when bound and unbound mappings agree (bound first: %s)', boundFirst => {
    const { transfer } = fixture(true);
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const bound = rows[0]!;
    const unbound = { identity_key: bound.identity_key, matched_identity: bound.matched_identity,
      status: bound.status, claim_descriptor: bound.claim_descriptor };
    delete source.classification.payload.classification_version;
    source.classification.payload.identities = boundFirst ? [...rows, unbound] : [unbound, ...rows];
    const member = validateOccurrenceSource(source).members[0]!;
    expect(member.mapping).toBe(boundFirst ? bound : unbound);
    expect(member.identity).toBe(transfer.split.selection.previousIdentity);
  });

  it.each([false, true])('refuses contradictory legacy statuses for one occurrence (suppressed first: %s)', suppressedFirst => {
    const { transfer } = fixture();
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const suppressed = { ...rows[0]!, status: 'suppressed' };
    const regating = { ...rows[0]!, status: 'regating' };
    source.classification.payload.identities = [
      ...(suppressedFirst ? [suppressed, regating] : [regating, suppressed]), ...rows.slice(1),
    ];
    expect(() => validateOccurrenceSource(source)).toThrow('occurrence_source_conflict');
  });

  it.each([false, true])('refuses a legacy status conflicting with its exact positional binding (bound first: %s)', boundFirst => {
    const { transfer } = fixture(true);
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const bound = rows[0]!;
    const unbound = { identity_key: bound.identity_key, matched_identity: bound.matched_identity,
      status: bound.status === 'suppressed' ? 'regating' : 'suppressed', claim_descriptor: bound.claim_descriptor };
    delete source.classification.payload.classification_version;
    source.classification.payload.identities = boundFirst ? [...rows, unbound] : [unbound, ...rows];
    expect(() => validateOccurrenceSource(source)).toThrow('occurrence_source_conflict');
  });

  it('retains ambiguity when an unbound mapping disagrees with an exact positional mapping', () => {
    const { transfer } = fixture(true);
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const bound = rows[0]!;
    delete source.classification.payload.classification_version;
    rows.push({ identity_key: bound.identity_key, matched_identity: '4444444444444444',
      status: 'repeat', claim_descriptor: bound.claim_descriptor });
    const member = validateOccurrenceSource(source).members[0]!;
    expect(member.unresolvedReason).toBe('classification-ambiguous');
    expect(member.identity).toBeUndefined();
  });

  it.each([false, true])('refuses mixed descriptor presence in duplicate legacy mappings (descriptor first: %s)', descriptorFirst => {
    const { transfer } = fixture();
    const source = transfer.split.source;
    const rows = source.classification.payload.identities as Array<Record<string, unknown>>;
    const missing = { ...rows[0]! };
    delete missing.claim_descriptor;
    source.classification.payload.identities = descriptorFirst ? [...rows, missing] : [missing, ...rows];
    expect(() => validateOccurrenceSource(source)).toThrow('occurrence_source_conflict');
  });

  it('refuses legacy classification rows beyond the supported finding count', () => {
    const { transfer } = fixture();
    const source = transfer.split.source;
    const row = (source.classification.payload.identities as Array<Record<string, unknown>>)[0]!;
    source.classification.payload.identities = Array(2001).fill(row);
    expect(() => validateOccurrenceSource(source)).toThrow('occurrence_source_conflict');
  });

  it.each(['legacy-distinct', 'legacy-shared', 'marked-shared'])(
    'keeps %s membership lookup linear at the full supported finding count', kind => {
    const { transfer, report } = fixture(kind === 'marked-shared');
    const prototype = report.findings[0];
    report.findings = Array.from({ length: 2000 }, (_, index) => ({ ...structuredClone(prototype), identity: kind === 'marked-shared' ? 'shared-raw' : `raw-${index}` }));
    report.belowThresholdFindings = [];
    rebind(transfer, report);
    if (kind === 'legacy-shared') {
      // The split helper correctly refuses ambiguous legacy membership; this
      // reader must retain that unresolved source without preparing a split.
      for (const finding of report.findings) finding.identity = 'shared-raw';
      const source = transfer.split.source;
      source.reportJson = JSON.stringify(report);
      const artifact = (source.storedRun.artifacts as Array<Record<string, unknown>>)[0]!;
      artifact.declared_sha256 = sha(source.reportJson);
      artifact.declared_bytes = Buffer.byteLength(source.reportJson);
      for (const member of source.storedRun.findings as Array<Record<string, unknown>>) member.identity_key = 'shared-raw';
      for (const row of source.classification.payload.identities as Array<Record<string, unknown>>) row.identity_key = 'shared-raw';
    }
    const originalSome = Array.prototype.some;
    const originalFilter = Array.prototype.filter;
    let visits = 0;
    const some = vi.spyOn(Array.prototype, 'some').mockImplementation(function (this: unknown[], callback, thisArg) {
      return originalSome.call(this, (value, index, values) => { visits++; return callback.call(thisArg, value, index, values); });
    });
    const filter = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], callback, thisArg) {
      return originalFilter.call(this, (value, index, values) => { visits++; return callback.call(thisArg, value, index, values); });
    });
    try {
      const result = validateOccurrenceSource(transfer.split.source);
      expect(result.members).toHaveLength(2000);
      expect(result.members.every(member => kind === 'legacy-shared'
        ? member.identity === undefined && member.unresolvedReason === 'classification-ambiguous'
        : member.identity === transfer.split.selection.previousIdentity && member.unresolvedReason === undefined)).toBe(true);
    } finally { some.mockRestore(); filter.mockRestore(); }
    expect(visits).toBeGreaterThan(0);
    expect(visits).toBeLessThan(100 * report.findings.length);
  });

});
