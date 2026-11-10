import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orgCredentialsPath, resolveLogin } from '../../src/config/harness.js';
import { resolveHarnessCredential } from '../../src/telemetry/credentials.js';

/**
 * RCL-234: `rcl telemetry status` names the credential file, the host and why
 * that file won, so an operator can tell why a 401 happens. One test per
 * layout harness-cli can leave behind; the token never appears.
 */
describe('credential origin per harness-cli layout', () => {
  const ORG = '3F96A9C0-1584-4c65-9c4b-056055024bc9';
  const HOST = 'https://harness.infra.one';
  // The reader lower-cases the repo's org, as harness-cli does.
  const ORG_LOWER = ORG.toLowerCase();

  let dir: string;
  let repo: string;
  let legacyPath: string;

  const write = (path: string, url: string, token: string) => writeFile(path, JSON.stringify({ url, token }));
  const writeOrg = (host: string, url: string, token: string) => write(orgCredentialsPath(legacyPath, host, ORG), url, token);
  const resolve = () => resolveHarnessCredential({ env: {}, cwd: repo, credentialsPath: legacyPath });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rcl-cred-origin-'));
    repo = join(dir, 'repo');
    await mkdir(join(repo, '.harness-cli'), { recursive: true });
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ team: 'IO', org: ORG }));
    legacyPath = join(dir, 'config', 'harness', 'credentials.json');
    await mkdir(join(dir, 'config', 'harness'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('names the legacy file when the repository names no org', async () => {
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ team: 'IO' }));
    await write(legacyPath, HOST, 'aone_legacy');
    expect((await resolve()).origin).toEqual({ file: legacyPath, reason: 'legacy login (the repo config names no org)' });
  });

  it('names the org-scoped file when the org has no stale legacy login', async () => {
    await writeOrg(HOST, HOST, 'aone_org');
    expect((await resolve()).origin).toEqual({
      file: orgCredentialsPath(legacyPath, HOST, ORG),
      reason: `org-scoped login for org ${ORG_LOWER} on harness.infra.one`,
    });
  });

  it('names the org-scoped file over a stale legacy one', async () => {
    await write(legacyPath, HOST, 'aone_stale');
    await writeOrg(HOST, HOST, 'aone_fresh');
    expect((await resolve()).origin?.file).toBe(orgCredentialsPath(legacyPath, HOST, ORG));
  });

  it('says why the legacy file won when the org has no login on a known host', async () => {
    await write(legacyPath, HOST, 'aone_legacy');
    expect((await resolve()).origin).toEqual({
      file: legacyPath,
      reason: `legacy login (no org-scoped login for org ${ORG_LOWER} on a known host)`,
    });
  });

  it('names the ignored org file when its url does not match the host it is filed under', async () => {
    await write(legacyPath, HOST, 'aone_legacy');
    await writeOrg(HOST, 'https://elsewhere.example.test', 'aone_other');
    const { origin } = await resolve();
    expect(origin?.file).toBe(legacyPath);
    expect(origin?.reason).toContain(`org ${ORG_LOWER} has a login file for a different host`);
    expect(origin?.reason).toContain(orgCredentialsPath(legacyPath, HOST, ORG));
  });

  it('never prints user-info or a query from a stored URL', async () => {
    const dirty = 'https://user:hunter2@harness.example.test/?key=secret';
    await write(legacyPath, dirty, 'aone_legacy');
    await writeOrg(dirty, dirty, 'aone_org');
    const login = await resolveLogin({ env: {}, cwd: repo, credentialsPath: legacyPath });
    expect(login?.origin.file).toBe(orgCredentialsPath(legacyPath, dirty, ORG));
    expect(login?.origin.reason).toBe(`org-scoped login for org ${ORG_LOWER} on harness.example.test`);
  });

  it('has no file for an environment pair', async () => {
    const resolved = await resolveHarnessCredential({
      env: { HARNESS_API_TOKEN: 'aone_env', HARNESS_API_URL: HOST },
      cwd: repo,
      credentialsPath: legacyPath,
    });
    expect(resolved.origin).toEqual({ file: null, reason: 'HARNESS_API_TOKEN and HARNESS_API_URL are set' });
  });

  it('prints the file, the host and the reason from `rcl telemetry status`, never the token', async () => {
    await write(legacyPath, HOST, 'aone_stale');
    await writeOrg(HOST, HOST, 'aone_secret_fresh');
    const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
    const env = {
      PATH: process.env['PATH'] ?? '',
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, 'config'),
      RCL_DATA_DIR: join(dir, 'data'),
    };
    const run = (args: string[]) => spawnSync(process.execPath, [entry, 'telemetry', 'status', ...args], { cwd: repo, env, encoding: 'utf8' });

    const text = run([]);
    expect(text.stdout).toContain(`Credential: login → harness.infra.one`);
    expect(text.stdout).toContain(`File: ${orgCredentialsPath(legacyPath, HOST, ORG)}`);
    expect(text.stdout).toContain(`Why: org-scoped login for org ${ORG_LOWER} on harness.infra.one`);

    const json = JSON.parse(run(['--json']).stdout) as { credential: { file: string; reason: string; host: string } };
    expect(json.credential).toEqual({
      source: 'login',
      host: 'harness.infra.one',
      file: orgCredentialsPath(legacyPath, HOST, ORG),
      reason: `org-scoped login for org ${ORG_LOWER} on harness.infra.one`,
    });
    expect(text.stdout + run(['--json']).stdout).not.toContain('aone_');
  });
});
