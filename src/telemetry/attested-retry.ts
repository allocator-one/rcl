/**
 * The bounded in-workflow recovery for an attested envelope whose POST may
 * have reached Harness after its acknowledgement was lost. Callers supply
 * only the original serialized payload: this module never creates a run,
 * rebuilds an envelope, or invokes a reviewer.
 */

import { abortSignalWithTimeout } from './abort-signal.js';

export const ATTESTED_DELIVERY_MAX_ATTEMPTS = 3;
export const ATTESTED_DELIVERY_DEADLINE_MS = 20_000;
export const ATTESTED_DELIVERY_RETRY_PAUSE_MS = 250;

export type DeliveryAttempt<TRecorded = undefined, TDisabled = never> =
  | { kind: 'recorded'; value?: TRecorded }
  | { kind: 'unavailable' }
  | { kind: 'conflict' }
  | { kind: 'disabled'; value: TDisabled }
  | { kind: 'rejected' };

/** A receipt read is the authorization boundary for an idempotent replay. */
export type ReceiptProbe<T = undefined> = { kind: 'recorded'; value?: T } | { kind: 'absent' } | { kind: 'unavailable' } | { kind: 'rejected' };

interface RecoveryOutcomeCommon {
  attempts: number;
  recovered: boolean;
}

type TerminalRecoveryKind =
  | 'conflict'
  | 'rejected'
  | 'receipt_unavailable'
  | 'receipt_rejected'
  | 'operation_failed'
  | 'expired'
  | 'cancelled'
  | 'deadline_exceeded'
  | 'attempts_exhausted';

type RecordedRecoveryOutcome<TRecorded> = RecoveryOutcomeCommon & { kind: 'recorded'; value?: TRecorded };
type DisabledRecoveryOutcome<TDisabled> = RecoveryOutcomeCommon & { kind: 'disabled'; value: TDisabled };
type TerminalRecoveryOutcome = RecoveryOutcomeCommon & { kind: TerminalRecoveryKind };

export type AttestedRecoveryOutcome<TRecorded = undefined, TDisabled = never> =
  | RecordedRecoveryOutcome<TRecorded>
  | DisabledRecoveryOutcome<TDisabled>
  | TerminalRecoveryOutcome;

export interface AttestedRecoveryOptions<TRecorded = undefined, TDisabled = never> {
  runId: string;
  /** The pre-serialized original envelope. It is passed through byte-for-byte. */
  payload: string;
  expiresAt: string;
  post: (payload: string, signal: AbortSignal) => Promise<DeliveryAttempt<TRecorded, TDisabled>>;
  /** Must read only the credential-bound run and validate a matching receipt. */
  receipt: (runId: string, signal: AbortSignal) => Promise<ReceiptProbe<TRecorded>>;
  /** Epoch clock used only for the credential's absolute expiry. */
  now?: () => number;
  /** Monotonic clock used for the finite elapsed delivery budget. */
  monotonicNow?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  maxAttempts?: number;
  deadlineMs?: number;
  /** A POST already became unavailable; prove absence before another POST. */
  receiptFirst?: boolean;
  /** Number of already-issued POSTs that count against the finite budget. */
  initialAttempts?: number;
}

/**
 * A finite receipt-first retry loop. A transient POST is never replayed until
 * a successful own-run receipt lookup proves the server has not recorded it.
 */
