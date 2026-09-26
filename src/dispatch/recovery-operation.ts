import { MAX_TIMER_DELAY_MS } from '../config/schema.js';
import { stableStringify } from '../report/run-header.js';
import { UUID } from '../telemetry/recovery/source.js';

const VERSION = 1;
// Descriptor caps are deliberately finite, independent of provider/native policy.
const MAX_LIMIT = 1_000_000;
const SHA256 = /^[a-f0-9]{64}$/;

export interface RecoveryOperationInput {
  operationId: string;
  successorRunId: string;
  sourceRunId: string;
  sourceReportSha256: string;
  sourceCheckpointSha256: string;
  capturedInputsSha256: string;
  planDigest: string;
  target: string;
  originalNativeClaim: { attempt: number; round: number };
  /** The separately claimed native attempt that owns this successor. */
  successorNativeClaim?: { attempt: number; round: number };
  startedAtMs: number;
  expiresAtMs: number;
  maxAdditionalCalls: number;
  maxAttemptsPerCell: number;
}

export interface RecoveryOperation extends RecoveryOperationInput { version: 1 }
export interface RecoveryRuntimeBounds {
  maxAdditionalCalls?: number;
  maxAttemptsPerCell?: number;
  expiresAtMs?: number;
}
export interface RecoveryBudget {
  remainingMs: number;
  maxAdditionalCalls: number;
  maxAttemptsPerCell: number;
  expiresAtMs: number;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[], unknownError: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new Error(unknownError);
}
function safeInteger(value: unknown, error: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(error);
}
function text(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 512 || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(error);
}
function digest(value: unknown, error: string): asserts value is string { if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(error); }
function uuid(value: unknown, error: string): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) throw new Error(error); }

function validate(input: RecoveryOperationInput | RecoveryOperation, requireVersion: boolean): RecoveryOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('recovery_operation_invalid_descriptor');
  if (!requireVersion && Object.hasOwn(input, 'successorNativeClaim') && input.successorNativeClaim === undefined) {
    const { successorNativeClaim: _ignored, ...normalized } = input;
    return validate(normalized, false);
  }
  const fields = ['operationId', 'successorRunId', 'sourceRunId', 'sourceReportSha256', 'sourceCheckpointSha256', 'capturedInputsSha256', 'planDigest', 'target', 'originalNativeClaim', 'startedAtMs', 'expiresAtMs', 'maxAdditionalCalls', 'maxAttemptsPerCell'];
  if (input.successorNativeClaim !== undefined) fields.push('successorNativeClaim');
  exactKeys(input as unknown as Record<string, unknown>, requireVersion ? ['version', ...fields] : fields, 'recovery_operation_unknown_field');
  if (requireVersion && (input as RecoveryOperation).version !== VERSION) throw new Error('recovery_operation_invalid_version');
  uuid(input.operationId, 'recovery_operation_invalid_operation_id');
  uuid(input.successorRunId, 'recovery_operation_invalid_successor_run_id');
  uuid(input.sourceRunId, 'recovery_operation_invalid_source_run_id');
  if (input.sourceRunId.toLowerCase() === input.successorRunId.toLowerCase()) throw new Error('recovery_operation_source_successor_reused');
  digest(input.sourceReportSha256, 'recovery_operation_invalid_source_report_sha256');
  digest(input.sourceCheckpointSha256, 'recovery_operation_invalid_source_checkpoint_sha256');
  digest(input.capturedInputsSha256, 'recovery_operation_invalid_captured_inputs_sha256');
  digest(input.planDigest, 'recovery_operation_invalid_plan_digest');
  text(input.target, 'recovery_operation_invalid_target');
  const claim = input.originalNativeClaim;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('recovery_operation_invalid_native_claim');
  exactKeys(claim as Record<string, unknown>, ['attempt', 'round'], 'recovery_operation_unknown_field');
  safeInteger(claim.attempt, 'recovery_operation_invalid_native_attempt', 1, MAX_LIMIT);
  safeInteger(claim.round, 'recovery_operation_invalid_native_round', 1, MAX_LIMIT);
  const successor = input.successorNativeClaim;
  if (successor !== undefined) {
    if (!successor || typeof successor !== 'object' || Array.isArray(successor)) throw new Error('recovery_operation_invalid_successor_native_claim');
    exactKeys(successor as Record<string, unknown>, ['attempt', 'round'], 'recovery_operation_invalid_successor_native_claim');
    safeInteger(successor.attempt, 'recovery_operation_invalid_successor_native_attempt', 1, MAX_LIMIT);
    safeInteger(successor.round, 'recovery_operation_invalid_successor_native_round', 1, MAX_LIMIT);
    if (successor.attempt === claim.attempt && successor.round === claim.round) throw new Error('recovery_operation_successor_native_claim_reused');
  }
  safeInteger(input.startedAtMs, 'recovery_operation_invalid_started_at', 0);
  safeInteger(input.expiresAtMs, 'recovery_operation_invalid_deadline', 0);
  if (input.expiresAtMs < input.startedAtMs || input.expiresAtMs - input.startedAtMs > MAX_TIMER_DELAY_MS) throw new Error('recovery_operation_invalid_deadline');
  safeInteger(input.maxAdditionalCalls, 'recovery_operation_invalid_max_additional_calls', 1, MAX_LIMIT);
  safeInteger(input.maxAttemptsPerCell, 'recovery_operation_invalid_max_attempts_per_cell', 1, MAX_LIMIT);
  return deepFreeze({
    version: VERSION,
    operationId: input.operationId,
    successorRunId: input.successorRunId,
    sourceRunId: input.sourceRunId,
    sourceReportSha256: input.sourceReportSha256,
    sourceCheckpointSha256: input.sourceCheckpointSha256,
    capturedInputsSha256: input.capturedInputsSha256,
    planDigest: input.planDigest,
    target: input.target,
    originalNativeClaim: { attempt: claim.attempt, round: claim.round },
    ...(successor === undefined ? {} : { successorNativeClaim: { attempt: successor.attempt, round: successor.round } }),
    startedAtMs: input.startedAtMs,
    expiresAtMs: input.expiresAtMs,
    maxAdditionalCalls: input.maxAdditionalCalls,
    maxAttemptsPerCell: input.maxAttemptsPerCell,
  });
}

