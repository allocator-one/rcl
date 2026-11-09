import { createHash } from 'crypto';
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
 * - Every failure degrades to today's behavior (missing keys warn or fail
 *   as before, naming why the fetch failed); the fetch runs under a bounded
 *   timeout and one retry so an offline machine never hangs a review.
 * - Keys land in the (injected) env only — never on disk, never in logs.
 */

/** Provider names the backend may serve, mapped to the env var rcl reads. */
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/**
 * Long enough for a healthy but slow backend (responses of 3.7–7.1 s were
 * measured in RCL-188, when a 3 s cap refused launches), short enough that
 * an unreachable host never stalls a review for long.
 */
const FETCH_TIMEOUT_MS = 12_000;
/** A timeout, network error, 429 or 5xx is retried once after this delay. */
const FETCH_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;

export interface HarnessKeyResult {
  /** Providers whose keys were injected into the env. */
  injected: string[];
  /** One human-readable line worth showing, when there is something to say. */
  note?: string;
  /** Why the key fetch failed, for a later missing-credentials refusal to name. */
  fetchFailure?: string;
  /**
   * Set only in harness-first mode when Harness could not supply keys: the
   * environment is untouched and the caller must refuse to launch rather
   * than fall back to ambient keys.
   */
  failure?: string;
}

