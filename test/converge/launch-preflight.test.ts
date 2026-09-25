import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateLaunchOutputs, validateLaunchProviders } from '../../src/converge/launch-preflight.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('guarded launch preflight', () => {
  it('requires credentials only for selected providers, including normalized Google aliases', () => {
    expect(() => validateLaunchProviders(['google'], { GOOGLE_API_KEY: ' ', GEMINI_API_KEY: 'fixture' })).not.toThrow();
    expect(() => validateLaunchProviders(['openai-compat'], {})).not.toThrow();
    expect(() => validateLaunchProviders(['google', 'openai'], { GEMINI_API_KEY: 'fixture' }))
      .toThrow(/missing_provider_credentials.*openai/);
  });

  it('rejects malformed or unsupported local provider endpoints', () => {
    expect(() => validateLaunchProviders(['openai-compat'], { OPENAI_COMPAT_BASE_URL: 'invalid' })).toThrow();
    expect(() => validateLaunchProviders(['openai-compat'], { OPENAI_COMPAT_BASE_URL: 'file:///tmp/model' }))
      .toThrow('invalid_provider_url');
  });

  it('requires fresh distinct report paths with existing writable parents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rcl-preflight-'));
    directories.push(directory);
    const jsonFile = join(directory, 'report.json');

    await expect(validateLaunchOutputs({})).rejects.toThrow('report_required');
    await expect(validateLaunchOutputs({ jsonFile, markdown: jsonFile })).rejects.toThrow('output_collision');
    await expect(validateLaunchOutputs({ jsonFile: join(directory, 'missing', 'report.json') })).rejects.toThrow();
    await expect(validateLaunchOutputs({ jsonFile })).resolves.toBeUndefined();
    await writeFile(jsonFile, 'original');
    await expect(validateLaunchOutputs({ jsonFile })).rejects.toThrow('output_exists');
  });
});
