import { expect, it } from 'vitest';
import {
  cloneUniqueEvidenceRows,
  deriveNativeOccurrenceEvidence,
  type AcceptedClaimDisposition,
} from '../../../src/evidence/claim-recovery/validation/native-occurrences.js';

it('deduplicates 2,000 reverse-ordered evidence rows with one canonicalization pass per row', () => {
  let reads = 0;
  const rows = Array.from({ length: 2_000 }, (_, index) => {
    const row = { index: 1_999 - index };
    Object.defineProperty(row, 'value', {
      enumerable: true,
      get: () => { reads += 1; return `value-${index}`; },
    });
    return row;
  });

  const retained = cloneUniqueEvidenceRows(rows);
  expect(retained).toHaveLength(2_000);
  expect([retained[0]!.index, retained.at(-1)!.index]).toEqual([1_999, 0]);
  expect(reads).toBe(4_000);
});

it('preserves the first row while resolving canonical-key collisions by deep equality', () => {
  const first = { first: 1, second: { value: 2 } };
  const duplicate = { second: { value: 2 }, first: 1 };
  const distinct = { first: 1, second: { value: 3 } };

  expect(cloneUniqueEvidenceRows([first, duplicate, distinct])).toEqual([first, distinct]);
});

it('refuses oversized raw proof lists before inspecting proof content', () => {
  let reads = 0;
  const poison = {};
  Object.defineProperty(poison, 'preparation', {
    enumerable: true,
    get: () => { reads += 1; throw new Error('proof_content_read'); },
  });

  expect(() => deriveNativeOccurrenceEvidence(
    { dispositions: Array(2_001).fill(poison) as AcceptedClaimDisposition[] },
    { target: 'rcl-test', sourceJson: '{}', anchors: [], previous: [] },
  )).toThrow('native_recovery_occurrence_conflict');
  expect(reads).toBe(0);
});