/** Creates a local immutable descriptor; it does not verify any referenced authority or producer. */
export function createRecoveryOperation(input: RecoveryOperationInput): RecoveryOperation {
  const operation = validate(input, false);
  canonicalDescriptor(operation);
  return operation;
}

function canonicalDescriptor(operation: RecoveryOperation): string {
  const encoded = stableStringify(operation);
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new Error('recovery_operation_too_large');
  return encoded;
}

/** Canonical JSON is the persisted descriptor format. */
export function encodeRecoveryOperation(operation: RecoveryOperation): string { return canonicalDescriptor(validate(operation, true)); }

export function decodeRecoveryOperation(encoded: string): RecoveryOperation {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new Error('recovery_operation_invalid_json');
  let value: unknown; try { value = JSON.parse(encoded); } catch { throw new Error('recovery_operation_invalid_json'); }
  const operation = validate(value as RecoveryOperation, true);
  if (encoded !== canonicalDescriptor(operation)) throw new Error('recovery_operation_noncanonical_json');
  return operation;
}

/** Derives resume bounds from the persisted absolute deadline; it cannot renew the operation. */
export function remainingRecoveryBudget(operation: RecoveryOperation, nowMs: number, runtime: RecoveryRuntimeBounds = {}): RecoveryBudget {
  const saved = validate(operation, true);
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('recovery_operation_invalid_runtime_bounds');
  exactKeys(runtime as unknown as Record<string, unknown>, ['maxAdditionalCalls', 'maxAttemptsPerCell', 'expiresAtMs'].filter(key => Object.hasOwn(runtime, key)), 'recovery_operation_unknown_runtime_field');
  safeInteger(nowMs, 'recovery_operation_invalid_now', 0);
  if (nowMs < saved.startedAtMs) throw new Error('recovery_operation_clock_before_start');
  const maxAdditionalCalls = runtime.maxAdditionalCalls === undefined ? saved.maxAdditionalCalls : runtime.maxAdditionalCalls;
  const maxAttemptsPerCell = runtime.maxAttemptsPerCell === undefined ? saved.maxAttemptsPerCell : runtime.maxAttemptsPerCell;
  const expiresAtMs = runtime.expiresAtMs === undefined ? saved.expiresAtMs : runtime.expiresAtMs;
  safeInteger(maxAdditionalCalls, 'recovery_operation_invalid_runtime_cap', 0, MAX_LIMIT);
  safeInteger(maxAttemptsPerCell, 'recovery_operation_invalid_runtime_cap', 1, MAX_LIMIT);
  safeInteger(expiresAtMs, 'recovery_operation_invalid_runtime_deadline', saved.startedAtMs);
  if (maxAdditionalCalls > saved.maxAdditionalCalls || maxAttemptsPerCell > saved.maxAttemptsPerCell) throw new Error('recovery_operation_runtime_cap_raise');
  if (expiresAtMs > saved.expiresAtMs) throw new Error('recovery_operation_runtime_deadline_extend');
  return { remainingMs: Math.max(0, expiresAtMs - nowMs), maxAdditionalCalls, maxAttemptsPerCell, expiresAtMs };
}
