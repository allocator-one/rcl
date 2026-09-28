export const MODEL_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'openai-compat',
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_PROVIDER_SET: ReadonlySet<string> = new Set(MODEL_PROVIDERS);
