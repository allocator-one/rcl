import { DEFAULT_PROVIDER_CONCURRENCY } from './defaults.js';
import type { Config } from './schema.js';

export type ProviderConcurrency = NonNullable<Config['providerConcurrency']>;

/** Version-owned defaults plus source-bound project overrides. */
export function resolveProviderConcurrency(
  configured?: Readonly<ProviderConcurrency>
): ProviderConcurrency {
  return { ...DEFAULT_PROVIDER_CONCURRENCY, ...configured };
}
