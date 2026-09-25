import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { missingProviders } from '../config/harness.js';
import { ReviewLaunchRefused } from './launch-guard.js';

export function validateLaunchProviders(providers: readonly string[], env = process.env): void {
  const missing = missingProviders(env).filter(provider => providers.includes(provider));
  if (missing.length > 0) {
    throw new ReviewLaunchRefused('missing_provider_credentials', `Missing nonempty credentials for: ${missing.join(', ')}. No attempt claimed.`);
  }
  if (providers.includes('openai-compat')) {
    const base = new URL(env['OPENAI_COMPAT_BASE_URL'] ?? 'http://localhost:11434/v1');
    if (!['http:', 'https:'].includes(base.protocol)) {
      throw new ReviewLaunchRefused('invalid_provider_url', 'An OpenAI-compatible endpoint must use HTTP or HTTPS.');
    }
  }
}

export async function validateLaunchOutputs(paths: { jsonFile?: string; markdown?: string }): Promise<void> {
  if (!paths.jsonFile) throw new ReviewLaunchRefused('report_required', 'Guarded convergence requires --json-file to retain the original report.');
  const outputs = [paths.jsonFile, paths.markdown].filter((path): path is string => path !== undefined).map(path => resolve(path));
  if (new Set(outputs).size !== outputs.length) {
    throw new ReviewLaunchRefused('output_collision', 'JSON and Markdown reports need distinct output paths.');
  }
  for (const path of outputs) {
    await access(dirname(path), constants.W_OK);
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new ReviewLaunchRefused('output_exists', 'A report output already exists; preserve it and choose a new output path.');
  }
}
