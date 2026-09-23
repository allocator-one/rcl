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

export type DeliveryAttempt<T = undefined> =
  | { kind: 'recorded'; value?: T }
  | { kind: 'unavailable' }
  | { kind: 'conflict' }
  | { kind: 'rejected' };

/** A receipt read is the authorization boundary for an idempotent replay. */
export type ReceiptProbe<T = undefined> = { kind: 'recorded'; value?: T } | { kind: 'absent' } | { kind: 'unavailable' } | { kind: 'rejected' };

export type AttestedRecoveryOutcome<T = undefined> = {
  kind: 'recorded' | 'conflict' | 'rejected' | 'receipt_unavailable' | 'receipt_rejected' | 'expired' | 'cancelled' | 'deadline_exceeded' | 'attempts_exhausted';
  attempts: number;
  recovered: boolean;
  value?: T;
};

export interface AttestedRecoveryOptions<T = undefined> {
  runId: string;
  /** The pre-serialized original envelope. It is passed through byte-for-byte. */
  payload: string;
  expiresAt: string;
  post: (payload: string, signal: AbortSignal) => Promise<DeliveryAttempt<T>>;
  /** Must read only the credential-bound run and validate a matching receipt. */
  receipt: (runId: string, signal: AbortSignal) => Promise<ReceiptProbe<T>>;
  now?: () => number;
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
export async function recoverAttestedDelivery<T = undefined>(options: AttestedRecoveryOptions<T>): Promise<AttestedRecoveryOutcome<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const maxAttempts = validBound(options.maxAttempts, ATTESTED_DELIVERY_MAX_ATTEMPTS);
  const deadlineMs = validBound(options.deadlineMs, ATTESTED_DELIVERY_DEADLINE_MS);
  const expiresAt = Date.parse(options.expiresAt);
  const startedAt = now();
  let attempts = Math.min(validBound(options.initialAttempts, 0), maxAttempts);

  const boundary = (): { remainingMs: number } | { stopped: AttestedRecoveryOutcome<T> } => {
    if (options.signal?.aborted) return { stopped: outcome('cancelled', attempts) };
    const current = now();
    if (!Number.isFinite(expiresAt) || current >= expiresAt) return { stopped: outcome('expired', attempts) };
    const elapsedMs = current - startedAt;
    if (elapsedMs >= deadlineMs) return { stopped: outcome('deadline_exceeded', attempts) };
    const remainingMs = Math.min(deadlineMs - elapsedMs, expiresAt - current);
    if (remainingMs <= 0) return { stopped: outcome(expiresAt - current <= deadlineMs - elapsedMs ? 'expired' : 'deadline_exceeded', attempts) };
    return { remainingMs };
  };

  const stopped = (): AttestedRecoveryOutcome<T> | undefined => {
    const active = boundary();
    return 'stopped' in active ? active.stopped : undefined;
  };

  if (options.receiptFirst) {
    const active = boundary();
    if ('stopped' in active) return active.stopped;
    let receipt: ReceiptProbe<T>;
    try {
      receipt = await withActiveSignal(options.signal, active.remainingMs,
        signal => options.receipt(options.runId, signal));
    } catch {
      return stopped() ?? outcome('deadline_exceeded', attempts);
    }
    if (receipt.kind === 'recorded') return outcome('recorded', attempts, true, receipt.value);
    const afterInitialReceipt = stopped();
    if (afterInitialReceipt) return afterInitialReceipt;
    if (receipt.kind === 'unavailable') return outcome('receipt_unavailable', attempts);
    if (receipt.kind === 'rejected') return outcome('receipt_rejected', attempts);
  }

  while (attempts < maxAttempts) {
    const active = boundary();
    if ('stopped' in active) return active.stopped;

    attempts++;
    let posted: DeliveryAttempt<T>;
    try {
      posted = await withActiveSignal(options.signal, active.remainingMs,
        signal => options.post(options.payload, signal));
    } catch {
      return stopped() ?? outcome('deadline_exceeded', attempts);
    }
    if (posted.kind === 'recorded') return outcome('recorded', attempts, attempts > 1, posted.value);
    if (posted.kind === 'conflict') return outcome('conflict', attempts);
    if (posted.kind === 'rejected') return outcome('rejected', attempts);

    const afterPost = stopped();
    if (afterPost) return afterPost;
    const receiptActive = boundary();
    if ('stopped' in receiptActive) return receiptActive.stopped;
    let receipt: ReceiptProbe<T>;
    try {
      receipt = await withActiveSignal(options.signal, receiptActive.remainingMs,
        signal => options.receipt(options.runId, signal));
    } catch {
      return stopped() ?? outcome('deadline_exceeded', attempts);
    }
    if (receipt.kind === 'recorded') return outcome('recorded', attempts, true, receipt.value);
    const afterReceipt = stopped();
    if (afterReceipt) return afterReceipt;
    if (receipt.kind === 'unavailable') return outcome('receipt_unavailable', attempts);
    if (receipt.kind === 'rejected') return outcome('receipt_rejected', attempts);

    if (attempts === maxAttempts) break;
    const beforePause = stopped();
    if (beforePause) return beforePause;
    const pauseActive = boundary();
    if ('stopped' in pauseActive) return pauseActive.stopped;
    try {
      await withActiveSignal(options.signal, pauseActive.remainingMs,
        signal => sleep(ATTESTED_DELIVERY_RETRY_PAUSE_MS, signal));
    } catch {
      return stopped() ?? outcome('deadline_exceeded', attempts);
    }
  }
  return outcome('attempts_exhausted', attempts);
}

function validBound(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function outcome<T>(kind: AttestedRecoveryOutcome<T>['kind'], attempts: number, recovered = false, value?: T): AttestedRecoveryOutcome<T> {
  return { kind, attempts, recovered, ...(value === undefined ? {} : { value }) };
}

/** Bound one in-flight operation and release its timer/listener when it settles. */
async function withActiveSignal<T>(parent: AbortSignal | undefined, remainingMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const lease = abortSignalWithTimeout(parent, remainingMs);
  try {
    return await operation(lease.signal);
  } finally {
    lease.dispose();
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
