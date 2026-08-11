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
    // 'none' searches only the starting directory — no parent-directory walk
    // and no global (~/.config) dir, which would otherwise be probed with
    // cosmiconfig's default executable-config loaders. (stopDir is rejected
    // alongside a non-'global' strategy, and is unnecessary here.)
    searchStrategy: 'none',
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

/**
 * The default fleet includes openrouter/ models. When OPENROUTER_API_KEY is
 * absent those voters would fail on every run (the runner refuses to fall
 * back to OPENAI_API_KEY), silently breaking upgrades from pre-OpenRouter
 * versions whose users only hold the big-three keys. Defaults therefore
 * degrade gracefully: openrouter/ entries are dropped with a warning.
 * Models the user configured explicitly are never filtered — those still
 * fail loudly per review.
 */
function dropOpenRouterDefaultsWithoutKey(
  models: readonly string[],
  listName: string
): string[] {
  if (process.env['OPENROUTER_API_KEY']?.trim()) return [...models];
  const kept = models.filter((m) => !m.startsWith('openrouter/'));
  const dropped = models.length - kept.length;
  if (dropped > 0) {
    // Name the resulting fleet, not just the count: the default secondary
    // list is entirely openrouter/, so without the key it degrades to
    // empty and every specialist role falls back to the primary models.
    const remaining = kept.length > 0 ? kept.join(', ') : '(none)';
    console.warn(
      `OPENROUTER_API_KEY is not set — dropping ${dropped} openrouter/ model(s) from the default ${listName}; remaining: ${remaining}. Set the key to run the full default fleet.`
    );
  }
  return kept;
}

function buildDefaultConfig(): Config {
  return {
    models: dropOpenRouterDefaultsWithoutKey(DEFAULT_MODELS, 'models'),
    secondaryModels: dropOpenRouterDefaultsWithoutKey(DEFAULT_SECONDARY_MODELS, 'secondary models'),
    thresholds: { ...DEFAULT_THRESHOLDS },
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
    concurrency: DEFAULT_CONCURRENCY,
  };
}

function mergeWithDefaults(config: Config): Config {
  return {
    models: config.models ?? dropOpenRouterDefaultsWithoutKey(DEFAULT_MODELS, 'models'),
    secondaryModels:
      config.secondaryModels ??
      (config.models
        ? []
        : dropOpenRouterDefaultsWithoutKey(DEFAULT_SECONDARY_MODELS, 'secondary models')),
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
