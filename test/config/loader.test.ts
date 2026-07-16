import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../../src/config/loader.js';
import { DEFAULT_MODELS } from '../../src/config/defaults.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rcl-loader-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns defaults when no config exists', async () => {
    const config = await loadConfig(undefined, dir);
    expect(config.models).toEqual([...DEFAULT_MODELS]);
  });

  it('loads a valid yaml config', async () => {
    await writeFile(
      join(dir, '.review-council.yml'),
      'models:\n  - openai-compat/llama3.2\ntimeout: 60000\n'
    );
    const config = await loadConfig(undefined, dir);
    expect(config.models).toEqual(['openai-compat/llama3.2']);
    expect(config.timeout).toBe(60000);
    expect(config.secondaryModels).toEqual([]);
  });

  it('ignores executable config files during search', async () => {
    await writeFile(
      join(dir, '.review-council.cjs'),
      'module.exports = { models: ["evil/model"] };'
    );
    const config = await loadConfig(undefined, dir);
    expect(config.models).toEqual([...DEFAULT_MODELS]);
  });

  it('does not walk parent directories', async () => {
    await writeFile(
      join(dir, '.review-council.json'),
      JSON.stringify({ models: ['parent/model'] })
    );
    const child = join(dir, 'child');
    await mkdir(child);
    const config = await loadConfig(undefined, child);
    expect(config.models).toEqual([...DEFAULT_MODELS]);
  });

  it('rejects invalid config instead of falling back to cloud defaults', async () => {
    await writeFile(
      join(dir, '.review-council.json'),
      JSON.stringify({ models: ['openai-compat/llama3.2'], timeout: '120' })
    );
    await expect(loadConfig(undefined, dir)).rejects.toThrow(ConfigError);
    await expect(loadConfig(undefined, dir)).rejects.toThrow(/timeout/);
  });

  it('rejects malformed yaml instead of falling back to cloud defaults', async () => {
    await writeFile(join(dir, '.review-council.yml'), 'models: [unclosed\n:bad');
    await expect(loadConfig(undefined, dir)).rejects.toThrow(ConfigError);
  });
});
