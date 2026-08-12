import { accessSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, isAbsolute, join, parse } from 'path';

/**
 * Key distribution via Harness. When the repo under review carries a
 * committed `.harness-cli/config.json` (the "this repo belongs to the org"
 * signal, discovered git-style by walking up from the working directory)
 * and the user has run `harness login`, provider API keys missing from the
 * environment are fetched from the Harness backend
 * (GET /api/v1/model-keys) and injected into the process environment.
 *
 * Rules this module must never break:
 * - The environment always wins: only keys absent from the env are injected.
 * - The stored {url, token} credential pair is indivisible: the token is
 *   only ever sent to the host that minted it — NEVER to a URL named by the
 *   repo's own config, which is attacker-controlled input in a cloned repo.
 * - Every failure degrades silently to today's behavior (missing keys warn
 *   or fail exactly as before); the fetch runs under a short timeout so an
 *   offline machine never hangs a review.
 * - Keys land in the (injected) env only — never on disk, never in logs.
 */

/** Provider names the backend may serve, mapped to the env var rcl reads. */
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** Long enough for a healthy backend, short enough to never stall a review. */
const FETCH_TIMEOUT_MS = 3_000;

export interface HarnessKeyResult {
  /** Providers whose keys were injected into the env. */
  injected: string[];
  /** One human-readable line worth showing, when there is something to say. */
  note?: string;
}

export interface HarnessKeyOptions {
  cwd?: string;
  /** Injectable for tests; defaults to process.env and is MUTATED on inject. */
  env?: Record<string, string | undefined>;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
}

/** Walk up from `startDir` looking for `.harness-cli/config.json`. */
export function findHarnessRepoConfig(startDir: string): string | null {
  let dir = startDir;
  const { root } = parse(startDir);
  for (;;) {
    const candidate = join(dir, '.harness-cli', 'config.json');
    try {
      // Presence is the signal; the file's contents (team, url) are not
      // trusted for anything here.
      accessSync(candidate);
      return candidate;
    } catch {
      // keep walking
    }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/**
 * The credential `harness login` stores. The format is frozen on the
 * harness-cli side (exactly {url, token}) — see its core/credentials.ts.
 */
export function defaultCredentialsPath(env: Record<string, string | undefined>): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(homedir(), '.config');
  return join(base, 'harness', 'credentials.json');
}

async function readStoredCredentials(path: string): Promise<{ url: string; token: string } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const { url, token } = parsed as Record<string, unknown>;
      if (typeof url === 'string' && typeof token === 'string' && url !== '' && token !== '') {
        return { url: url.replace(/\/+$/, ''), token };
      }
    }
  } catch {
    // Missing or malformed reads as "not logged in".
  }
  return null;
}

async function fetchModelKeys(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch
): Promise<Record<string, string> | null> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/v1/model-keys`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const keys = (body as { data?: { keys?: unknown } })?.data?.keys;
    if (typeof keys !== 'object' || keys === null) return null;
    const out: Record<string, string> = {};
    for (const [provider, key] of Object.entries(keys)) {
      if (typeof key === 'string' && key !== '') out[provider] = key;
    }
    return out;
  } catch {
    // Timeout, offline, older backend without the endpoint — all read as
    // "no keys from Harness".
    return null;
  }
}

function missingProviders(env: Record<string, string | undefined>): string[] {
  const isSet = (name: string) => (env[name] ?? '').trim() !== '';
  return Object.entries(PROVIDER_ENV_VARS)
    .filter(([provider, envVar]) => {
      // The Google adapter reads either variable; respect both.
      if (provider === 'google' && isSet('GOOGLE_API_KEY')) return false;
      return !isSet(envVar);
    })
    .map(([provider]) => provider);
}

/**
 * The one entry point: called before config loading (default-model
 * degradation for a missing OPENROUTER_API_KEY happens there, so the key
 * must exist earlier). No-op unless keys are missing AND the repo opted in.
 */
export async function applyHarnessModelKeys(options: HarnessKeyOptions = {}): Promise<HarnessKeyResult> {
  const env = options.env ?? process.env;

  if ((env['RCL_NO_HARNESS_KEYS'] ?? '') !== '') return { injected: [] };

  const missing = missingProviders(env);
  if (missing.length === 0) return { injected: [] };

  if (findHarnessRepoConfig(options.cwd ?? process.cwd()) === null) return { injected: [] };

  const credentials = await readStoredCredentials(
    options.credentialsPath ?? defaultCredentialsPath(env)
  );
  if (credentials === null) {
    return {
      injected: [],
      note: `Missing ${missing.map((p) => PROVIDER_ENV_VARS[p]).join(', ')} — this repo is Harness-managed; run \`harness login\` and rcl will fetch the keys for you.`,
    };
  }

  const keys = await fetchModelKeys(credentials.url, credentials.token, options.fetchImpl ?? fetch);
  if (keys === null) {
    return { injected: [], note: `Could not fetch model keys from ${credentials.url} — continuing with the environment as-is.` };
  }

  const injected: string[] = [];
  for (const provider of missing) {
    const key = keys[provider];
    if (key !== undefined) {
      env[PROVIDER_ENV_VARS[provider]!] = key;
      injected.push(provider);
    }
  }

  return {
    injected,
    note: injected.length > 0 ? `Using ${injected.join(', ')} key(s) from Harness (${credentials.url}).` : undefined,
  };
}
