import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const cli = process.env['RCL_TEST_PACKAGED_CLI'] || fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

// RCL-207: launch allowlists strip HOME. rcl itself must start and find the
// stored Harness login and its outbox from XDG_CONFIG_HOME and RCL_DATA_DIR
// alone; only a version-manager shim in front of it may need HOME.
it('reports the stored login and outbox with HOME unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-no-home-'));
  directories.push(root);
  const configHome = join(root, 'config');
  const dataDir = join(root, 'data');
  await mkdir(join(configHome, 'harness'), { recursive: true });
  await writeFile(
    join(configHome, 'harness', 'credentials.json'),
    JSON.stringify({ url: 'https://harness.example.test', token: 'stored-token' })
  );

  const { stdout } = await exec(process.execPath, [cli, 'telemetry', 'status', '--json'], {
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '', XDG_CONFIG_HOME: configHome, RCL_DATA_DIR: dataDir },
  });

  const status = JSON.parse(stdout) as { credential: { source: string; host: string }; outbox: { dir: string } };
  expect(status.credential).toEqual({ source: 'login', host: 'harness.example.test' });
  expect(status.outbox.dir).toBe(join(dataDir, 'outbox'));
});
