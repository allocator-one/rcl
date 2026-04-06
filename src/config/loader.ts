import { cosmiconfig } from 'cosmiconfig';
import { ConfigSchema, type Config } from './schema.js';
import {
  DEFAULT_MODELS,
  DEFAULT_THRESHOLDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_CONCURRENCY,
} from './defaults.js';

const explorer = cosmiconfig('review-council', {
  searchPlaces: [
    '.review-council.yml',
    '.review-council.yaml',
    '.review-council.json',
    '.review-council.js',
    '.review-council.cjs',
    'review-council.config.js',
    'review-council.config.cjs',
  ],
});

export async function loadConfig(configPath?: string): Promise<Config> {
  try {
    const result = configPath
      ? await explorer.load(configPath)
      : await explorer.search();

    if (!result || result.isEmpty) {
      return buildDefaultConfig();
    }

    const parsed = ConfigSchema.safeParse(result.config);
    if (!parsed.success) {
      console.warn('Warning: config validation errors:', parsed.error.format());
      return buildDefaultConfig();
    }

    return mergeWithDefaults(parsed.data);
  } catch (err) {
    if (configPath) {
      throw new Error(`Failed to load config from ${configPath}: ${String(err)}`);
    }
    return buildDefaultConfig();
  }
}

function buildDefaultConfig(): Config {
  return {
    models: [...DEFAULT_MODELS],
    thresholds: { ...DEFAULT_THRESHOLDS },
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    concurrency: DEFAULT_CONCURRENCY,
  };
}

function mergeWithDefaults(config: Config): Config {
  return {
    models: config.models ?? [...DEFAULT_MODELS],
    roles: config.roles,
    reviewers: config.reviewers,
    customRoles: config.customRoles,
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...config.thresholds,
    },
    output: config.output,
    timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
    githubToken: config.githubToken ?? process.env['GITHUB_TOKEN'],
    context: config.context,
    spec: config.spec,
    focus: config.focus,
  };
}
