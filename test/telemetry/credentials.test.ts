import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { credentialHost, resolveHarnessCredential } from '../../src/telemetry/credentials.js';

describe('resolveHarnessCredential', () => {
  let repo: string;
  let credentialsPath: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rcl-cred-repo-'));
    await mkdir(join(repo, '.harness-cli'), { recursive: true });
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ team: 'RCL' }));
    credentialsPath = join(repo, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ url: 'https://harness.example.test/', token: 'aone_login' }));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('uses the stored login by default, host without a trailing slash', async () => {
    const resolved = await resolveHarnessCredential({ env: {}, cwd: repo, credentialsPath });
    expect(resolved).toEqual({
      repoManaged: true,
      credential: { url: 'https://harness.example.test', token: 'aone_login', source: 'login' },
    });
    expect(credentialHost(resolved.credential!)).toBe('harness.example.test');
  });

  it('prefers the environment pair and never pairs an env token with the stored host', async () => {
    const paired = await resolveHarnessCredential({
      env: { HARNESS_API_TOKEN: 'aone_ci', HARNESS_API_URL: 'https://ci.example.test/' },
      cwd: repo,
      credentialsPath,
    });
    expect(paired.credential).toEqual({ url: 'https://ci.example.test', token: 'aone_ci', source: 'env' });

    const unpaired = await resolveHarnessCredential({ env: { HARNESS_API_TOKEN: 'aone_ci' }, cwd: repo, credentialsPath });
    expect(unpaired.credential).toBeUndefined();
    expect(unpaired.note).toMatch(/never pairs with the stored login host/);

    const malformed = await resolveHarnessCredential({
      env: { HARNESS_API_TOKEN: 'aone_ci', HARNESS_API_URL: 'harness.example.test' },
      cwd: repo,
      credentialsPath,
    });
    expect(malformed.credential).toBeUndefined();
    expect(malformed.note).toMatch(/absolute http\(s\) URL/);
  });

  it('does not apply outside a Harness-managed repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'rcl-cred-plain-'));
    try {
      expect(await resolveHarnessCredential({ env: { HARNESS_API_TOKEN: 'x', HARNESS_API_URL: 'https://h' }, cwd: plain })).toEqual({ repoManaged: false });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('explains a missing login', async () => {
    const resolved = await resolveHarnessCredential({ env: {}, cwd: repo, credentialsPath: join(repo, 'missing.json') });
    expect(resolved.credential).toBeUndefined();
    expect(resolved.note).toMatch(/harness login/);
  });
});
