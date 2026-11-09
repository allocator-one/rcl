import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyHarnessModelKeys, orgCredentialsPath } from '../../src/config/harness.js';
import { resolveHarnessCredential } from '../../src/telemetry/credentials.js';

/**
 * RCL-211 / RCL-212: harness-cli 1.16+ writes `harness login` to an org-scoped
 * file next to the legacy `credentials.json` and leaves the legacy token
 * stale. Each layout below is one the CLI can leave behind.
 */
describe('harness-cli credential layouts', () => {
  const ORG = '3F96A9C0-1584-4c65-9c4b-056055024bc9';
  const OTHER_ORG = '11111111-2222-4333-8444-555555555555';
  const HOST = 'https://harness.infra.one';

  let dir: string;
  let repo: string;
  let legacyPath: string;

  const write = (path: string, url: string, token: string) => writeFile(path, JSON.stringify({ url, token }));
  const writeOrg = (org: string, host: string, url: string, token: string) =>
    write(orgCredentialsPath(legacyPath, host, org), url, token);
  const resolve = () => resolveHarnessCredential({ env: {}, cwd: repo, credentialsPath: legacyPath });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rcl-cred-org-'));
    repo = join(dir, 'repo');
    await mkdir(join(repo, '.harness-cli'), { recursive: true });
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ team: 'IO', org: ORG }));
    legacyPath = join(dir, 'config', 'harness', 'credentials.json');
    await mkdir(join(dir, 'config', 'harness'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('derives the org-scoped file name exactly as harness-cli does', () => {
    // Pinned from the file harness-cli 1.16.0 wrote for this path, host and org.
    expect(orgCredentialsPath('/home/u/.config/harness/credentials.json', HOST, ORG)).toBe(
      '/home/u/.config/harness/credentials-org-26ad0bfbed0354850a8fe6cc7dbd05505f32911c14b17d8a5d5f59229bcad6e4.json'
    );
  });

  it('reads the legacy file when the repository names no org', async () => {
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ team: 'IO' }));
    await write(legacyPath, HOST, 'aone_legacy');
    await writeOrg(ORG, HOST, HOST, 'aone_org');
    expect((await resolve()).credential).toEqual({ url: HOST, token: 'aone_legacy', source: 'login' });
  });

  it('reads the legacy file when the org has no org-scoped login', async () => {
    await write(legacyPath, HOST, 'aone_legacy');
    expect((await resolve()).credential).toMatchObject({ token: 'aone_legacy' });
  });

  it('prefers the org-scoped login over a stale legacy one', async () => {
    await write(legacyPath, HOST, 'aone_stale');
    await writeOrg(ORG, HOST, HOST, 'aone_fresh');
    expect((await resolve()).credential).toEqual({ url: HOST, token: 'aone_fresh', source: 'login' });
  });

  it('reads the org-scoped login when there is no legacy file at all', async () => {
    await writeOrg(ORG, HOST, HOST, 'aone_fresh');
    expect((await resolve()).credential).toMatchObject({ token: 'aone_fresh' });
  });

  it('finds an org-scoped login for the host the legacy login names', async () => {
    const custom = 'https://harness.example.test';
    await write(legacyPath, custom, 'aone_stale');
    await writeOrg(ORG, custom, custom, 'aone_fresh');
    expect((await resolve()).credential).toEqual({ url: custom, token: 'aone_fresh', source: 'login' });
  });

  it('never reads the login of another org', async () => {
    await write(legacyPath, HOST, 'aone_legacy');
    await writeOrg(OTHER_ORG, HOST, HOST, 'aone_other_org');
    expect((await resolve()).credential).toMatchObject({ token: 'aone_legacy' });
  });

  it('ignores an org-scoped file whose url is not the host it was minted for', async () => {
    await write(legacyPath, HOST, 'aone_legacy');
    await writeOrg(ORG, HOST, 'https://elsewhere.example.test', 'aone_misfiled');
    expect((await resolve()).credential).toMatchObject({ token: 'aone_legacy' });
  });

  it('does not let the repository config pick the host a token is read for', async () => {
    const attacker = 'https://attacker.example.test';
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ org: ORG, url: attacker }));
    await write(legacyPath, HOST, 'aone_legacy');
    await writeOrg(ORG, attacker, attacker, 'aone_attacker');
    expect((await resolve()).credential).toEqual({ url: HOST, token: 'aone_legacy', source: 'login' });
  });

  it('treats an org that is not a UUID as no org', async () => {
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ org: 'allocator-one' }));
    await write(legacyPath, HOST, 'aone_legacy');
    expect((await resolve()).credential).toMatchObject({ token: 'aone_legacy' });
  });

  it('fetches model keys with the org-scoped token', async () => {
    await write(legacyPath, HOST, 'aone_stale');
    await writeOrg(ORG, HOST, HOST, 'aone_fresh');
    const bearers: string[] = [];
    const result = await applyHarnessModelKeys({
      cwd: repo,
      env: {},
      credentialsPath: legacyPath,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        bearers.push((init?.headers as Record<string, string>)['authorization']!);
        return new Response(JSON.stringify({ data: { keys: { anthropic: 'sk-ant' } } }), { status: 200 });
      }) as typeof fetch,
    });
    expect(bearers).toEqual(['Bearer aone_fresh']);
    expect(result.injected).toContain('anthropic');
  });
});
