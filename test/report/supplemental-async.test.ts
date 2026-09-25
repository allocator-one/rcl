import { describe, expect, it } from 'vitest';
import { captureSupplementalAsync, decodeSupplementalAsync, isSupplementalAsync } from '../../src/report/supplemental-async.js';
import type { ModelReview } from '../../src/consensus/types.js';
import { stableStringify } from '../../src/report/run-header.js';

function raw(overrides: Partial<ModelReview> = {}): string {
  return JSON.stringify({ model: 'async-model', role: 'general', provider: 'fake', status: 'success', durationMs: 3, findings: [], async: true, ...overrides }, null, 2);
}

describe('supplemental async snapshot', () => {
  it('preserves exact ordered opaque review bytes in an immutable branded snapshot', () => {
    const first = raw(), second = raw({ model: 'second' });
    const source = [first, second];
    const snapshot = captureSupplementalAsync(source, 4);
    source[0] = raw({ model: 'mutated-after-capture' });
    expect(snapshot.reviewBytes).toEqual([first, second]);
    expect(snapshot.reviews.map(review => review.model)).toEqual(['async-model', 'second']);
    expect(snapshot.asyncLaunched).toBe(4);
    expect(snapshot.bytes).toBe(stableStringify({ version: 1, asyncLaunched: 4, reviewBytes: [first, second] }));
    expect(isSupplementalAsync(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.reviewBytes)).toBe(true);
    expect(Object.isFrozen(snapshot.reviews[0]!)).toBe(true);
    expect(Reflect.set(snapshot.reviewBytes as string[], 0, 'mutated')).toBe(false);
    expect(isSupplementalAsync(JSON.parse(snapshot.bytes))).toBe(false);
  });

  it('retains failed async evidence byte-for-byte while refusing mutation, unknown fields, noncanonical wire, and non-async reviews', () => {
    const snapshot = captureSupplementalAsync([raw()], 1);
    expect(decodeSupplementalAsync(snapshot.bytes)).toEqual(snapshot);
    expect(() => decodeSupplementalAsync(` ${snapshot.bytes}`)).toThrow('supplemental_async_noncanonical');
    const unknown = JSON.parse(snapshot.bytes); unknown.authority = 'provider';
    expect(() => decodeSupplementalAsync(stableStringify(unknown))).toThrow('supplemental_async_invalid_document');
    const failed = raw({ status: 'error', findings: [{ id: 'failed', file: 'a.ts', startLine: 1, endLine: 1, severity: 'minor', category: 'tests', title: 'Failed review finding', description: 'Retain failed async evidence.' }], usage: { inputTokens: 4, outputTokens: 2 }, error: 'provider timeout' });
    const retained = captureSupplementalAsync([failed], 1);
    expect(retained.reviewBytes).toEqual([failed]);
    expect(retained.reviews[0]).toMatchObject({ status: 'error', error: 'provider timeout', usage: { inputTokens: 4, outputTokens: 2 }, findings: [{ id: 'failed' }] });
    expect(() => captureSupplementalAsync([raw({ async: undefined })], 1)).toThrow('supplemental_async_invalid_review');
    expect(() => captureSupplementalAsync([raw({ status: 'invalid' as ModelReview['status'] })], 1)).toThrow('supplemental_async_invalid_review');
    expect(() => captureSupplementalAsync([raw()], -1)).toThrow('supplemental_async_invalid_async_launched');
  });

  it('rejects invalid UTF-8 representations and whole snapshots above the shared bound', () => {
    expect(() => captureSupplementalAsync(['\ud800'], 0)).toThrow('supplemental_async_invalid_bytes');
    expect(() => decodeSupplementalAsync('x'.repeat(8 * 1024 * 1024 + 1))).toThrow('supplemental_async_too_large');
  });
});
