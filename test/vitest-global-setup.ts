import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

type VitestProject = {
  onTestsRerun(callback: () => Promise<void>): void;
};

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function buildCli(): Promise<void> {
  await exec(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], { cwd: root, timeout: 30_000 });
}

export async function setup(project: VitestProject): Promise<void> {
  await buildCli();
  project.onTestsRerun(buildCli);
}
