import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';

type VitestProject = {
  onTestsRerun(callback: () => Promise<void>): void;
};

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

export const shouldBuildCli = (env: NodeJS.ProcessEnv = process.env): boolean => !env['RCL_TEST_PACKAGED_CLI'];

const require = createRequire(import.meta.url);
export const typescriptBin = (): string => require.resolve('typescript/bin/tsc');

async function buildCli(): Promise<void> {
  if (!shouldBuildCli()) return;
  await exec(process.execPath, [typescriptBin()], { cwd: root, timeout: 30_000 });
}

export async function setup(project: VitestProject): Promise<void> {
  await buildCli();
  project.onTestsRerun(buildCli);
}
