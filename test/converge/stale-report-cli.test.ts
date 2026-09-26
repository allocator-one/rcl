import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleFixture } from './stale-report-fixtures.js';
import { sha256 } from '../../src/telemetry/recovery/files.js';

// The same test can target an unpacked npm artifact, with no TS loader.
const packed = process.env.RCL_STALE_PACKED_CLI;
const cli = packed ?? fileURLToPath(new URL('../../src/index.ts',import.meta.url));
async function command(cwd:string,args:string[],denyNetwork:string) {
  const inherited = Object.fromEntries(['PATH','HOME','USERPROFILE','TMPDIR','TMP','TEMP','SystemRoot','WINDIR','ComSpec','PATHEXT']
    .flatMap(key => process.env[key] === undefined ? [] : [[key,process.env[key]!]]));
  const child = spawn(process.execPath,[...(packed?[]:['--import',import.meta.resolve('tsx')]),'--import',denyNetwork,cli,...args],{
    cwd,env:{...inherited,NODE_NO_WARNINGS:'1',NO_COLOR:'1',RCL_TELEMETRY:'off',RCL_DATA_DIR:join(cwd,'data'),XDG_CONFIG_HOME:join(cwd,'config'),
      GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:devNull,TSX_DISABLE_CACHE:'1'},timeout:20000,
  });
  let stdout='',stderr=''; child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c);
  const code = await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  return {code,stdout,stderr};
}

it('previews, applies, resumes and rejects tampering through the supported CLI without network calls', async () => {
  const f = await staleFixture(true), before = await f.bytes();
  const deny = join(f.cwd,'deny-network.mjs');
  await writeFile(deny,`import net from 'node:net';\nnet.Socket.prototype.connect = function(){throw Error('network forbidden');};\nglobalThis.fetch = async()=>{throw Error('network forbidden');};\n`);
  await mkdir(join(f.cwd,'config'));
  const help = await command(f.cwd,['converge-stale','--help'],deny);
  expect(help.code,help.stderr).toBe(0); expect(help.stdout).toContain('--manifest-sha256');
  const preview = await command(f.cwd,['converge-stale','--preview','--manifest',f.manifestPath,'--target',f.target,
    '--head',f.selection.headSha,'--input-sha256',f.selection.inputSha256,'--report',f.reportPath,
    '--report-sha256',f.reportSha256,'--reason',f.selection.reason],deny);
  expect(preview.code,preview.stderr).toBe(0); expect(await f.bytes()).toEqual(before);
  const digest = sha256(await readFile(f.manifestPath)); expect(JSON.parse(preview.stdout).manifestSha256).toBe(digest);
  const bad = await command(f.cwd,['converge-stale','--apply','--manifest',f.manifestPath,'--manifest-sha256','f'.repeat(64)],deny);
  expect(bad.code).toBe(3); expect(JSON.parse(bad.stderr).error.message).toBe('stale_report_digest_mismatch');
  expect(await f.bytes()).toEqual(before);
  for (const mode of ['apply','resume']) {
    const result = await command(f.cwd,['converge-stale',`--${mode}`,'--manifest',f.manifestPath,'--manifest-sha256',digest],deny);
    expect(result.code,result.stderr).toBe(0); expect(JSON.parse(result.stdout).result).toBe(mode==='apply'?'applied':'resumed');
  }
  expect((await f.bytes()).slice(1)).toEqual(before.slice(1));
},30000);


it.each([
  {args:[],message:'choose_exactly_one_stale_report_mode'},
  {args:['--preview','--apply'],message:'choose_exactly_one_stale_report_mode'},
  {args:['--preview','--manifest-sha256','a'.repeat(64)],message:'preview_does_not_accept_manifest_digest'},
  {args:['--preview'],message:'stale_report_preview_arguments_required'},
  {args:['--apply','--manifest-sha256','a'.repeat(64),'--target','other'],message:'apply_uses_only_pinned_manifest'},
  {args:['--apply'],message:'manifestSha256'},
  {args:['--resume'],message:'manifestSha256'},
])('rejects invalid disposition arguments $args without touching evidence', async ({args,message}) => {
  const f = await staleFixture(true), before = await f.bytes();
  const deny = join(f.cwd,'deny-network.mjs');
  await writeFile(deny,`import net from 'node:net';\nnet.Socket.prototype.connect = function(){throw Error('network forbidden');};\nglobalThis.fetch = async()=>{throw Error('network forbidden');};\n`);
  const result = await command(f.cwd,['converge-stale','--manifest',f.manifestPath,...args],deny);
  expect(result.code,result.stderr).toBe(3);
  const error = JSON.parse(result.stderr).error;
  expect(error.code).toBe('RCL_CONVERGE_STALE'); expect(error.message).toContain(message);
  expect(await f.bytes()).toEqual(before);
  await expect(readFile(f.manifestPath)).rejects.toMatchObject({code:'ENOENT'});
},30000);
