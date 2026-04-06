const KNOWN_PROVIDER_PREFIXES = ['anthropic/', 'openai/', 'google/'] as const;

/**
 * Strip a known provider prefix from a model name.
 * Only removes anthropic/, openai/, or google/ prefixes.
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
