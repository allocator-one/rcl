import { MAX_TIMER_DELAY_MS } from '../config/schema.js';
import { stableStringify } from '../report/run-header.js';
import { UUID } from '../telemetry/recovery/source.js';

const VERSION = 1;
const MAX_LIMIT = 1_000_000;
const MAX_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface OriginalLaunchInput {
  runId: string;
  target: string;
  originalNativeClaim: { attempt: number; round: number };
  capturedInputsSha256: string;
  planDigest: string;
  startedAtMs: number;
  expiresAtMs: number;
  maxPhysicalCalls: number;
  maxAttemptsPerCell: number;
}
export interface OriginalLaunch extends OriginalLaunchInput { version: 1 }
export interface OriginalRuntimeBounds {
  maxPhysicalCalls?: number;
  maxAttemptsPerCell?: number;
  expiresAtMs?: number;
}
export interface OriginalBudget {
  remainingMs: number;
  maxPhysicalCalls: number;
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
function exactKeys(value: Record<string, unknown>, expected: readonly string[], error: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new Error(error);
}
function integer(value: unknown, error: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(error);
}
function digest(value: unknown, error: string): asserts value is string { if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(error); }
function target(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 512 || !value.trim() || /[\0\r\n]/.test(value)) throw new Error('original_launch_invalid_target');
}
function runId(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) throw new Error('original_launch_invalid_run_id'); }

function validate(input: OriginalLaunchInput | OriginalLaunch, withVersion: boolean): OriginalLaunch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('original_launch_invalid_document');
  exactKeys(input as unknown as Record<string, unknown>, withVersion
    ? ['version', 'runId', 'target', 'originalNativeClaim', 'capturedInputsSha256', 'planDigest', 'startedAtMs', 'expiresAtMs', 'maxPhysicalCalls', 'maxAttemptsPerCell']
    : ['runId', 'target', 'originalNativeClaim', 'capturedInputsSha256', 'planDigest', 'startedAtMs', 'expiresAtMs', 'maxPhysicalCalls', 'maxAttemptsPerCell'], 'original_launch_invalid_document');
  if (withVersion && (input as OriginalLaunch).version !== VERSION) throw new Error('original_launch_invalid_document');
  runId(input.runId); target(input.target);
  digest(input.capturedInputsSha256, 'original_launch_invalid_captured_inputs_sha256');
  digest(input.planDigest, 'original_launch_invalid_plan_digest');
  const claim = input.originalNativeClaim;
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error('original_launch_invalid_native_claim');
  exactKeys(claim as Record<string, unknown>, ['attempt', 'round'], 'original_launch_invalid_native_claim');
  integer(claim.attempt, 'original_launch_invalid_native_attempt', 1, MAX_LIMIT);
  integer(claim.round, 'original_launch_invalid_native_round', 1, MAX_LIMIT);
  integer(input.startedAtMs, 'original_launch_invalid_started_at', 0);
  integer(input.expiresAtMs, 'original_launch_invalid_deadline', 0);
  if (input.expiresAtMs < input.startedAtMs || input.expiresAtMs - input.startedAtMs > MAX_TIMER_DELAY_MS) throw new Error('original_launch_invalid_deadline');
  integer(input.maxPhysicalCalls, 'original_launch_invalid_max_physical_calls', 1, MAX_LIMIT);
  integer(input.maxAttemptsPerCell, 'original_launch_invalid_max_attempts_per_cell', 1, MAX_LIMIT);
  return deepFreeze({ version: VERSION, runId: input.runId, target: input.target,
    originalNativeClaim: { attempt: claim.attempt, round: claim.round }, capturedInputsSha256: input.capturedInputsSha256,
    planDigest: input.planDigest, startedAtMs: input.startedAtMs, expiresAtMs: input.expiresAtMs,
    maxPhysicalCalls: input.maxPhysicalCalls, maxAttemptsPerCell: input.maxAttemptsPerCell });
}
function canonical(launch: OriginalLaunch): string {
  const bytes = stableStringify(launch);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) throw new Error('original_launch_too_large');
  return bytes;
}

/** Creates a local original-launch descriptor; it does not establish native, provider, or server authority. */
export function createOriginalLaunch(input: OriginalLaunchInput): OriginalLaunch {
  const launch = validate(input, false);
  canonical(launch);
  return launch;
}
export function encodeOriginalLaunch(value: OriginalLaunch): string { return canonical(validate(value, true)); }
export function decodeOriginalLaunch(bytes: string): OriginalLaunch {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) throw new Error('original_launch_invalid_document');
  let value: unknown; try { value = JSON.parse(bytes); } catch { throw new Error('original_launch_invalid_document'); }
  const launch = validate(value as OriginalLaunch, true);
  if (bytes !== canonical(launch)) throw new Error('original_launch_noncanonical');
  return launch;
}

/** Resume derives time only from the persisted absolute deadline; runtime may tighten but never raise it. */
export function remainingOriginalBudget(value: OriginalLaunch, nowMs: number, runtime: OriginalRuntimeBounds = {}): OriginalBudget {
  const launch = validate(value, true);
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('original_launch_invalid_runtime_bounds');
  exactKeys(runtime as unknown as Record<string, unknown>, ['maxPhysicalCalls', 'maxAttemptsPerCell', 'expiresAtMs'].filter(key => Object.hasOwn(runtime, key)), 'original_launch_invalid_runtime_bounds');
  integer(nowMs, 'original_launch_invalid_now', 0);
  if (nowMs < launch.startedAtMs) throw new Error('original_launch_clock_before_start');
  const maxPhysicalCalls = runtime.maxPhysicalCalls === undefined ? launch.maxPhysicalCalls : runtime.maxPhysicalCalls;
  const maxAttemptsPerCell = runtime.maxAttemptsPerCell === undefined ? launch.maxAttemptsPerCell : runtime.maxAttemptsPerCell;
  const expiresAtMs = runtime.expiresAtMs === undefined ? launch.expiresAtMs : runtime.expiresAtMs;
  integer(maxPhysicalCalls, 'original_launch_invalid_runtime_cap', 0, MAX_LIMIT);
  integer(maxAttemptsPerCell, 'original_launch_invalid_runtime_cap', 1, MAX_LIMIT);
  integer(expiresAtMs, 'original_launch_invalid_runtime_deadline', launch.startedAtMs);
  if (maxPhysicalCalls > launch.maxPhysicalCalls || maxAttemptsPerCell > launch.maxAttemptsPerCell) throw new Error('original_launch_runtime_cap_raise');
  if (expiresAtMs > launch.expiresAtMs) throw new Error('original_launch_runtime_deadline_extend');
  return { remainingMs: Math.max(0, expiresAtMs - nowMs), maxPhysicalCalls, maxAttemptsPerCell, expiresAtMs };
}