export async function recoverAttestedDelivery<TRecorded = undefined, TDisabled = never>(
  options: AttestedRecoveryOptions<TRecorded, TDisabled>
): Promise<AttestedRecoveryOutcome<TRecorded, TDisabled>> {
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleep ?? abortableSleep;
  const maxAttempts = cappedOverride(options.maxAttempts, ATTESTED_DELIVERY_MAX_ATTEMPTS, 'maxAttempts', 1);
  const deadlineMs = cappedOverride(options.deadlineMs, ATTESTED_DELIVERY_DEADLINE_MS, 'deadlineMs', 1);
  const expiresAt = Date.parse(options.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new RangeError('expiresAt must be a valid ISO timestamp');
  const startedAt = monotonicNow();
  const expiresInMs = expiresAt - now();
  const initialAttempts = options.initialAttempts ?? (options.receiptFirst ? 1 : 0);
  let attempts = Math.min(validOverride(initialAttempts, 'initialAttempts', 0), maxAttempts);

  const boundary = (): { remainingMs: number } | { stopped: TerminalRecoveryOutcome } => {
    if (options.signal?.aborted) return { stopped: terminalOutcome('cancelled', attempts) };
    const current = now();
    const elapsedMs = monotonicNow() - startedAt;
    if (current >= expiresAt || elapsedMs >= expiresInMs) return { stopped: terminalOutcome('expired', attempts) };
    if (elapsedMs >= deadlineMs) return { stopped: terminalOutcome('deadline_exceeded', attempts) };
    const remainingMs = Math.min(deadlineMs - elapsedMs, expiresInMs - elapsedMs);
    if (remainingMs <= 0) return { stopped: terminalOutcome(expiresInMs <= deadlineMs ? 'expired' : 'deadline_exceeded', attempts) };
    return { remainingMs };
  };

  const stopped = (): TerminalRecoveryOutcome | undefined => {
    const active = boundary();
    return 'stopped' in active ? active.stopped : undefined;
  };

  const failed = (error: unknown): TerminalRecoveryOutcome =>
    error instanceof ActiveOperationBoundaryError && error.kind === 'deadline_exceeded' && now() >= expiresAt
      ? terminalOutcome('expired', attempts)
      : failedOperation(error, attempts);

  if (options.receiptFirst) {
    const active = boundary();
    if ('stopped' in active) return active.stopped;
    let receipt: ReceiptProbe<TRecorded>;
    try {
      receipt = await withActiveSignal(options.signal, active.remainingMs,
        signal => options.receipt(options.runId, signal));
    } catch (error) {
      return failed(error);
    }
    const afterInitialReceipt = stopped();
    if (afterInitialReceipt) return afterInitialReceipt;
    if (receipt.kind === 'recorded') return recordedOutcome(attempts, true, receipt.value);
    if (receipt.kind === 'unavailable') return terminalOutcome('receipt_unavailable', attempts);
    if (receipt.kind === 'rejected') return terminalOutcome('receipt_rejected', attempts);
  }

  while (attempts < maxAttempts) {
    const active = boundary();
    if ('stopped' in active) return active.stopped;

    attempts++;
    let posted: DeliveryAttempt<TRecorded, TDisabled>;
    try {
      posted = await withActiveSignal(options.signal, active.remainingMs,
        signal => options.post(options.payload, signal));
    } catch (error) {
      return failed(error);
    }
    const afterPost = stopped();
    if (afterPost) return afterPost;
    if (posted.kind === 'recorded') return recordedOutcome(attempts, attempts > 1, posted.value);
    if (posted.kind === 'conflict') return terminalOutcome('conflict', attempts);
    if (posted.kind === 'disabled') return disabledOutcome(attempts, posted.value);
    if (posted.kind === 'rejected') return terminalOutcome('rejected', attempts);
    const receiptActive = boundary();
    if ('stopped' in receiptActive) return receiptActive.stopped;
    let receipt: ReceiptProbe<TRecorded>;
    try {
      receipt = await withActiveSignal(options.signal, receiptActive.remainingMs,
        signal => options.receipt(options.runId, signal));
    } catch (error) {
      return failed(error);
    }
    const afterReceipt = stopped();
    if (afterReceipt) return afterReceipt;
    if (receipt.kind === 'recorded') return recordedOutcome(attempts, true, receipt.value);
    if (receipt.kind === 'unavailable') return terminalOutcome('receipt_unavailable', attempts);
    if (receipt.kind === 'rejected') return terminalOutcome('receipt_rejected', attempts);

    if (attempts === maxAttempts) break;
    const beforePause = stopped();
    if (beforePause) return beforePause;
    const pauseActive = boundary();
    if ('stopped' in pauseActive) return pauseActive.stopped;
    try {
      await withActiveSignal(options.signal, pauseActive.remainingMs,
        signal => sleep(ATTESTED_DELIVERY_RETRY_PAUSE_MS, signal));
    } catch (error) {
      return failed(error);
    }
  }
  return terminalOutcome('attempts_exhausted', attempts);
}

function validOverride(value: number | undefined, field: string, minimum: number): number {
  if (value === undefined) return minimum;
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${field} must be a ${minimum === 0 ? 'nonnegative' : 'positive'} safe integer`);
  return value;
}

function cappedOverride(value: number | undefined, ceiling: number, field: string, minimum: number): number {
  return value === undefined ? ceiling : Math.min(validOverride(value, field, minimum), ceiling);
}

function recordedOutcome<TRecorded>(attempts: number, recovered: boolean, value?: TRecorded): RecordedRecoveryOutcome<TRecorded> {
  return { kind: 'recorded', attempts, recovered, ...(value === undefined ? {} : { value }) };
}

function disabledOutcome<TDisabled>(attempts: number, value: TDisabled): DisabledRecoveryOutcome<TDisabled> {
  return { kind: 'disabled', attempts, recovered: false, value };
}

function terminalOutcome(kind: TerminalRecoveryKind, attempts: number): TerminalRecoveryOutcome {
  return { kind, attempts, recovered: false };
}

function failedOperation(error: unknown, attempts: number): TerminalRecoveryOutcome {
  return terminalOutcome(error instanceof ActiveOperationBoundaryError ? error.kind : 'operation_failed', attempts);
}

class ActiveOperationBoundaryError extends Error {
  constructor(readonly kind: 'cancelled' | 'deadline_exceeded') {
    super(kind);
  }
}

/** Bound one in-flight operation and release its timer/listener when it settles. */
async function withActiveSignal<T>(parent: AbortSignal | undefined, remainingMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const lease = abortSignalWithTimeout(parent, remainingMs);
  try {
    return await operation(lease.signal);
  } catch (error) {
    if (lease.signal.aborted && isAbortFailure(error, lease.signal)) {
      const cancelled = parent?.aborted === true && Object.is(lease.signal.reason, parent.reason);
      throw new ActiveOperationBoundaryError(cancelled ? 'cancelled' : 'deadline_exceeded');
    }
    throw error;
  } finally {
    lease.dispose();
  }
}

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return Object.is(error, signal.reason) || error instanceof DOMException && error.name === 'AbortError';
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
