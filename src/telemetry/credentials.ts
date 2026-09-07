import {
  defaultCredentialsPath,
  findHarnessRepoConfig,
  readStoredCredentials,
} from '../config/harness.js';

/**
 * Which Harness the evidence goes to, and with what (epic IO-12475,
 * section 8.5). Two sources, never mixed:
 *
 * - the stored `harness login` credential (the default), whose `{url, token}`
 *   pair is indivisible — the token is only ever sent to the host that
 *   minted it;
 * - `HARNESS_API_TOKEN` + `HARNESS_API_URL` for CI, following harness-cli's
 *   rule that an environment token never pairs with the stored host.
 *
 * Telemetry applies only to repositories that carry `.harness-cli/config.json`
 * (the "this repo belongs to the org" signal); the file's contents are not
 * trusted for anything.
 */

export interface HarnessCredential {
  /** Base URL without a trailing slash. */
  url: string;
  token: string;
  source: 'env' | 'login';
}

export interface CredentialResolution {
  /** Whether the working tree belongs to a Harness-managed repository. */
  repoManaged: boolean;
  credential?: HarnessCredential;
  /** One line worth telling the user when no credential could be used. */
  note?: string;
}

export interface CredentialOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  credentialsPath?: string;
  /** `rcl telemetry` operates on the user's outbox from anywhere; reviews need the repo signal. */
  requireRepo?: boolean;
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|[a-z0-9.-]+\.localhost)$/i;

/**
 * The token travels only over TLS, except to loopback hosts (a local
 * development server). A base URL carries no user-info, query or fragment;
 * the result is the canonical origin plus path, without a trailing slash.
 */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
    const plain = url.protocol === 'http:' && LOOPBACK.test(url.hostname);
    if (url.protocol !== 'https:' && !plain) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** The host of a URL for a note — never its user-info or query. */
function hostOf(raw: string): string {
  try {
    return new URL(raw.trim()).host || '(no host)';
  } catch {
    return '(unparseable)';
  }
}

export async function resolveHarnessCredential(
  options: CredentialOptions = {}
): Promise<CredentialResolution> {
  const env = options.env ?? process.env;
  const repoManaged = findHarnessRepoConfig(options.cwd ?? process.cwd()) !== null;
  if (!repoManaged && options.requireRepo !== false) return { repoManaged: false };

  const envToken = (env['HARNESS_API_TOKEN'] ?? '').trim();
  const envUrl = (env['HARNESS_API_URL'] ?? '').trim();
  if (envToken !== '' || envUrl !== '') {
    // Half a pair is a configuration error, never a fallback to the login.
    if (envUrl === '') {
      return {
        repoManaged,
        note: 'HARNESS_API_TOKEN is set without HARNESS_API_URL — an environment token never pairs with the stored login host.',
      };
    }
    if (envToken === '') {
      return {
        repoManaged,
        note: 'HARNESS_API_URL is set without HARNESS_API_TOKEN — the environment names a host but no token; the stored login is not used in its place.',
      };
    }
    const url = normalizeUrl(envUrl);
    if (url === null) {
      return {
        repoManaged,
        note: `HARNESS_API_URL must be an absolute https URL without user-info, query or fragment (http only for loopback hosts): ${hostOf(envUrl)}`,
      };
    }
    return { repoManaged, credential: { url, token: envToken, source: 'env' } };
  }

  const stored = await readStoredCredentials(options.credentialsPath ?? defaultCredentialsPath(env));
  if (stored === null) {
    return {
      repoManaged,
      note: 'not logged in to Harness — run `harness login` (or set HARNESS_API_TOKEN and HARNESS_API_URL in CI).',
    };
  }
  const storedUrl = normalizeUrl(stored.url);
  if (storedUrl === null) {
    return { repoManaged, note: `the stored Harness login names a host the token must not travel to in plain text: ${hostOf(stored.url)}` };
  }
  return { repoManaged, credential: { url: storedUrl, token: stored.token, source: 'login' } };
}

/** The host name a status line may name (never the token). */
export function credentialHost(credential: HarnessCredential): string {
  try {
    return new URL(credential.url).host;
  } catch {
    return credential.url;
  }
}