export interface HarnessKeyOptions {
  cwd?: string;
  /** Injectable for tests; defaults to process.env and is MUTATED on inject. */
  env?: Record<string, string | undefined>;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for tests; waits between fetch attempts. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A credential already in hand — the run-bound one `rcl review --attest`
   * minted (RCL-40). Used instead of the stored login, and the attestation
   * stands in for the repository's `.harness-cli/config.json`.
   */
  credential?: { url: string; token: string };
  /**
   * Harness takes precedence over the environment (RCL-203): every provider
   * key in the env is dropped, then the ones Harness serves are injected, so
   * a provider Harness does not hold reads as missing instead of silently
   * reusing an ambient key. This is what `harness keys exec --override`
   * did, without the env-injecting wrapper an agent session cannot launch.
   * Any inability to fetch is reported as `failure`, never degraded.
   */
  harnessFirst?: boolean;
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

const DEFAULT_HARNESS_URL = 'https://harness.infra.one';
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where harness-cli 1.16+ stores the login for one org on one host, next to
 * the legacy file: `credentials-org-<sha256 of [legacyPath, host, org]>.json`.
 * The hash must stay byte-identical to harness-cli's core/credentials.ts.
 */
export function orgCredentialsPath(legacyPath: string, baseUrl: string, org: string): string {
  const url = new URL(baseUrl);
  const host = url.origin + url.pathname.replace(/\/+$/, '');
  const key = createHash('sha256').update(JSON.stringify([legacyPath, host, org.toLowerCase()])).digest('hex');
  return join(dirname(legacyPath), `credentials-org-${key}.json`);
}

/** The `org` the repository's `.harness-cli/config.json` names, when it is an organization UUID. */
async function readRepoOrg(startDir: string): Promise<string | null> {
  const path = findHarnessRepoConfig(startDir);
  if (path === null) return null;
  try {
    const org = (JSON.parse(await readFile(path, 'utf-8')) as { org?: unknown } | null)?.org;
    return typeof org === 'string' && ORG_ID.test(org.trim()) ? org.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The custom hosts the user approved on `harness login` (harness-cli's trusted-hosts.json), independent of any repository. */
async function readTrustedHosts(legacyPath: string): Promise<string[]> {
  try {
    const hosts = (JSON.parse(await readFile(join(dirname(legacyPath), 'trusted-hosts.json'), 'utf-8')) as { hosts?: unknown } | null)?.hosts;
    return Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string') : [];
  } catch {
    return [];
  }
}

/** Same scheme, host, port and path, as harness-cli compares a stored login with the host it targets. */
function sameHost(a: string, b: string): boolean {
  const key = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
      return JSON.stringify([url.protocol, url.hostname, port, url.pathname.replace(/\/+$/, '')]);
    } catch {
      return null;
    }
  };
  const left = key(a);
  return left !== null && left === key(b);
}

export interface LoginOptions {
  env: Record<string, string | undefined>;
  cwd: string;
  /** The legacy file; the org-scoped files sit beside it. */
  credentialsPath?: string;
}

/**
 * The login credential `harness login` left for this repository, found as
 * harness-cli finds it: a repository whose `.harness-cli/config.json` names
 * an `org` has its own org-scoped file, which a fresh login writes while the
 * legacy `credentials.json` keeps its older token (RCL-211). The org file
 * wins when it holds a login for the host it was minted for; otherwise, and
 * outside such a repository, the legacy file answers as before.
 *
 * The file name depends on the host, so the host is never taken from the
 * repository, whose `.harness-cli/config.json` is attacker-controlled input in
 * a cloned repo; only its `org` is read. Like harness-cli without a repository
 * url, the default host comes first, so a fresh login there is never hidden by
 * a stale legacy file. The legacy login's host and the hosts the user approved
 * in `trusted-hosts.json` follow, for a login on a custom host.
 */
export async function readLoginCredential(options: LoginOptions): Promise<{ url: string; token: string } | null> {
  const legacyPath = options.credentialsPath ?? defaultCredentialsPath(options.env);
  const legacy = await readStoredCredentials(legacyPath);
  const org = await readRepoOrg(options.cwd);
  if (org !== null) {
    const hosts = [DEFAULT_HARNESS_URL, ...(legacy === null ? [] : [legacy.url]), ...(await readTrustedHosts(legacyPath))];
    for (const host of new Set(hosts)) {
      let path: string;
      try { path = orgCredentialsPath(legacyPath, host, org); } catch { continue; }
      const scoped = await readStoredCredentials(path);
      if (scoped !== null && sameHost(scoped.url, host)) return scoped;
    }
  }
  return legacy;
}

export async function readStoredCredentials(path: string): Promise<{ url: string; token: string } | null> {
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

type FetchOutcome = { keys: Record<string, string> } | { failure: string; retryable: boolean };

async function fetchModelKeysOnce(baseUrl: string, token: string, fetchImpl: typeof fetch): Promise<FetchOutcome> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/v1/model-keys`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // An older backend without the endpoint answers 404; only overload and
    // server errors are worth a second request.
    if (!response.ok) return { failure: `HTTP ${response.status}`, retryable: response.status === 429 || response.status >= 500 };
    const body: unknown = await response.json();
    const keys = (body as { data?: { keys?: unknown } })?.data?.keys;
    if (typeof keys !== 'object' || keys === null) return { failure: 'unrecognized response', retryable: false };
    const out: Record<string, string> = {};
    for (const [provider, key] of Object.entries(keys)) {
      if (typeof key === 'string' && key !== '') out[provider] = key;
    }
    return { keys: out };
  } catch (error) {
    if (error instanceof SyntaxError) return { failure: 'unrecognized response', retryable: false };
    const timedOut = (error as { name?: unknown } | null)?.name === 'TimeoutError';
    return { failure: timedOut ? `timed out after ${FETCH_TIMEOUT_MS / 1000} s` : 'network error', retryable: true };
  }
}

async function fetchModelKeys(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>
): Promise<{ keys: Record<string, string> } | { failure: string }> {
  for (let attempt = 1; ; attempt++) {
    const outcome = await fetchModelKeysOnce(baseUrl, token, fetchImpl);
    if ('keys' in outcome) return outcome;
    if (!outcome.retryable) return { failure: outcome.failure };
    if (attempt === FETCH_ATTEMPTS) return { failure: `${outcome.failure} on ${FETCH_ATTEMPTS} attempts` };
    await sleep(RETRY_DELAY_MS);
  }
}

export function missingProviders(env: Record<string, string | undefined>): string[] {
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
  if (options.harnessFirst === true) return applyHarnessKeysFirst(options, env);

  if ((env['RCL_NO_HARNESS_KEYS'] ?? '') !== '') return { injected: [] };

  const missing = missingProviders(env);
  if (missing.length === 0) return { injected: [] };

  if (options.credential === undefined && findHarnessRepoConfig(options.cwd ?? process.cwd()) === null) return { injected: [] };

  const credentials =
    options.credential ??
    (await readLoginCredential({ env, cwd: options.cwd ?? process.cwd(),
      ...(options.credentialsPath !== undefined ? { credentialsPath: options.credentialsPath } : {}) }));
  if (credentials === null) {
    return {
      injected: [],
      note: `Missing ${missing.map((p) => PROVIDER_ENV_VARS[p]).join(', ')} — this repo is Harness-managed; run \`harness login\` and rcl will fetch the keys for you.`,
    };
  }

