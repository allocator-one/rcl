import { afterEach, expect, it, vi } from 'vitest';
import * as decoder from '../../src/evidence/original-run/decode.js';
import { decodeRecoveryOriginal } from '../../src/evidence/claim-recovery/validation/recovery-json.js';
afterEach(() => vi.restoreAllMocks());
const original = (title: string) => JSON.stringify({ findings: [{ title, description: 'x'.repeat(1200) }] });
it('reuses strict decoding for identical bytes and interpretation without exposing mutable cached objects', () => {
  const spy = vi.spyOn(decoder, 'decodeOriginalReport');
  const text = original('cache same-byte test');
  const first = decodeRecoveryOriginal(text, { exactNumbers: true });
  (first.value as any).findings[0].title = 'mutated caller';
  expect((decodeRecoveryOriginal(text, { exactNumbers: true }).value as any).findings[0].title).toBe('cache same-byte test');
  expect(spy).toHaveBeenCalledTimes(1);
  expect((decodeRecoveryOriginal(original('changed source bytes'), { exactNumbers: true }).value as any).findings[0].title).toBe('changed source bytes');
  expect(spy).toHaveBeenCalledTimes(2);
});
it('does not reuse a permissive interpretation for exact numbers or original prose policy', () => {
  const text = '{"description":"' + 'x'.repeat(1200) + '","value":1.234567890123456789}';
  decodeRecoveryOriginal(text);
  expect(() => decodeRecoveryOriginal(text, { exactNumbers: true })).toThrow();
  const prose = original('\u007f');
  decodeRecoveryOriginal(prose, { exactNumbers: true, originalProse: 'control-code-units-v1' });
  expect(() => decodeRecoveryOriginal(prose, { exactNumbers: true })).toThrow();
});
it('does not conflate distinct raw UTF-16 units with the same replacement-encoded UTF-8 digest', () => {
  const high = '{"findings":[{"title":"' + '\ud800' + '","description":"' + 'x'.repeat(1200) + '"}]}';
  const low = high.replace('\ud800', '\udc00');
  expect(Buffer.from(high)).toEqual(Buffer.from(low));
  expect(() => decodeRecoveryOriginal(high)).toThrow('unsupported_literal_surrogate');
  expect(() => decodeRecoveryOriginal(low)).toThrow('unsupported_literal_surrogate');
  const valid = high.replace('\ud800', '\ufffd');
  decodeRecoveryOriginal(valid);
  expect(() => decodeRecoveryOriginal(high)).toThrow('unsupported_literal_surrogate');
});
it('evicts bounded entries and never caches duplicate-key refusal', () => {
  const spy = vi.spyOn(decoder, 'decodeOriginalReport');
  const first = original('eviction first'); decodeRecoveryOriginal(first);
  for (let i = 0; i < 17; i++) decodeRecoveryOriginal(original('eviction '+i));
  const calls = spy.mock.calls.length; decodeRecoveryOriginal(first); expect(spy.mock.calls.length).toBe(calls + 1);
  const duplicate = '{"x":1,"x":2,"description":"'+'x'.repeat(1200)+'"}';
  expect(() => decodeRecoveryOriginal(duplicate)).toThrow(); expect(() => decodeRecoveryOriginal(duplicate)).toThrow();
});
