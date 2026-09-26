import { expect, it } from 'vitest';
import { isEventReceipt, matchesPreparedEventReceipt } from '../../../src/evidence/claim-recovery/validation/receipts.js';
import { decodeOriginalReport } from '../../../src/evidence/original-run/decode.js';
import { receiptFixture } from './receipt-fixture.js';
import { uuid } from './uuid.js';

it('matches base event content at full precision without claiming stored acceptance metadata', () => {
  const f = receiptFixture(); const receipt = structuredClone(f.receipt);
  receipt.occurred_at = '2026-09-22T14:00:00.123456+02:00';
  const before = structuredClone(receipt);
  expect(isEventReceipt(receipt, f.scope)).toBe(true);
  expect(matchesPreparedEventReceipt(receipt, f.eventJson, f.scope, uuid(7))).toBe(true);
  expect(receipt).toEqual(before);
  expect(receipt).not.toHaveProperty('sequence');
  expect(receipt).not.toHaveProperty('received_at');
});

it.each([
  { actor_user_id: null }, { actor_user_id: uuid(99) }, { id: uuid(99) }, { run_id: uuid(99) },
  { org_id: uuid(99) }, { repo: 'synthetic/other' }, { pr_number: 8 }, { converge_target: 'other' },
  { round: 2 }, { attempt: 2 }, { occurred_at: '2026-09-22T12:00:00.123457Z' },
  { occurred_at: '2026-02-30T12:00:00.123456Z' },
])('refuses a changed receipt binding: %j', changed => {
  const f = receiptFixture();
  expect(matchesPreparedEventReceipt({ ...f.receipt, ...changed }, f.eventJson, f.scope, uuid(7))).toBe(false);
});

it('keeps payload absence, nulls and array order distinct and refuses ambiguous prepared JSON', () => {
  const f = receiptFixture(); const event = JSON.parse(f.eventJson);
  event.payload = { ordered: ['first', 'second'], retained: null };
  const receipt = { ...f.receipt, payload: structuredClone(event.payload) };
  const raw = JSON.stringify(event);
  expect(matchesPreparedEventReceipt(receipt, raw, f.scope, uuid(7))).toBe(true);
  delete receipt.payload.retained;
  expect(matchesPreparedEventReceipt(receipt, raw, f.scope, uuid(7))).toBe(false);
  receipt.payload = { ordered: ['second', 'first'], retained: null };
  expect(matchesPreparedEventReceipt(receipt, raw, f.scope, uuid(7))).toBe(false);
  receipt.payload = event.payload;
  expect(matchesPreparedEventReceipt(receipt, raw.replace('"round":1', '"round":2,"round":1'), f.scope, uuid(7))).toBe(false);
  expect(matchesPreparedEventReceipt(receipt, raw.replace('"round":1', '"round":1.0000000000000001'), f.scope, uuid(7))).toBe(false);
});

it('adds opt-in exact decimal checks while preserving the current main decoder default', () => {
  const raw = '{"value":0.10000000000000001}';
  expect(decodeOriginalReport(raw).value).toEqual({ value: 0.1 });
  expect(() => decodeOriginalReport(raw, { exactNumbers: true })).toThrow('invalid_or_ambiguous_original_json');
  expect(decodeOriginalReport('{"value":1.00e-1}', { exactNumbers: true }).value).toEqual({ value: 0.1 });
});
