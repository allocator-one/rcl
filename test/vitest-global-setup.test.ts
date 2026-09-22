import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setup, shouldBuildCli, typescriptBin } from './vitest-global-setup.js';

const builds = vi.hoisted(() => ({ pending: [] as Array<(error?: Error) => void>, active: 0, maximum: 0 }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  builds.maximum = Math.max(builds.maximum, ++builds.active);
  const callback = args.at(-1) as (error: Error | null, result: unknown) => void;
  builds.pending.push(error => { builds.active--; callback(error ?? null, {}); });
} }));
afterEach(() => { vi.unstubAllEnvs(); builds.pending.length = 0; builds.active = 0; builds.maximum = 0; });

describe('Vitest CLI build coordination', () => {
  it('does not build when a packaged CLI override is selected', () => {
    expect(shouldBuildCli({ RCL_TEST_PACKAGED_CLI: '/tmp/rcl' })).toBe(false);
    expect(shouldBuildCli({})).toBe(true);
  });

  it('resolves TypeScript from the installed package', () => {
    expect(typescriptBin()).toBe(createRequire(import.meta.url).resolve('typescript/bin/tsc'));
  });

  it('waits for serialized rebuilds after changes arriving during a watch build', async () => {
    vi.stubEnv('RCL_TEST_PACKAGED_CLI', '');
    let rerun!: () => Promise<void>;
    const initialized = setup({ onTestsRerun: callback => { rerun = callback; } });
    builds.pending.shift()!(); await initialized;
    let completed = 0;
    const first = rerun().then(() => { completed++; });
    const second = rerun().then(() => { completed++; });
    try {
      expect(builds.active).toBe(1);
      builds.pending.shift()!();
      // The queued source change needs another build before either hook can
      // allow Vitest to start tests against dist.
      await vi.waitFor(() => expect(builds.pending).toHaveLength(1));
      expect(completed).toBe(0); expect(builds.maximum).toBe(1);
      builds.pending.shift()!(); await Promise.all([first, second]);
      expect(completed).toBe(2); expect(builds.active).toBe(0);
    } finally {
      while (builds.pending.length) { builds.pending.shift()!(); await Promise.resolve(); }
      await Promise.allSettled([first, second]);
    }
  });

  it('rejects all waiting hooks on build failure and allows the next rebuild', async () => {
    vi.stubEnv('RCL_TEST_PACKAGED_CLI', '');
    let rerun!: () => Promise<void>;
    const initialized = setup({ onTestsRerun: callback => { rerun = callback; } });
    builds.pending.shift()!(); await initialized;
    const failed = Promise.allSettled([rerun(), rerun()]);
    const error = new Error('synthetic compiler failure');
    builds.pending.shift()!(error);
    expect(await failed).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    const recovered = rerun();
    builds.pending.shift()!(); await recovered;
    expect(builds.active).toBe(0); expect(builds.maximum).toBe(1);
  });
});
