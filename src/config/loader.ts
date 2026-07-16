import { cosmiconfig } from 'cosmiconfig';
import { ConfigSchema, type Config } from './schema.js';
import {
  DEFAULT_MODELS,
  DEFAULT_SECONDARY_MODELS,
  DEFAULT_THRESHOLDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_CONCURRENCY,
} from './defaults.js';

/**
 * A config file was found but could not be used. Never silently recover
 * from this: falling back to defaults would send code to cloud providers
 * the user may have explicitly configured away from.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Declarative formats only. Executable config (.js/.cjs) is deliberately
// unsupported for discovery: rcl is routinely run inside untrusted
// checkouts, and search-loading attacker-controlled JS would execute it
// with the user's API keys in env.
const SEARCH_PLACES = [
  '.review-council.yml',
  '.review-council.yaml',
  '.review-council.json',
];

export async function loadConfig(configPath?: string, searchFrom?: string): Promise<Config> {
  const cwd = searchFrom ?? process.cwd();
  const explorer = cosmiconfig('review-council', {
    searchPlaces: SEARCH_PLACES,
    // No parent-directory walk: only the directory rcl runs from.
    stopDir: cwd,
  });

  let result;
  try {
    result = configPath
      ? await explorer.load(configPath)
      : await explorer.search(cwd);
  } catch (err) {
    const source = configPath ?? 'discovered config';
    throw new ConfigError(`Failed to load config from ${source}: ${String(err)}`);
  }

  if (!result || result.isEmpty) {
    return buildDefaultConfig();
  }

  const parsed = ConfigSchema.safeParse(result.config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config at ${result.filepath}:\n${issues}`);
  }

  return mergeWithDefaults(parsed.data);
}

function buildDefaultConfig(): Config {
  return {
    models: [...DEFAULT_MODELS],
    secondaryModels: [...DEFAULT_SECONDARY_MODELS],
    thresholds: { ...DEFAULT_THRESHOLDS },
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    concurrency: DEFAULT_CONCURRENCY,
  };
}

function mergeWithDefaults(config: Config): Config {
  return {
    models: config.models ?? [...DEFAULT_MODELS],
    secondaryModels: config.secondaryModels ?? (config.models ? [] : [...DEFAULT_SECONDARY_MODELS]),
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