  const fetched = await fetchModelKeys(credentials.url, credentials.token, options.fetchImpl ?? fetch,
    options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))));
  if ('failure' in fetched) {
    return {
      injected: [],
      fetchFailure: fetched.failure,
      note: `Could not fetch model keys from ${credentials.url} (${fetched.failure}) — continuing with the environment as-is.`,
    };
  }
  const { keys } = fetched;

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

/** Every env var rcl reads a provider key from, including the Google alias. */
const PROVIDER_KEY_ENV_NAMES = [...Object.values(PROVIDER_ENV_VARS), 'GOOGLE_API_KEY'];

async function applyHarnessKeysFirst(
  options: HarnessKeyOptions,
  env: Record<string, string | undefined>
): Promise<HarnessKeyResult> {
  const refuse = (failure: string): HarnessKeyResult => ({ injected: [], failure });
  if ((env['RCL_NO_HARNESS_KEYS'] ?? '') !== '') {
    return refuse('RCL_NO_HARNESS_KEYS is set, which disables fetching keys from Harness');
  }
  const credentials =
    options.credential ??
    (await readLoginCredential({ env, cwd: options.cwd ?? process.cwd(),
      ...(options.credentialsPath !== undefined ? { credentialsPath: options.credentialsPath } : {}) }));
  if (credentials === null) return refuse('not logged in to Harness; run `harness login`');

  const fetched = await fetchModelKeys(credentials.url, credentials.token, options.fetchImpl ?? fetch,
    options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))));
  if ('failure' in fetched) return refuse(`could not fetch model keys from ${credentials.url} (${fetched.failure})`);

  // A backend that answers with nothing is as unusable as one that fails: never
  // proceed on an empty set, which would leave every provider to degrade quietly.
  if (Object.keys(PROVIDER_ENV_VARS).every(provider => fetched.keys[provider] === undefined)) {
    return refuse(`Harness at ${credentials.url} serves no provider keys for this login`);
  }

  // Only after the fetch succeeded: a failed one leaves the env untouched.
  for (const name of PROVIDER_KEY_ENV_NAMES) delete env[name];
  const injected: string[] = [];
  for (const [provider, envVar] of Object.entries(PROVIDER_ENV_VARS)) {
    const key = fetched.keys[provider];
    if (key !== undefined) {
      env[envVar] = key;
      injected.push(provider);
    }
  }
  const unserved = Object.keys(PROVIDER_ENV_VARS).filter(provider => !injected.includes(provider));
  return {
    injected,
    ...(unserved.length > 0
      ? { fetchFailure: `Harness served keys only for ${injected.join(', ')}, so --harness-keys-first ignored the environment for ${unserved.join(', ')}` }
      : {}),
    note: `Using ${injected.length > 0 ? injected.join(', ') : 'no'} key(s) from Harness (${credentials.url}), ahead of the environment.`,
  };
}
