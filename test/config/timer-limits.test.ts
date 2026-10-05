import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, MAX_TIMER_DELAY_MS } from '../../src/config/schema.js';
import { ConfigError, loadConfig } from '../../src/config/loader.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.each(['timeout', 'asyncTimeout'] as const)('%s timer bounds', field => {
  it('accepts the positive timer boundaries', () => {
    expect(ConfigSchema.parse({ [field]: 1 })[field]).toBe(1);
    expect(ConfigSchema.parse({ [field]: MAX_TIMER_DELAY_MS })[field]).toBe(MAX_TIMER_DELAY_MS);
  });

  it.each([0, -1, MAX_TIMER_DELAY_MS + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects unsupported duration %s before execution', value => {
      expect(ConfigSchema.safeParse({ [field]: value }).success).toBe(false);
    },
  );

  it('refuses an oversized discovered configuration instead of returning an executable plan', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rcl-timer-config-'));
    directories.push(directory);
    await writeFile(join(directory, '.review-council.json'), JSON.stringify({ [field]: MAX_TIMER_DELAY_MS + 1 }));
    const loading = loadConfig(undefined, directory, { preserveDefaultRoster: true });
    await expect(loading).rejects.toThrow(ConfigError);
    await expect(loading).rejects.toThrow(field);
  });
});
