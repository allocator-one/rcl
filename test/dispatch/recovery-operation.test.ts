import { describe, expect, it } from 'vitest';
import {
  createRecoveryOperation,
  decodeRecoveryOperation,
  encodeRecoveryOperation,
  remainingRecoveryBudget,
  type RecoveryOperationInput,
} from '../../src/dispatch/recovery-operation.js';

const uuid = {
  operationId: '11111111-1111-4111-8111-111111111111',
  successorRunId: '22222222-2222-4222-8222-222222222222',
  sourceRunId: '01a0daa6-b575-759b-942c-e879460be5bf',
};
const digest = (char: string) => char.repeat(64);
function input(overrides: Partial<RecoveryOperationInput> = {}): RecoveryOperationInput {
  return {
    ...uuid,
    sourceReportSha256: digest('a'),
    sourceCheckpointSha256: digest('b'),
    capturedInputsSha256: digest('c'),
    planDigest: digest('d'),
    target: 'allocator-one/allocator-one#9165',
    originalNativeClaim: { attempt: 25, round: 14 },
    startedAtMs: 1_000,
    expiresAtMs: 10_000,
    maxAdditionalCalls: 7,
    maxAttemptsPerCell: 2,
    ...overrides,
  };
}

describe('recovery operation descriptor', () => {
  it('canonicalizes and round-trips an immutable versioned descriptor', () => {
    const operation = createRecoveryOperation(input());
    const encoded = encodeRecoveryOperation(operation);
    expect(encoded).toBe(encodeRecoveryOperation(decodeRecoveryOperation(encoded)));
    expect(decodeRecoveryOperation(encoded)).toEqual(operation);
    expect(() => decodeRecoveryOperation(` ${encoded}`)).toThrow('recovery_operation_noncanonical_json');
    expect(Object.isFrozen(operation)).toBe(true);
  });

  it('accepts v7 run IDs but rejects source/successor reuse and malformed persisted bounds', () => {
    expect(createRecoveryOperation(input()).sourceRunId).toBe('01a0daa6-b575-759b-942c-e879460be5bf');
    expect(() => createRecoveryOperation(input({ successorRunId: '01A0DAA6-B575-759B-942C-E879460BE5BF' }))).toThrow('recovery_operation_source_successor_reused');
    expect(() => createRecoveryOperation(input({ target: '   ' }))).toThrow('recovery_operation_invalid_target');
    expect(() => createRecoveryOperation(input({ expiresAtMs: 1_000 + 2_147_483_648 }))).toThrow('recovery_operation_invalid_deadline');
  });

  it('fails closed for duplicate, unknown, malformed, or inconsistent descriptor fields', () => {
    const encoded = encodeRecoveryOperation(createRecoveryOperation(input()));
    expect(() => decodeRecoveryOperation(encoded.replace('{', '{"unknown":true,'))).toThrow('recovery_operation_unknown_field');
    expect(() => decodeRecoveryOperation(encoded.replace('"version":1', '"version":1,"version":1'))).toThrow('recovery_operation_noncanonical_json');
    expect(() => createRecoveryOperation(input({ operationId: 'not-a-uuid' }))).toThrow('recovery_operation_invalid_operation_id');
    expect(() => createRecoveryOperation(input({ expiresAtMs: 999 }))).toThrow('recovery_operation_invalid_deadline');
    expect(() => createRecoveryOperation(input({ maxAdditionalCalls: 0 }))).toThrow('recovery_operation_invalid_max_additional_calls');
  });

  it('uses the persisted deadline across resume and only allows runtime tightening', () => {
    const operation = createRecoveryOperation(input());
    expect(remainingRecoveryBudget(operation, 4_000)).toEqual({ remainingMs: 6_000, maxAdditionalCalls: 7, maxAttemptsPerCell: 2, expiresAtMs: 10_000 });
    expect(remainingRecoveryBudget(operation, 4_000, { maxAdditionalCalls: 3, maxAttemptsPerCell: 1, expiresAtMs: 8_000 })).toEqual({ remainingMs: 4_000, maxAdditionalCalls: 3, maxAttemptsPerCell: 1, expiresAtMs: 8_000 });
    expect(remainingRecoveryBudget(operation, 10_001).remainingMs).toBe(0);
    expect(() => remainingRecoveryBudget(operation, 999)).toThrow('recovery_operation_clock_before_start');
    expect(() => remainingRecoveryBudget(operation, 4_000, { maxAdditionalCalls: 8 })).toThrow('recovery_operation_runtime_cap_raise');
    expect(() => remainingRecoveryBudget(operation, 4_000, { expiresAtMs: 10_001 })).toThrow('recovery_operation_runtime_deadline_extend');
    expect(() => remainingRecoveryBudget(operation, 4_000, null as unknown as Record<string, never>)).toThrow('recovery_operation_invalid_runtime_bounds');
    expect(() => remainingRecoveryBudget(operation, 4_000, { unknown: 1 } as unknown as Record<string, never>)).toThrow('recovery_operation_unknown_runtime_field');
    expect(() => remainingRecoveryBudget(operation, 4_000, { maxAdditionalCalls: null } as never)).toThrow('recovery_operation_invalid_runtime_cap');
    expect(() => remainingRecoveryBudget(operation, 4_000, { maxAttemptsPerCell: 0 })).toThrow('recovery_operation_invalid_runtime_cap');
  });
});
