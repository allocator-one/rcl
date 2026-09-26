import { describe, expect, it } from 'vitest';
import { hasSuccessfulQuorum, resolveQuorumPolicy } from '../../src/dispatch/quorum.js';

describe('successful blocking-seat quorum policy v1', () => {
  it.each([
    [0, 2], [1, 2], [2, 2], [3, 2], [5, 4], [6, 4], [17, 12], [18, 12],
  ])('resolves the default for %i frozen seats to %i successes', (seats, minimum) => {
    const policy = resolveQuorumPolicy(seats);
    expect(policy).toEqual({ version: 1, fraction: 2 / 3, seatCount: seats, minimumSuccessful: minimum });
    expect(hasSuccessfulQuorum(policy, seats)).toBe(seats >= 2);
    if (minimum <= seats) {
      expect(hasSuccessfulQuorum(policy, minimum - 1)).toBe(false);
      expect(hasSuccessfulQuorum(policy, minimum)).toBe(true);
    }
  });

  it.each([
    [5, 0.8, 4], [18, 0.9, 17], [18, 1, 18], [35, 0.8, 28],
    [4, 0.750000000001, 4], [3, 2 / 3 + Number.EPSILON, 3],
  ])(
    'preserves a stricter fraction for %i seats at %f', (seats, fraction, minimum) => {
      expect(resolveQuorumPolicy(seats, fraction).minimumSuccessful).toBe(minimum);
    }
  );

  it.each([-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid roster size %s', seats => {
    expect(() => resolveQuorumPolicy(seats)).toThrow(/seat/i);
  });

  it.each([0, 0.66, 1.01, Number.NaN, Infinity])('rejects unsupported policy fraction %s', fraction => {
    expect(() => resolveQuorumPolicy(18, fraction)).toThrow(/fraction/i);
  });

  it.each([-1, 19, 1.5, Number.NaN])('refuses impossible or duplicate-inflated success count %s', successes => {
    expect(() => hasSuccessfulQuorum(resolveQuorumPolicy(18), successes)).toThrow(/success/i);
  });
});
