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

let building: Promise<void> | undefined;
let buildRequested = false;
async function buildCli(): Promise<void> {
  if (!shouldBuildCli()) return;
  buildRequested = true;
  // Vitest can enter another rerun hook before the first hook finishes. Keep
  // all callers waiting until changes received during compilation are built.
  building ??= (async () => {
    while (buildRequested) {
      buildRequested = false;
      await exec(process.execPath, [typescriptBin()], { cwd: root, timeout: 30_000 });
    }
  })().finally(() => { building = undefined; });
  await building;
}

export async function setup(project: VitestProject): Promise<void> {
  await buildCli();
  project.onTestsRerun(buildCli);
}
