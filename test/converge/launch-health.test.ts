import { describe, expect, it } from 'vitest';
import { hasHealthyGuardedLaunch, launchSchema } from '../../src/converge/launch-guard.js';
import { completionSchema } from '../../src/converge/launch-record.js';
import { resolveQuorumPolicy } from '../../src/dispatch/quorum.js';

const completed = {
  status: 'completed' as const, attempt: 25, round: 21,
  headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
  startedAt: '2026-09-27T20:15:52.000Z', pid: 123,
  runId: '01a0e4ac-58d9-7cc5-a722-0b50ed087b7a', reportJsonSha256: 'c'.repeat(64),
  successfulReviews: 12, totalReviews: 17, deliveryPending: false,
  reviewerHealth: { version: 1 as const,
    policy: { version: 1 as const, fraction: 0.75, seatCount: 17, minimumSuccessful: 13 },
    successfulSeats: 12 },
};

describe('guarded launch blocking health', () => {
  it('uses the frozen configured minimum instead of hardcoded two-thirds', () => {
    expect(hasHealthyGuardedLaunch(completed)).toBe(false);
    expect(launchSchema.parse(completed)).toEqual(completed);
    const reached = { ...completed, successfulReviews: 13,
      reviewerHealth: { ...completed.reviewerHealth, successfulSeats: 13 } };
    expect(hasHealthyGuardedLaunch(reached)).toBe(true);
  });

  it.each([
    { ...completed.reviewerHealth, version: 2 },
    { ...completed.reviewerHealth, successfulSeats: 18 },
    { ...completed.reviewerHealth, policy: { ...completed.reviewerHealth.policy, minimumSuccessful: 12 } },
    { ...completed.reviewerHealth, policy: { ...completed.reviewerHealth.policy, fraction: 0.5 } },
  ])('refuses malformed or contradictory versioned health', reviewerHealth => {
    expect(() => launchSchema.parse({ ...completed, reviewerHealth })).toThrow();
  });

  it.each([
    [6, 10, 11, 16],
    [11, 17, 12, 18],
    [2, 3, 2, 3],
  ] as const)('accepts blocking %i/%i as a subset of aggregate %i/%i',
    (successfulSeats, seatCount, successfulReviews, totalReviews) => {
      const value = { ...completed, successfulReviews, totalReviews,
        reviewerHealth: { version: 1 as const, policy: resolveQuorumPolicy(seatCount), successfulSeats } };
      expect(completionSchema.safeParse(value).success).toBe(true);
      expect(launchSchema.safeParse(value).success).toBe(true);
    });

  it.each([
    ['blocking seats exceed all reviews', 6, 16, 11, 15],
    ['blocking successes exceed all successes', 6, 10, 5, 15],
    ['blocking failures exceed aggregate failures', 0, 17, 17, 18],
  ] as const)('refuses %s in completion and persisted launch',
    (_label, successfulSeats, seatCount, successfulReviews, totalReviews) => {
      const value = { ...completed, successfulReviews, totalReviews,
        reviewerHealth: { version: 1 as const, policy: resolveQuorumPolicy(seatCount), successfulSeats } };
      expect(completionSchema.safeParse(value).success).toBe(false);
      expect(launchSchema.safeParse(value).success).toBe(false);
    });

  it('keeps aggregate-only legacy completion readable and refuses health on a pending launch', () => {
    const { reviewerHealth, ...legacy } = completed;
    expect(completionSchema.safeParse(legacy).success).toBe(true);
    expect(launchSchema.safeParse({ ...legacy, status: 'pending', reviewerHealth }).success).toBe(false);
  });
});
