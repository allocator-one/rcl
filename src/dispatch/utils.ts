import type { ParseResult } from '../consensus/parser.js';
import type { ModelReview } from '../consensus/types.js';

const KNOWN_PROVIDER_PREFIXES = [
  'anthropic/',
  'openai/',
  'google/',
  'openrouter/',
  'openai-compat/',
] as const;

/**
 * Strip a known provider prefix from a model name.
 * Only removes anthropic/, openai/, google/, openrouter/, or openai-compat/
 * prefixes. Returns the model name unchanged if no known prefix is found.
 * Note: openrouter/ models keep their vendor segment — stripping
 * "openrouter/moonshotai/kimi-k3" yields "moonshotai/kimi-k3", which is the
 * model id OpenRouter expects on the wire.
 */
export function stripKnownProviderPrefix(model: string): string {
  for (const prefix of KNOWN_PROVIDER_PREFIXES) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

/**
 * A completed HTTP call that produced no reviewable output is a FAILED
 * review, not a clean one. Providers decline requests in-band — Claude
 * answers 200 with `stop_reason: "refusal"`, OpenAI-compatible endpoints
 * with `finish_reason: "content_filter"` — and refusals cluster on exactly
 * the security-relevant diffs a council is most valuable for.
 *
 * Reporting those as `success` with zero findings is worse than losing the
 * reviewer: the run still counts it toward `successfulReviews` (so the CI
 * "nothing was reviewed" guard stays quiet), and consensus counts it as a
 * relevant reviewer that looked and found nothing — which *lowers* the
 * confidence of a real finding the other models did catch.
 */
export function failedReview(opts: {
  model: string;
  role: string;
  provider: string;
  startedAt: number;
  error: string;
  status?: 'error' | 'timeout';
}): ModelReview {
  return {
    model: opts.model,
    role: opts.role,
    provider: opts.provider,
    findings: [],
    durationMs: Date.now() - opts.startedAt,
    status: opts.status ?? 'error',
    error: opts.error,
  };
}

/**
 * The provider-agnostic backstop: a 200 with an empty body reviewed nothing.
 * Catches refusal shapes we don't yet enumerate, and plain provider hiccups,
 * without each adapter having to guess why the body was empty.
 */
export function isBlankOutput(rawOutput: string): boolean {
  return rawOutput.trim().length === 0;
}

/**
 * Turn a parsed response into a ModelReview, shared by every adapter so the
 * degraded cases are classified the same way everywhere.
 *
 * The case that matters: the model answered, but every finding it produced
 * failed schema validation. `findings: []` with `dropped > 0` is NOT a clean
 * review — reporting it as one silently drops a whole reviewer (and, in a
 * council, a whole role) while the report claims the round was complete.
 * Warnings ride along so a consumer reading the JSON can see degraded
 * coverage without scraping stdout, which the skills explicitly tell people
 * not to read.
 */
export function reviewFromParse(opts: {
  model: string;
  role: string;
  provider: string;
  startedAt: number;
  parsed: ParseResult;
}): ModelReview {
  const { findings, warnings, dropped, unusable } = opts.parsed;
  const base = {
    model: opts.model,
    role: opts.role,
    provider: opts.provider,
    findings,
    durationMs: Date.now() - opts.startedAt,
    ...(dropped > 0 ? { droppedFindings: dropped } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  // Gate on the parser's explicit verdict, not on the dropped counter: the
  // counter only moves inside the salvage loop, which never runs when the
  // response has no findings array at all — so a truncated or prose-only
  // answer used to fall through to `success` (RCL-15).
  if (unusable) {
    return {
      ...base,
      status: 'parse_failed',
      error:
        dropped > 0
          ? `All ${dropped} finding(s) failed schema validation; this reviewer's output was lost`
          : "Response was not a usable review; this reviewer's output was lost",
    };
  }

  return { ...base, status: 'success' };
}

export const RETRY_DELAYS = [1000, 2000, 4000] as const;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/**
 * Whether an HTTP status from a provider API warrants a retry.
 * Covers rate limits (429), transient server errors (500/502/503/504),
 * and Anthropic's overloaded_error (529).
 */
export function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

export function retryDelay(attempt: number): number {
  return RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1]!;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type AttemptOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; timedOut: boolean; error: string };

/**
 * Shared timeout-owning retry skeleton for one-off adapter calls (discuss).
 * The AbortController is the sole owner of timeout classification — the
 * caller's SDK timeout must be set above `timeoutMs` (same convention as the
 * review paths).
 */
export async function attemptWithRetries<T>(opts: {
  timeoutMs: number;
  maxRetries: number;
  isRetryable: (err: unknown) => boolean;
  attempt: (signal: AbortSignal) => Promise<T>;
}): Promise<AttemptOutcome<T>> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), opts.timeoutMs);
  let lastErr: unknown = new Error('no attempts made');

  try {
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      try {
        return { ok: true, value: await opts.attempt(controller.signal) };
      } catch (err) {
        lastErr = err;
        if (controller.signal.aborted) {
          return { ok: false, timedOut: true, error: 'Request timed out' };
        }
        if (opts.isRetryable(err) && attempt < opts.maxRetries) {
          await sleep(retryDelay(attempt));
          continue;
        }
        break;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  const error = lastErr instanceof Error ? `${lastErr.name}: ${lastErr.message}` : String(lastErr);
  return { ok: false, timedOut: false, error };
}
