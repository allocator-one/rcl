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
