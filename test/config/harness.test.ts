import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyHarnessModelKeys,
  findHarnessRepoConfig,
  defaultCredentialsPath,
} from '../../src/config/harness.js';

describe('harness key distribution', () => {
  let repo: string;
  let credentialsPath: string;

  function fakeFetch(
    handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }
  ): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const { status, body } = handler(String(input), init);
      return new Response(JSON.stringify(body ?? {}), { status });
    }) as typeof fetch;
  }

  const KEYS_RESPONSE = {
    data: { keys: { anthropic: 'sk-ant-from-harness', openrouter: 'sk-or-from-harness' } },
  };

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rcl-harness-repo-'));
    await mkdir(join(repo, '.harness-cli'), { recursive: true });
    await writeFile(join(repo, '.harness-cli', 'config.json'), JSON.stringify({ team: 'RCL' }));

    credentialsPath = join(repo, 'credentials.json');
    await writeFile(
      credentialsPath,
      JSON.stringify({ url: 'https://harness.example.test', token: 'aone_test' })
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('findHarnessRepoConfig', () => {
    it('finds the config walking up from a nested directory', async () => {
      const nested = join(repo, 'src', 'deep');
      await mkdir(nested, { recursive: true });
      expect(findHarnessRepoConfig(nested)).toBe(join(repo, '.harness-cli', 'config.json'));
    });

    it('returns null when no config exists up the tree', async () => {
      const plain = await mkdtemp(join(tmpdir(), 'rcl-harness-plain-'));
      try {
        expect(findHarnessRepoConfig(plain)).toBeNull();
      } finally {
        await rm(plain, { recursive: true, force: true });
      }
    });
  });

  describe('defaultCredentialsPath', () => {
    it('honors an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
      expect(defaultCredentialsPath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe(
        '/tmp/xdg/harness/credentials.json'
      );
      // Relative values are invalid per the XDG spec — fall back to ~/.config
      expect(defaultCredentialsPath({ XDG_CONFIG_HOME: 'relative/dir' })).toContain('.config');
    });
  });

  it('injects only the missing keys — the environment always wins', async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-ant-already-set',
    };
    const result = await applyHarnessModelKeys({
      cwd: repo,
      env,
      credentialsPath,
      fetchImpl: fakeFetch(() => ({ status: 200, body: KEYS_RESPONSE })),
    });

    expect(result.injected).toEqual(['openrouter']);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-already-set');
    expect(env['OPENROUTER_API_KEY']).toBe('sk-or-from-harness');
    // The backend served no openai/google keys — envs stay unset
    expect(env['OPENAI_API_KEY']).toBeUndefined();
  });

  it('sends the token only to the host that minted it', async () => {
    const seen: string[] = [];
    const env: Record<string, string | undefined> = {};
    await applyHarnessModelKeys({
      cwd: repo,
      env,
      credentialsPath,
      fetchImpl: fakeFetch((url, init) => {
        seen.push(url);
        expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer aone_test');
        return { status: 200, body: KEYS_RESPONSE };
      }),
    });
    expect(seen).toEqual(['https://harness.example.test/api/v1/model-keys']);
  });

  it('does not fetch at all when every key is already set', async () => {
    let called = false;
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      GOOGLE_API_KEY: 'x', // google counts via either env var
      OPENROUTER_API_KEY: 'x',
    };
    const result = await applyHarnessModelKeys({
      cwd: repo,
      env,
      credentialsPath,
      fetchImpl: fakeFetch(() => {
        called = true;
        return { status: 200, body: KEYS_RESPONSE };
      }),
    });
    expect(result.injected).toEqual([]);
    expect(called).toBe(false);
  });

  it('does nothing outside a Harness-managed repo', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'rcl-harness-plain-'));
    try {
      let called = false;
      const result = await applyHarnessModelKeys({
        cwd: plain,
        env: {},
        credentialsPath,
        fetchImpl: fakeFetch(() => {
          called = true;
          return { status: 200, body: KEYS_RESPONSE };
        }),
      });
      expect(result.injected).toEqual([]);
      expect(result.note).toBeUndefined();
      expect(called).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('hints at `harness login` when the repo is managed but no credential exists', async () => {
    const result = await applyHarnessModelKeys({
      cwd: repo,
      env: {},
      credentialsPath: join(repo, 'nope.json'),
      fetchImpl: fakeFetch(() => ({ status: 200, body: KEYS_RESPONSE })),
    });
    expect(result.injected).toEqual([]);
    expect(result.note).toContain('harness login');
  });

  it('degrades silently on a non-200 (older backend without the endpoint)', async () => {
    const env: Record<string, string | undefined> = {};
    const result = await applyHarnessModelKeys({
      cwd: repo,
      env,
      credentialsPath,
      fetchImpl: fakeFetch(() => ({ status: 404, body: { error: 'not_found' } })),
    });
    expect(result.injected).toEqual([]);
    expect(result.note).toContain('Could not fetch');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('degrades silently when the fetch throws (offline)', async () => {
    const result = await applyHarnessModelKeys({
      cwd: repo,
      env: {},
      credentialsPath,
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as typeof fetch,
    });
    expect(result.injected).toEqual([]);
  });

  it('ignores malformed credentials and unknown/blank served keys', async () => {
    await writeFile(credentialsPath, 'not json');
    const noCreds = await applyHarnessModelKeys({ cwd: repo, env: {}, credentialsPath });
    expect(noCreds.note).toContain('harness login');

    await writeFile(
      credentialsPath,
      JSON.stringify({ url: 'https://harness.example.test', token: 'aone_test' })
    );
    const env: Record<string, string | undefined> = {};
    const result = await applyHarnessModelKeys({
      cwd: repo,
      env,
      credentialsPath,
      fetchImpl: fakeFetch(() => ({
        status: 200,
        body: { data: { keys: { anthropic: '', mystery: 'sk-x', openai: 42 } } },
      })),
    });
    expect(result.injected).toEqual([]);
    expect(env['OPENAI_API_KEY']).toBeUndefined();
  });

  it('is disabled by RCL_NO_HARNESS_KEYS', async () => {
    let called = false;
    const result = await applyHarnessModelKeys({
      cwd: repo,
      env: { RCL_NO_HARNESS_KEYS: '1' },
      credentialsPath,
      fetchImpl: fakeFetch(() => {
        called = true;
        return { status: 200, body: KEYS_RESPONSE };
      }),
    });
    expect(result.injected).toEqual([]);
    expect(called).toBe(false);
  });
});
