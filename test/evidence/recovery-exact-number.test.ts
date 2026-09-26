import { expect, it } from 'vitest';
import { decodeOriginalReport } from '../../src/evidence/original-run/decode.js';

it('refuses a rounded numeric binding under exact recovery interpretation', () => {
  const raw = '{"event_sequence":1.234567890123456789}';
  expect(decodeOriginalReport(raw).value).toEqual({ event_sequence: 1.2345678901234567 });
  expect(() => decodeOriginalReport(raw, { exactNumbers: true })).toThrow('invalid_or_ambiguous_original_json');
});

it('accepts non-negative-zero decimal spellings without changing their meaning', () => {
  for (const token of ['1.00', '100e-2', '0e1000', '0.125', '9007199254740991']) {
    const decoded = decodeOriginalReport('{"value":' + token + '}', { exactNumbers: true }).value as { value: number };
    expect(decoded.value === JSON.parse(token)).toBe(true);
  }
});

it('refuses negative zero because JSON cloning cannot preserve its sign', () => {
  expect(() => decodeOriginalReport('{"value":-0}', { exactNumbers: true })).toThrow('invalid_or_ambiguous_original_json');
});
