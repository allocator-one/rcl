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
}

function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return raw.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export async function resolveHarnessCredential(
  options: CredentialOptions = {}
): Promise<CredentialResolution> {
  const env = options.env ?? process.env;
  const repoManaged = findHarnessRepoConfig(options.cwd ?? process.cwd()) !== null;
  if (!repoManaged) return { repoManaged: false };

  const envToken = (env['HARNESS_API_TOKEN'] ?? '').trim();
  const envUrl = (env['HARNESS_API_URL'] ?? '').trim();
  if (envToken !== '') {
    if (envUrl === '') {
      return {
        repoManaged,
        note: 'HARNESS_API_TOKEN is set without HARNESS_API_URL — an environment token never pairs with the stored login host.',
      };
    }
    const url = normalizeUrl(envUrl);
    if (url === null) {
      return { repoManaged, note: `HARNESS_API_URL is not an absolute http(s) URL: ${envUrl}` };
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
  return { repoManaged, credential: { url: stored.url, token: stored.token, source: 'login' } };
}

/** The host name a status line may name (never the token). */
export function credentialHost(credential: HarnessCredential): string {
  try {
    return new URL(credential.url).host;
  } catch {
    return credential.url;
  }
}
