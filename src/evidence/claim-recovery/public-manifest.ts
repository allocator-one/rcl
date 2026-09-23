import { z } from 'zod';
import { uuidSchema } from '../original-run/source.js';
import { publicClaimSelectionSchema } from './public-model.js';
import type { RecoveryMaterial } from './validation/materials.js';
import type { ClaimHistoryContent } from './carrier-inventory.js';
import type { ClaimSplitInput } from '../claim-split.js';
import type { ObligationTransferInput,ClaimDispositionInput } from './validation/occurrence-types.js';
import type { StoredEventReceipt,EventReceiptScope } from '../event-receipts.js';
export type Preparation=ClaimSplitInput|ObligationTransferInput|ClaimDispositionInput;
export interface AdoptedStage {
  validationStage: Manifest['stages'][number];
  id: string; preparation: Preparation; eventJson: string; receipt: StoredEventReceipt;
  history: ClaimHistoryContent; createdAt: string;
}
export interface ClaimAdoption {
  version: 1; depth: number; previousManifest: string; previousManifestSha256: string;
  pins: Array<{path:string;sha256:string|null}>;
  proofRoots: Array<{path:string;pool:string}>;
  accepted: AdoptedStage[];
  replacements: Array<{oldId:string;newId:string;scope:EventReceiptScope}>;
}
export const manifestSchema=z.object({
  kind: z.literal('rcl-public-claim-recovery'),version: z.union([z.literal(2),z.literal(3)]),operationId: uuidSchema,
  createdAt: z.string(),rclVersion: z.string(),gitCommonDir: z.string(),selection: publicClaimSelectionSchema,
  actorUserId: uuidSchema,materialSha256: z.string().regex(/^[a-f0-9]{64}$/),nativeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stages: z.array(z.object({ id: uuidSchema,kind: z.enum(['split','transfer','disposition']),carrierIndex: z.number().int().nonnegative().optional() }).strict()).max(2002),
  preview: z.unknown(),
}).strict();
export type Manifest=z.infer<typeof manifestSchema>;
export interface Material {
  adoption?: ClaimAdoption;
  recoveryMaterials: RecoveryMaterial[];
  nativeJson: string;
  nativeSourceJsons: string[];
  history: ClaimHistoryContent;
}
