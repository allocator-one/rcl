import { mkdir,lstat,link,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { decodeRecoveryDocument } from '../original-run/decode.js';
import { inspectRecoveryDirectory } from '../original-run/lock-path.js';
import { serializeRecoveryDocument,writeExclusiveBytes,syncDirectory,MAX_RECOVERY_DOCUMENT_BYTES } from '../original-run/journal.js';
import { readStable,writeRecoveryArtifact } from '../../telemetry/recovery/files.js';
import { packRecoveryMaterial,unpackRecoveryMaterial } from './validation/materials.js';
const MAX=64*1024*1024;
/** Immutable document roots share exact content-addressed bytes in this one
 * operation. UUID/payload journals remain separate; a root is not authority. */
export async function writeClaimProof(path: string,pool: string,value: unknown): Promise<void> {
  await inspectRecoveryDirectory(dirname(pool),true);
  try {
    await mkdir(pool,{ mode: 0o700 });
    await syncDirectory(dirname(pool));
  }
  catch(e) {
    if((e as NodeJS.ErrnoException).code!=='EEXIST')
      throw e;
  }
  await inspectRecoveryDirectory(pool,true);
  const packed=packRecoveryMaterial(value);
  for(const row of packed.materials) {
    const destination=join(pool,row.sha256);
    let exists=false;
    try {
      await lstat(destination);
      exists=true;
    }
    catch(e) {
      if((e as NodeJS.ErrnoException).code!=='ENOENT')
        throw e;
    }
    if(exists) {
      const current=await readStable(destination,MAX);
      if(current.sha256!==row.sha256||current.text!==row.text)
        throw new Error('claim_proof_material_conflict');
    }
    else {
      const temporary=join(pool,randomUUID()+'.tmp');
      try {
        await writeExclusiveBytes(temporary,Buffer.from(row.text,'utf8'));
        try {
          await link(temporary,destination);
        }
        catch(e) {
          if((e as NodeJS.ErrnoException).code!=='EEXIST')
            throw e;
          const current=await readStable(destination,MAX);
          if(current.sha256!==row.sha256||current.text!==row.text)
            throw new Error('claim_proof_material_conflict');
        }
      }
      finally {
        try {
          await unlink(temporary);
        }
        catch(e) {
          if((e as NodeJS.ErrnoException).code!=='ENOENT')
            throw e;
        }
      }
    }
  }
  await syncDirectory(pool);
  const root={ kind: 'rcl-claim-proof',version: 1,rootSha256: packed.rootSha256,sha256s: packed.materials.map(m => m.sha256).sort() };
  serializeRecoveryDocument(root,MAX_RECOVERY_DOCUMENT_BYTES);
  await inspectRecoveryDirectory(dirname(path),true);
  await writeRecoveryArtifact(path,root);
  await syncDirectory(dirname(path));
}
/** All references are re-read and hashed; missing or mutated bytes refuse even
 * when the small root and its manifest digest still match. */
export async function readClaimProof(path: string,pool: string): Promise<unknown> {
  await inspectRecoveryDirectory(dirname(path),true);
  await inspectRecoveryDirectory(pool,true);
  const root=decodeRecoveryDocument((await readStable(path,MAX_RECOVERY_DOCUMENT_BYTES)).text) as Record<string,unknown>;
  if(!root||root.kind!=='rcl-claim-proof'||root.version!==1||typeof root.rootSha256!=='string'||!Array.isArray(root.sha256s)||
    root.sha256s.length>20000||!root.sha256s.includes(root.rootSha256)||!isDeepStrictEqual(root.sha256s,[...new Set(root.sha256s)].sort())||
    !isDeepStrictEqual(Object.keys(root).sort(),['kind','rootSha256','sha256s','version']))
    throw new Error('claim_proof_reference_conflict');
  let bytes=0;
  const rows=[];
  for(const sha of root.sha256s) {
    if(typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha))
      throw new Error('claim_proof_reference_conflict');
    const raw=await readStable(join(pool,sha),MAX);
    bytes+=Buffer.byteLength(raw.text);
    if(raw.sha256!==sha||bytes>MAX)
      throw new Error('claim_proof_material_conflict');
    rows.push({ sha256: sha,text: raw.text });
  }
  return unpackRecoveryMaterial(root.rootSha256,rows);
}
