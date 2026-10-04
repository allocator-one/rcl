import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadConvergeRunStateEvidence, convergeRunStatePath } from '../../src/converge/run-state.js';
import { readOrdinaryNativeFile, readStable } from '../../src/telemetry/recovery/files.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function malformed(version: number) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'native-byte-contract-')));roots.push(root);
  const target='native-byte-contract',path=convergeRunStatePath(root,target);
  const source=JSON.stringify({version,target,roundCap:15,rounds:[],findings:{},updatedAt:'INVALID_BYTE',...(version===1?{}:{sightings:[]})});
  const [before,after]=source.split('INVALID_BYTE');const raw=Buffer.concat([Buffer.from(before!),Buffer.from([0xff]),Buffer.from(after!)]);
  await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,raw);
  return {root,target,path,raw};
}
it('preserves legacy replacement decoding and hashes original bytes while strict recovery refuses them',async()=>{
  const f=await malformed(1),before=await readFile(f.path);
  const ordinary=await readOrdinaryNativeFile(f.path);
  expect(ordinary.raw).toEqual(f.raw);
  expect(ordinary.sha256).toBe(createHash('sha256').update(f.raw).digest('hex'));
  expect(ordinary.text).toBe(f.raw.toString('utf8'));
  await expect(loadConvergeRunStateEvidence(f.root,f.target)).resolves.toMatchObject({sha256:ordinary.sha256});
  await expect(readStable(f.path)).rejects.toThrow('invalid_utf8');
  expect(await readFile(f.path)).toEqual(before);
});
it.each([2,3])('does not grant semantic or recovered v%s authority through lossy decoding',async version=>{
  const f=await malformed(version);
  await expect(loadConvergeRunStateEvidence(f.root,f.target)).rejects.toThrow('invalid_utf8');
  expect(await readFile(f.path)).toEqual(f.raw);
});
