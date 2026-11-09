import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyHarnessModelKeys } from '../../src/config/harness.js';

// RCL-203: a council launched from an agent session cannot be wrapped in
// `harness keys exec --override` (the host's permission classifier refuses
// that env injection). Harness-first precedence therefore has to live in rcl.
describe('harness-first key precedence', () => {
  let dir: string;
  let credentialsPath: string;

  const served = (keys: Record<string, string>): typeof fetch =>
    (async () => new Response(JSON.stringify({ data: { keys } }), { status: 200 })) as typeof fetch;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rcl-keys-first-'));
    credentialsPath = join(dir, 'credentials.json');
    await writeFile(credentialsPath, JSON.stringify({ url: 'https://harness.example.test', token: 'aone_test' }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces an ambient key with the Harness key and drops the Google alias', async () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'ambient-ant',
      GOOGLE_API_KEY: 'ambient-google-alias',
    };
    const result = await applyHarnessModelKeys({
      cwd: dir,
      env,
      credentialsPath,
      harnessFirst: true,
      fetchImpl: served({ anthropic: 'harness-ant', google: 'harness-gem' }),
    });

    expect(result.failure).toBeUndefined();
    expect(result.injected.sort()).toEqual(['anthropic', 'google']);
    expect(env['ANTHROPIC_API_KEY']).toBe('harness-ant');
    expect(env['GEMINI_API_KEY']).toBe('harness-gem');
    expect(env['GOOGLE_API_KEY']).toBeUndefined();
  });

  it('never falls back to an ambient key for a provider Harness does not serve', async () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'ambient-openai' };
    const result = await applyHarnessModelKeys({
      cwd: dir,
      env,
      credentialsPath,
      harnessFirst: true,
      fetchImpl: served({ anthropic: 'harness-ant' }),
    });

    expect(result.injected).toEqual(['anthropic']);
    expect(env['OPENAI_API_KEY']).toBeUndefined();
  });

  it('does not require the repository to carry a Harness config', async () => {
    const env: Record<string, string | undefined> = {};
    const result = await applyHarnessModelKeys({
      cwd: dir,
      env,
      credentialsPath,
      harnessFirst: true,
      fetchImpl: served({ anthropic: 'harness-ant' }),
    });
    expect(result.injected).toEqual(['anthropic']);
  });

  it('fails closed and keeps the environment untouched when the fetch fails', async () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'ambient-ant' };
    const result = await applyHarnessModelKeys({
      cwd: dir,
      env,
      credentialsPath,
      harnessFirst: true,
      sleep: async () => {},
      fetchImpl: (async () => new Response('{}', { status: 403 })) as typeof fetch,
    });

    expect(result.failure).toContain('HTTP 403');
    expect(env['ANTHROPIC_API_KEY']).toBe('ambient-ant');
  });

  it('fails closed without a stored login', async () => {
    const result = await applyHarnessModelKeys({
      cwd: dir,
      env: {},
      credentialsPath: join(dir, 'missing.json'),
      harnessFirst: true,
      fetchImpl: served({ anthropic: 'x' }),
    });
    expect(result.failure).toMatch(/harness login/);
  });

  it('fails closed when RCL_NO_HARNESS_KEYS disables the mechanism', async () => {
    const result = await applyHarnessModelKeys({
      cwd: dir,
      env: { RCL_NO_HARNESS_KEYS: '1' },
      credentialsPath,
      harnessFirst: true,
      fetchImpl: served({ anthropic: 'x' }),
    });
    expect(result.failure).toMatch(/RCL_NO_HARNESS_KEYS/);
  });

  it('leaves the default behaviour alone: the environment still wins', async () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: 'ambient-ant' };
    await applyHarnessModelKeys({
      cwd: dir,
      env,
      credentialsPath,
      credential: { url: 'https://harness.example.test', token: 'aone_test' },
      fetchImpl: served({ anthropic: 'harness-ant', openai: 'harness-openai' }),
    });
    expect(env['ANTHROPIC_API_KEY']).toBe('ambient-ant');
    expect(env['OPENAI_API_KEY']).toBe('harness-openai');
  });
});
