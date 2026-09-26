import type { CurrentClaimProjection } from './current-projection.js';
import type { NativeOccurrenceEvidence } from './native-occurrences.js';

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
