import { setTimeout as delay } from 'node:timers/promises';

/** Time is injectable for quota tests; production always uses monotonic elapsed time. */
export interface RecoveryClock {
  now: () => number;
  wallTime: () => number;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const systemClock: RecoveryClock = {
  now: () => performance.now(), wallTime: () => Date.now(),
  sleep: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};
const WINDOW_MS = 60_000;
// Leave room in the unchanged 300/minute token bucket for other callers.
const REQUESTS_PER_WINDOW = 240;
const MAX_RATE_LIMIT_WAITS = 3;
const permitBrand = Symbol('recovery write permit');
export interface RecoveryWritePermit { readonly [permitBrand]: true }
export interface RecoveryRateLimit {
  retryAfterMs?: number;
  retryable: boolean;
  reason: 'rate_limited' | 'invalid_retry_after' | 'rate_limit_allowance_exhausted';
}

/** One authenticated recovery operation; transport permits confer no evidence authority. */
export class RecoveryRequestBudget {
  private readonly clock: RecoveryClock;
  private starts: number[] = [];
  private readonly reserved = new Set<RecoveryWritePermit>();
  private blockedUntil = 0;
  private blocked: string | undefined;
  private rateLimitWaits = 0;
  private lastNow = -Infinity;

  constructor(clock: RecoveryClock = systemClock, private readonly onWait?: (milliseconds: number) => void) {
    this.clock = { ...clock };
  }

  private now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now) || now < this.lastNow) throw new Error('recovery_clock_invalid');
    this.lastNow = now;
    this.starts = this.starts.filter(start => now - start < WINDOW_MS);
    return now;
  }

  private async admit(reserve: boolean, signal?: AbortSignal): Promise<RecoveryWritePermit | undefined> {
    for (;;) {
      signal?.throwIfAborted();
      if (this.blocked) throw new Error(this.blocked);
      const now = this.now();
      const quotaWait = this.starts.length + this.reserved.size >= REQUESTS_PER_WINDOW
        ? Math.max(1, (this.starts[0] ?? now) + WINDOW_MS - now) : 0;
      const wait = Math.max(0, this.blockedUntil - now, quotaWait);
      if (!wait) {
        if (!reserve) { this.starts.push(now); return; }
        const permit: RecoveryWritePermit = Object.freeze({ [permitBrand]: true as const });
        this.reserved.add(permit);
        return permit;
      }
      this.onWait?.(wait);
      await this.clock.sleep(wait, signal);
    }
  }

  /** Admission precedes creation of the per-request network timeout. */
  async acquire(signal?: AbortSignal): Promise<void> {
    await this.admit(false, signal);
  }

  /** Reserve before final source validation; proof reads cannot consume this slot. */
  async reserveWrite(): Promise<RecoveryWritePermit> {
    return (await this.admit(true))!;
  }

  /** No scheduling wait is permitted between successful source proof and this write. */
  consumeWrite(permit: RecoveryWritePermit): void {
    const now = this.now();
    if (!this.reserved.has(permit)) throw new Error('recovery_write_permit_invalid');
    if (this.blocked || now < this.blockedUntil) throw new Error(this.blocked ?? 'recovery_write_rate_limited');
    this.reserved.delete(permit);
    this.starts.push(now);
  }

  releaseWrite(permit: RecoveryWritePermit): void { this.reserved.delete(permit); }

  /** Only actual 429s consume the finite contention allowance; normal pacing is unbounded. */
  rateLimited(retryAfter: string | null, responseDate: string | null): RecoveryRateLimit {
    let milliseconds: number | undefined;
    if (retryAfter !== null && /^\d+$/.test(retryAfter)) {
      const seconds = Number(retryAfter);
      if (Number.isSafeInteger(seconds)) milliseconds = seconds * 1000;
    } else if (retryAfter !== null && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)) {
      const parsedDate = Date.parse(retryAfter);
      const date = Number.isFinite(parsedDate) && new Date(parsedDate).toUTCString() === retryAfter ? parsedDate : NaN;
      const serverTime = responseDate === null ? NaN : Date.parse(responseDate);
      milliseconds = date - (Number.isFinite(serverTime) ? serverTime : this.clock.wallTime());
    }
    if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > WINDOW_MS) {
      this.blocked = 'recovery_retry_after_invalid';
      return { retryable: false, reason: 'invalid_retry_after' };
    }
    // Even Retry-After: 0 must not spin against a competing caller's bucket.
    milliseconds = Math.max(1000, milliseconds);
    if (++this.rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
      this.blocked = 'recovery_rate_limit_allowance_exhausted';
      return { retryable: false, reason: 'rate_limit_allowance_exhausted', retryAfterMs: milliseconds };
    }
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + milliseconds);
    return { retryable: true, reason: 'rate_limited', retryAfterMs: milliseconds };
  }
}
