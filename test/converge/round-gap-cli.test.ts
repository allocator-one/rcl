import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, cleanup } from './round-gap-fixtures.js';
import { Outbox } from '../../src/telemetry/outbox.js';
import { buildEvent } from '../../src/telemetry/events.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';
afterEach(cleanup);
const cli = fileURLToPath(new URL('../../src/index.ts',import.meta.url));
async function command(cwd:string,args:string[],env:NodeJS.ProcessEnv) {
  const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),cli,...args],{
    cwd,timeout:10_000,killSignal:'SIGKILL',
    env:{...process.env,...env,TSX_DISABLE_CACHE:'1',NO_COLOR:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:devNull},
  });
  let stdout='',stderr=''; child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  return {code,stdout,stderr};
}
async function snapshot(dir:string):Promise<Record<string,string>> {
  const result:Record<string,string>={};
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    if(entry.isDirectory()) Object.assign(result,await snapshot(path)); else result[path]=sha256(await readFile(path));
  }
  return result;
}

it('never flushes unrelated outbox entries even when gap input is invalid', async () => {
  const f=await fixture(true), data=join(f.cwd,'data'), config=join(f.cwd,'config');
  await mkdir(config); await mkdir(join(f.cwd,'.harness-cli')); await writeFile(join(f.cwd,'.harness-cli','config.json'),JSON.stringify({team:'RCL'}));
  await new Outbox(join(data,'outbox')).spoolEvents([buildEvent({kind:'attempt_claimed',convergeTarget:'unrelated',attempt:1,payload:{cap:20}})]);
  const before=await snapshot(data); const requests:string[]=[];
  const server=createServer((req,res)=>{requests.push(`${req.method} ${req.url}`);req.resume();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{inserted:1,duplicates:0}}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address(); if(!address||typeof address==='string') throw new Error('local server required');
    const result=await command(f.cwd,['converge-gap','--preview','--manifest',f.manifestPath],{RCL_DATA_DIR:data,XDG_CONFIG_HOME:config,RCL_TELEMETRY:'full',HARNESS_API_TOKEN:'aone_SYNTHETIC_LOCAL_ONLY',HARNESS_API_URL:`http://127.0.0.1:${address.port}`});
    expect(result.code,result.stderr).toBe(3); expect(requests).toEqual([]); expect(await snapshot(data)).toEqual(before);
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
},15000);

it('previews, applies and resumes a digest-qualified manifest through the actual CLI', async () => {
  const f=await fixture(true), before=await readFile(f.statePath), attempts=await readFile(f.attemptPath);
  const env={RCL_TELEMETRY:'off',RCL_DATA_DIR:join(f.cwd,'data'),XDG_CONFIG_HOME:join(f.cwd,'config')};
  const preview=await command(f.cwd,['converge-gap','--preview','--manifest',f.manifestPath,'--target',f.target,'--gap-round','2','--admitting-round','3','--attempt','2','--run',f.input.runId,'--report',f.input.reportPath,'--report-sha256',f.input.reportSha256,'--incomplete',f.input.incompletePath,'--incomplete-sha256',f.input.incompleteSha256],env);
  expect(preview.code,preview.stderr).toBe(0); const expected=sha256(await readFile(f.manifestPath)); expect(JSON.parse(preview.stdout).manifestSha256).toBe(expected);
  expect(await readFile(f.statePath)).toEqual(before); expect(await readFile(f.attemptPath)).toEqual(attempts);
  for(const mode of ['apply','resume']) {
    const result=await command(f.cwd,['converge-gap',`--${mode}`,'--manifest',f.manifestPath,'--manifest-sha256',expected],env);
    expect(result.code,result.stderr).toBe(0); expect(JSON.parse(result.stdout).result).toBe(mode==='apply'?'applied':'resumed');
  }
  expect((await loadConvergeRunState(f.dir,f.target))?.rounds.map(r=>r.round)).toEqual([1]); expect(await readFile(f.attemptPath)).toEqual(attempts);
},15000);

it('passes the actual original report digest to ordinary native admission', async () => {
  const f=await fixture(true); await f.prepare(); await f.apply();
  const result=await command(f.cwd,['converge-report','--target',f.target,'--report',f.input.reportPath,'--round','3','--json'],{RCL_TELEMETRY:'off',RCL_DATA_DIR:join(f.cwd,'data'),XDG_CONFIG_HOME:join(f.cwd,'config')});
  expect(result.code,result.stderr).toBe(0);
  expect((await loadConvergeRunState(f.dir,f.target))?.rounds.map(r=>r.round)).toEqual([1,3]);
},15000);
