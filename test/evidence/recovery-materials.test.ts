import { describe,expect,it } from 'vitest';
import { chmod,mkdtemp,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaimProof,writeClaimProof } from '../../src/evidence/claim-recovery/proof-storage.js';
import { packRecoveryMaterial,unpackRecoveryMaterial } from '../../src/evidence/claim-recovery/validation/materials.js';
import { decodeRecoveryDocument } from '../../src/evidence/original-run/decode.js';
import { sha } from './recovery-validation/fixtures.js';
describe('immutable content-addressed recovery material',() => {
  it('retains exact repeated original strings once and reconstructs the full proof',() => {
    const raw='{"original":"'+'x'.repeat(10000)+'"}\n';
    const value={ source: raw,transfers: Array.from({ length: 25 },() => ({ report: raw,source: raw })) };
    const packed=packRecoveryMaterial(value);
    expect(packed.materials.filter(m => m.sha256===sha(raw))).toHaveLength(1);
    expect(packed.materials.reduce((n,m) => n+Buffer.byteLength(m.text),0)).toBeLessThan(30000);
    expect(unpackRecoveryMaterial(packed.rootSha256,packed.materials)).toEqual(value);
  });

  it('preserves large unpaired UTF-16 units through actual claim-proof disk storage',async () => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-material-'));
    try {
      const value={ high:'x'.repeat(2048)+String.fromCharCode(0xD800),low:'x'.repeat(2048)+String.fromCharCode(0xDC00),replacement:'x'.repeat(2048)+'�',pair:'x'.repeat(2048)+'😀' };
      const packed=packRecoveryMaterial(value);
      expect(packed.materials.some(row => row.text===value.pair)).toBe(true);
      expect(packed.materials.some(row => row.text===value.high||row.text===value.low)).toBe(false);
      await writeClaimProof(join(dir,'proof.json'),join(dir,'pool'),value);
      expect(await readClaimProof(join(dir,'proof.json'),join(dir,'pool'))).toEqual(value);
    } finally { await rm(dir,{ recursive:true,force:true }); }
  });
  it('factors deeply nested objects and arrays into parser-safe material for disk round trips',async () => {
    const dir=await mkdtemp(join(tmpdir(),'rcl-material-depth-'));
    let mixed: unknown='x'.repeat(2_048);
    for(let depth=0;depth<100;depth++)
      mixed=depth%2===0 ? { child: mixed } : [mixed];
    let boundary: unknown='y'.repeat(2_048);
    for(let depth=0;depth<128;depth++) boundary={ child: boundary };
    try {
      for(const [name,value] of [['mixed',mixed],['boundary',boundary]] as const) {
        const packed=packRecoveryMaterial(value);
        expect(packed.materials.length).toBeGreaterThan(1);
        expect(() => packed.materials.filter(material => material.text.startsWith('[')).forEach(material => decodeRecoveryDocument(material.text))).not.toThrow();
        expect(unpackRecoveryMaterial(packed.rootSha256,packed.materials)).toEqual(value);
        const path=join(dir,`${name}.json`);
        await writeClaimProof(path,join(dir,'pool'),value);
        expect(await readClaimProof(path,join(dir,'pool'))).toEqual(value);
      }
    } finally { await rm(dir,{ recursive:true,force:true }); }
  });
  it.each(['missing','mutated','duplicate','unknown-tag','forged-cycle'])('refuses %s referenced material',kind => {
    const packed=packRecoveryMaterial({ text: 'x'.repeat(5000) });
    let root=packed.rootSha256;
    if(kind==='missing')
      packed.materials.splice(0,1);
    if(kind==='mutated')
      packed.materials[0]!.text+='x';
    if(kind==='duplicate')
      packed.materials.push(packed.materials[0]!);
    if(kind==='unknown-tag') {
      const text='[9,"unsupported"]';
      root=sha(text);
      packed.materials.push({ sha256: root,text });
    }
    if(kind==='forged-cycle') {
      // A valid content-addressed cycle would require a SHA-256 fixed point.
      // A forged recursive reference therefore fails at digest validation.
      const text='[4,"'+root+'"]';
      root=sha(text);
      packed.materials.push({ sha256: root,text });
      packed.materials[0]!.text='changed';
    }
    expect(() => unpackRecoveryMaterial(root,packed.materials)).toThrow('recovery_material_conflict');
  });
  it('does not mistake original object keys or marker-shaped arrays for references',() => {
    const value={ '$rcl_material_sha256': 'a'.repeat(64),x: [3,'a'.repeat(64)] };
    const p=packRecoveryMaterial(value);
    expect(unpackRecoveryMaterial(p.rootSha256,p.materials)).toEqual(value);
  });
});

