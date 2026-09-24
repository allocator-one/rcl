import type { CurrentClaimProjection } from './current-projection.js';
import { isDeepStrictEqual } from 'node:util';
import { packRecoveryMaterial,unpackRecoveryMaterial,type RecoveryMaterial } from './materials.js';
import { occurrencePendingIdentities,type NativeOccurrenceEvidence } from './native-occurrences.js';
export interface NativeMaterialReference {
  version: 1;
  rootSha256: string;
  sha256s: string[];
  pendingIdentities: string[];
  current?: {
    nativeFingerprint: string;
    actionableIdentities: string[];
    readWindow: CurrentClaimProjection['history']['readWindow'];
  };
}
export interface NativeMaterialContent {
  occurrences?: NativeOccurrenceEvidence;
  currentProjection?: CurrentClaimProjection;
}
export function packNativeMaterial(content: NativeMaterialContent): {
  reference: NativeMaterialReference;
  materials: RecoveryMaterial[];
} {
  const packed=packRecoveryMaterial(content);
  return {
    reference: {
      version: 1,rootSha256: packed.rootSha256,sha256s: packed.materials.map(m => m.sha256).sort(),
      pendingIdentities: [...new Set(occurrencePendingIdentities(content.occurrences))].sort(),
      ...(content.currentProjection? { current: { nativeFingerprint: content.currentProjection.nativeFingerprint,actionableIdentities: content.currentProjection.actionableIdentities,readWindow: content.currentProjection.history.readWindow } }:{})
    },materials: packed.materials
  };
}
export function nativeMaterial(reference: NativeMaterialReference,materials: readonly RecoveryMaterial[]): NativeMaterialContent {
  if(reference?.version!==1||!Array.isArray(reference.sha256s)||new Set(reference.sha256s).size!==reference.sha256s.length||
    !reference.sha256s.includes(reference.rootSha256))
    throw new Error('native_recovery_material_conflict');
  const rows=reference.sha256s.map(sha => {
    const found=materials.filter(m => m.sha256===sha); if(found.length!==1)
      throw new Error('native_recovery_material_unavailable'); return found[0]!;
  });
  const content=unpackRecoveryMaterial(reference.rootSha256,rows) as NativeMaterialContent;
  if(content.currentProjection&&!([1,2] as unknown[]).includes(content.currentProjection.version)||
    !isDeepStrictEqual(packNativeMaterial(content).reference,reference))
    throw new Error('native_recovery_material_conflict');
  return content;
}
export function operationOccurrences(operation: {
  occurrences?: NativeOccurrenceEvidence;
  material?: NativeMaterialReference;
},materials: readonly RecoveryMaterial[]): NativeOccurrenceEvidence|undefined {
  if(operation.material&&operation.occurrences)
    throw new Error('native_recovery_material_conflict');
  return operation.material? nativeMaterial(operation.material,materials).occurrences:operation.occurrences;
}
