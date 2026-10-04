import { beforeEach, expect, it, vi } from 'vitest';
import { selectCurrentRecoveredProduction } from '../../src/converge/recovered-production.js';

const discovery = vi.hoisted(() => ({ error: undefined as (Error & { code: number | string; stderr: string }) | undefined }));
vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => {
  const callback = args.at(-1) as (error: Error | undefined, stdout: string, stderr: string) => void;
  callback(discovery.error, '', discovery.error?.stderr ?? '');
} }));

beforeEach(() => { discovery.error = undefined; });
const context = { target: 'synthetic-git-discovery', round: 1 };
const ordinary = 'fatal: not a git repository (or any of the parent directories): .git';
// Captured from real C-locale Git in /dev, which is a separate filesystem.
const boundary = 'fatal: not a git repository (or any parent up to mount point /)\n' +
  'Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).';
function reject(code: number | string, stderr: string) {
  discovery.error = Object.assign(new Error('Synthetic Git discovery failure'), { code, stderr });
}

it.each([ordinary, boundary])('preserves ordinary patch review for a known outside-repository Git result: %s', async stderr => {
  reject(128, `${stderr}\n`);
  await expect(selectCurrentRecoveredProduction(context, '/synthetic')).resolves.toBeUndefined();
});

it.each([
  [128, 'fatal: detected dubious ownership in repository at /synthetic'],
  [128, 'fatal: not a git repository: /synthetic/broken.git'],
  [128, `${ordinary}\nUnexpected additional failure`],
  [128, boundary.split('\n')[0]!],
  [128, boundary.replace('Stopping at filesystem boundary', 'Unexpected discovery failure')],
  [1, ordinary],
  ['ENOENT', ''],
  ['EACCES', 'Permission denied'],
] as const)('refuses unexpected discovery failure %s / %s', async (code, stderr) => {
  reject(code, stderr);
  await expect(selectCurrentRecoveredProduction(context, '/synthetic')).rejects.toMatchObject({
    code: 'RCL_CONVERGE_RUN_STATE', cause: discovery.error,
  });
});