it('allows concurrent identical proof writers to share content-addressed material', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-material-concurrent-'));
  const pool = join(dir, 'pool');
  const value = { original: 'x'.repeat(64_000), rows: Array.from({ length: 32 }, (_, sequence) => ({ sequence })) };
  try {
    const paths = Array.from({ length: 8 }, (_, index) => join(dir, `proof-${index}.json`));
    await Promise.all(paths.map(path => writeClaimProof(path, pool, value)));
    await expect(Promise.all(paths.map(path => readClaimProof(path, pool)))).resolves.toEqual(paths.map(() => value));
    expect((await readdir(pool)).every(name => !name.endsWith('.tmp'))).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('refuses to read a proof document from a non-private recovery root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-material-permissions-'));
  const path = join(dir, 'proof.json');
  const pool = join(dir, 'pool');
  try {
    await writeClaimProof(path, pool, { original: 'retained' });
    await chmod(dir, 0o755);
    await expect(readClaimProof(path, pool)).rejects.toThrow('unsafe_recovery_lock_root');
  } finally {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
});

it('bounds unique retained bytes without recursively copying a prior proof pool into later proofs',() => {
  const original='x'.repeat(1024*1024);
  const first=packRecoveryMaterial({ original,rows: Array.from({ length: 10 },() => ({ original })) });
  const value={ previous: first.materials,proofs: Array.from({ length: 80 },() => ({ report: original,previous: first.materials })) };
  const packed=packRecoveryMaterial(value);
  expect(packed.materials.reduce((n,m) => n+Buffer.byteLength(m.text),0)).toBeLessThan(2*1024*1024);
  const restored=unpackRecoveryMaterial(packed.rootSha256,packed.materials) as typeof value;
  expect(restored.previous).toEqual(first.materials);
  expect(restored.proofs).toHaveLength(80);
  expect(restored.proofs.every(p => p.report===original&&p.previous[0]?.sha256===first.materials[0]?.sha256)).toBe(true);
});

it('refuses inline scalar expansion that the reader cannot reconstruct', () => {
  const group = Array(1_000).fill('x'.repeat(500));
  const value = Array(140).fill(group);
  expect(() => packRecoveryMaterial(value)).toThrow('recovery_material_conflict');
});

it('refuses repeated size-factored object keys that the reader cannot reconstruct', () => {
  const key = 'k'.repeat(20_000);
  const value = Array(3_400).fill({ [key]: null });
  expect(() => packRecoveryMaterial(value)).toThrow('recovery_material_conflict');
});

it('normalizes array holes as null material values', () => {
  const packed = packRecoveryMaterial(new Array(2));
  expect(unpackRecoveryMaterial(packed.rootSha256, packed.materials)).toEqual([null, null]);
});

it('refuses oversized sparse arrays before allocating tagged child nodes', () => {
  expect(() => packRecoveryMaterial(new Array(500_000))).toThrow('recovery_material_conflict');
});

it('refuses more unique retained materials than the reader can reconstruct', () => {
  const value = Array.from({ length: 20_001 }, (_, index) => `${String(index).padStart(5, '0')}:${'x'.repeat(1_020)}`);
  expect(() => packRecoveryMaterial(value)).toThrow('recovery_material_conflict');
});

it('refuses a proof whose reference nodes exceed the reader budget before publishing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-material-budget-'));
  try {
    const value = Array(499_999).fill(0);
    await expect(writeClaimProof(join(dir, 'proof.json'), join(dir, 'pool'), value))
      .rejects.toThrow('recovery_material_conflict');
    expect(await readdir(dir)).toEqual(['pool']);
    expect(await readdir(join(dir, 'pool'))).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('round-trips material at the reader node budget including the root reference', () => {
  const value = Array(499_998).fill(0);
  const packed = packRecoveryMaterial(value);
  expect(packed.materials).toHaveLength(2);
  expect(unpackRecoveryMaterial(packed.rootSha256, packed.materials)).toEqual(value);
});

it('includes retained subtree indirections in the reader depth budget', () => {
  let value: unknown = String.fromCharCode(0xD800).repeat(3_000);
  for (let depth = 0; depth < 128; depth++) value = [value, ...Array(17).fill('x'.repeat(1_000))];
  expect(() => packRecoveryMaterial(value)).toThrow('recovery_material_conflict');
});

it('round-trips all 256 decoder levels when every parent is retained', () => {
  let value: unknown = 'leaf';
  for (let depth = 0; depth < 128; depth++) value = [value, ...Array(17).fill('x'.repeat(1_000))];
  const packed = packRecoveryMaterial(value);
  expect(unpackRecoveryMaterial(packed.rootSha256, packed.materials)).toEqual(value);
});

it('refuses an unsafe numeric binding before it can publish unreadable material', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-material-number-'));
  try {
    await expect(writeClaimProof(join(dir, 'proof.json'), join(dir, 'pool'), { sequence: Number.MAX_SAFE_INTEGER + 1 }))
      .rejects.toThrow('recovery_material_conflict');
    expect(await readdir(dir)).toEqual(['pool']);
    expect(await readdir(join(dir, 'pool'))).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('refuses negative zero material before a scalar or nested proof can be published', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-material-negative-zero-'));
  try {
    expect(() => packRecoveryMaterial(-0)).toThrow('recovery_material_conflict');
    await expect(writeClaimProof(join(dir, 'proof.json'), join(dir, 'pool'), { nested: -0 }))
      .rejects.toThrow('recovery_material_conflict');
    expect(await readdir(dir)).toEqual(['pool']);
    expect(await readdir(join(dir, 'pool'))).toEqual([]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
