type EnvVarStatus = 'set' | 'empty' | 'missing';

type EnvVarDefinition = {
  name: string;
  description: string;
};

const ENVIRONMENT_VARIABLES: EnvVarDefinition[] = [
  {
    name: 'ANTHROPIC_API_KEY',
    description: 'API key for Anthropic/Claude models.',
  },
  {
    name: 'OPENAI_API_KEY',
    description: 'API key for OpenAI models.',
  },
  {
    name: 'GOOGLE_API_KEY',
    description: 'Preferred API key for Google Gemini models.',
  },
  {
    name: 'GEMINI_API_KEY',
    description: 'Fallback alias for Gemini if GOOGLE_API_KEY is not set.',
  },
  {
    name: 'OPENAI_COMPAT_API_KEY',
    description: 'API key for OpenAI-compatible endpoints; defaults to "local".',
  },
  {
    name: 'OPENAI_COMPAT_BASE_URL',
    description: 'Base URL for OpenAI-compatible endpoints; defaults to http://localhost:11434/v1.',
  },
  {
    name: 'GITHUB_TOKEN',
    description: 'GitHub token for fetching PR diffs and posting reviews.',
  },
  {
    name: 'RCL_DEBUG',
    description: 'Set to print full error stack traces.',
  },
];

export function getEnvVarStatus(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): EnvVarStatus {
  const value = env[name];
  if (value === undefined) return 'missing';
  if (value.length === 0) return 'empty';
  return 'set';
}

function formatStatusLabel(status: EnvVarStatus): string {
  if (status === 'set') return '[set]';
  if (status === 'empty') return '[empty]';
  return '[missing]';
}

export function formatEnvironmentHelp(env: NodeJS.ProcessEnv = process.env): string {
  const nameWidth = Math.max(...ENVIRONMENT_VARIABLES.map((entry) => entry.name.length));
  const statusWidth = '[missing]'.length;
  const lines = [
    '',
    'Environment Variables:',
    '  Status reflects the current shell environment. Variables are only needed when the matching provider or feature is used.',
    '',
  ];

  for (const entry of ENVIRONMENT_VARIABLES) {
    const status = formatStatusLabel(getEnvVarStatus(entry.name, env));
    const paddedName = entry.name.padEnd(nameWidth);
    const paddedStatus = status.padEnd(statusWidth);
    lines.push(`  ${paddedName}  ${paddedStatus}  ${entry.description}`);
  }

  return lines.join('\n');
}
