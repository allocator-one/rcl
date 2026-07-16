const KNOWN_PROVIDER_PREFIXES = ['anthropic/', 'openai/', 'google/', 'openai-compat/'] as const;

/**
 * Strip a known provider prefix from a model name.
 * Only removes anthropic/, openai/, google/, or openai-compat/ prefixes.
 * Returns the model name unchanged if no known prefix is found.
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
