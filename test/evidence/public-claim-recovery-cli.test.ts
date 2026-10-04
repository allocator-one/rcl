import { afterEach,expect,it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dirs: string[]=[];
afterEach(() => {
  for(const path of dirs.splice(0))
    rmSync(path,{ recursive: true,force: true });
});
it('built CLI exposes the public preview/apply/resume recovery route without starting telemetry',() => {
  const cwd=mkdtempSync(join(tmpdir(),'rcl-public-claim-'));
  dirs.push(cwd);
  const entry=process.env.RCL_TEST_PACKAGED_CLI??fileURLToPath(new URL('../../dist/index.js',import.meta.url));
  const env={ PATH: process.env.PATH,HOME: cwd,XDG_CONFIG_HOME: join(cwd,'config'),RCL_DATA_DIR: join(cwd,'data'),RCL_NO_HARNESS_KEYS: '1' };
  const result=spawnSync(process.execPath,[entry,'evidence','recover-claim','--help'],{ cwd,env,encoding: 'utf8',timeout: 15000 });
  expect(result.status).toBe(0);
  for(const option of ['--preview','--apply','--resume','--selection','--manifest','--manifest-sha256','--adopt-manifest','--adopt-manifest-sha256'])
    expect(result.stdout).toContain(option);
  expect(result.stdout).toContain('same target');
  expect(result.stderr).toBe('');
});
