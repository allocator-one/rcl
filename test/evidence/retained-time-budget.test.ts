import { describe, expect, it, vi } from 'vitest';
import { retainedPaidCutoff } from '../../src/evidence/retained-time-budget.js';

describe('retained finalization headroom', () => {
  it('reserves a deterministic quarter capped at two minutes inside the immutable deadline', () => {
    expect(retainedPaidCutoff({ startedAtMs: 1000, expiresAtMs: 4000 })).toBe(3250);
    expect(retainedPaidCutoff({ startedAtMs: 1000, expiresAtMs: 1201000 })).toBe(1081000);
    expect(retainedPaidCutoff({ startedAtMs: 1000, expiresAtMs: 1004 })).toBe(1003);
  });
  it('never reads a clock or renews the cutoff on restart', () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock forbidden'); });
    try { expect(retainedPaidCutoff({ startedAtMs: 1000, expiresAtMs: 4000 })).toBe(3250); } finally { clock.mockRestore(); }
  });
  it('refuses tiny and malformed new budgets instead of creating unbounded or unreserved paid work', () => {
    for (const expiresAtMs of [1000, 1001, 1003, Number.NaN, Number.POSITIVE_INFINITY, 1004.5]) {
      expect(() => retainedPaidCutoff({ startedAtMs: 1000, expiresAtMs })).toThrow('retained_execution_budget');
    }
  });
});
