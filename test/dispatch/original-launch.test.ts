import { describe, expect, it } from 'vitest';
import { createOriginalLaunch, decodeOriginalLaunch, encodeOriginalLaunch, remainingOriginalBudget, type OriginalLaunchInput } from '../../src/dispatch/original-launch.js';

const hash = (letter: string) => letter.repeat(64);
function input(overrides: Partial<OriginalLaunchInput> = {}): OriginalLaunchInput {
  return {
    runId: '01a0daa6-b575-759b-942c-e879460be5bf',
    target: 'allocator-one/allocator-one#9165',
    originalNativeClaim: { attempt: 25, round: 14 },
    capturedInputsSha256: hash('a'),
    planDigest: hash('b'),
    startedAtMs: 1_000,
    expiresAtMs: 10_000,
    maxPhysicalCalls: 17,
    maxAttemptsPerCell: 2,
    ...overrides,
  };
}

describe('original launch descriptor', () => {
  it('canonicalizes and round-trips an immutable original-run descriptor without ancestry fields', () => {
    const launch = createOriginalLaunch(input());
    const bytes = encodeOriginalLaunch(launch);
    expect(decodeOriginalLaunch(bytes)).toEqual(launch);
    expect(bytes).toBe(encodeOriginalLaunch(decodeOriginalLaunch(bytes)));
    expect(Object.isFrozen(launch)).toBe(true);
    expect(bytes).not.toContain('sourceRunId');
    expect(bytes).not.toContain('successorRunId');
  });

  it('fails closed for unknown, duplicate, malformed, or noncanonical descriptors', () => {
    const bytes = encodeOriginalLaunch(createOriginalLaunch(input()));
    expect(() => decodeOriginalLaunch(bytes.replace('{', '{"unknown":true,'))).toThrow('original_launch_invalid_document');
    expect(() => decodeOriginalLaunch(bytes.replace('"version":1', '"version":1,"version":1'))).toThrow('original_launch_noncanonical');
    expect(() => decodeOriginalLaunch(` ${bytes}`)).toThrow('original_launch_noncanonical');
    expect(() => createOriginalLaunch(input({ runId: 'bad' }))).toThrow('original_launch_invalid_run_id');
    expect(() => createOriginalLaunch(input({ expiresAtMs: 999 }))).toThrow('original_launch_invalid_deadline');
    expect(() => createOriginalLaunch(input({ maxPhysicalCalls: 0 }))).toThrow('original_launch_invalid_max_physical_calls');
  });

  it('derives remaining budget only from the persisted deadline and permits runtime tightening', () => {
    const launch = createOriginalLaunch(input());
    expect(remainingOriginalBudget(launch, 4_000)).toEqual({ remainingMs: 6_000, maxPhysicalCalls: 17, maxAttemptsPerCell: 2, expiresAtMs: 10_000 });
    expect(remainingOriginalBudget(launch, 4_000, { maxPhysicalCalls: 3, maxAttemptsPerCell: 1, expiresAtMs: 8_000 })).toEqual({ remainingMs: 4_000, maxPhysicalCalls: 3, maxAttemptsPerCell: 1, expiresAtMs: 8_000 });
    expect(remainingOriginalBudget(launch, 10_001).remainingMs).toBe(0);
    expect(() => remainingOriginalBudget(launch, 999)).toThrow('original_launch_clock_before_start');
    expect(remainingOriginalBudget(launch, 4_000, { maxPhysicalCalls: 0 }).maxPhysicalCalls).toBe(0);
    expect(() => remainingOriginalBudget(launch, 4_000, { maxAttemptsPerCell: 0 })).toThrow('original_launch_invalid_runtime_cap');
    expect(() => remainingOriginalBudget(launch, 4_000, { maxPhysicalCalls: 18 })).toThrow('original_launch_runtime_cap_raise');
    expect(() => remainingOriginalBudget(launch, 4_000, { expiresAtMs: 10_001 })).toThrow('original_launch_runtime_deadline_extend');
  });
});
