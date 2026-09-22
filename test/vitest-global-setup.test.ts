import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { shouldBuildCli, typescriptBin } from './vitest-global-setup.js';

describe('Vitest CLI build coordination', () => {
  it('does not build when a packaged CLI override is selected', () => {
    expect(shouldBuildCli({ RCL_TEST_PACKAGED_CLI: '/tmp/rcl' })).toBe(false);
    expect(shouldBuildCli({})).toBe(true);
  });

  it('resolves TypeScript from the installed package', () => {
    expect(typescriptBin()).toBe(createRequire(import.meta.url).resolve('typescript/bin/tsc'));
  });
});
