import { describe,expect,it } from 'vitest';
import { packRecoveryMaterial,unpackRecoveryMaterial } from '../../src/evidence/claim-recovery/validation/materials.js';
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
  it.each(['missing','mutated','duplicate','unknown-tag','cycle'])('refuses %s referenced material',kind => {
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
    if(kind==='cycle') {
      const text='[4,"'+root+'"]';
      root=sha(text);
      packed.materials.push({ sha256: root,text });
      packed.materials[0]!.text='changed';
    }
    expect(() => unpackRecoveryMaterial(root,packed.materials)).toThrow();
  });
  it('does not mistake original object keys or marker-shaped arrays for references',() => {
    const value={ '$rcl_material_sha256': 'a'.repeat(64),x: [3,'a'.repeat(64)] };
    const p=packRecoveryMaterial(value);
    expect(unpackRecoveryMaterial(p.rootSha256,p.materials)).toEqual(value);
  });
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
