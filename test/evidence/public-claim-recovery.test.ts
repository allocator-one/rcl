import { decodeOriginalReport } from '../../src/evidence/original-run/decode.js';
import { describe,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import { prepareClaimSplit } from '../../src/evidence/claim-split.js';
import { prepareClaimSplit as pureSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { validateOccurrenceSource } from '../../src/evidence/claim-recovery/validation/occurrence-source.js';
import { fixture } from './recovery-validation/occurrence-fixtures.js';
it.each(['\\uD800','\\u0000'])('original prose %s preserves the raw digest through split and occurrence binding',escaped => {
  const { transfer }=fixture();
  const selection=transfer.split.selection;
  const report=JSON.parse(selection.reportJson);
  report.findings[0].description='original PROSE';
  const raw=JSON.stringify(report).replace('original PROSE',`original ${escaped}`);
  selection.reportJson=raw;
  transfer.split.source.reportJson=raw;
  const digest=createHash('sha256').update(raw).digest('hex');
  transfer.split.source.storedRun.artifacts=[{ kind: 'report_json',stored: true,declared_bytes: Buffer.byteLength(raw),declared_sha256: digest }];
  const actual=prepareClaimSplit(selection);
  expect(actual.source.reportSha256).toBe(digest);
  expect(pureSplit(selection)).toEqual(actual);
  expect(validateOccurrenceSource(transfer.split.source).digest).toBe(digest);
  expect(selection.reportJson).toBe(raw);
});
describe('retained document strings are not reinterpreted as original prose',() => {
  it('preserves exact original JSON text including literal DEL while refusing duplicate keys and inexact numbers',async () => {
    const { decodeRecoveryDocument }=await import('../../src/evidence/original-run/decode.js');
    const original='{"findings":[{"description":"literal \u007f and \\ud800"}]}';
    expect(decodeRecoveryDocument(JSON.stringify({ reportJson: original }))).toEqual({ reportJson: original });
    expect(() => decodeRecoveryDocument('{"reportJson":"a","reportJson":"b"}')).toThrow();
    expect(() => decodeRecoveryDocument('{"value":0.10000000000000001}')).toThrow();
    expect(() => decodeOriginalReport(original,{ exactNumbers: true })).toThrow();
  });
});
