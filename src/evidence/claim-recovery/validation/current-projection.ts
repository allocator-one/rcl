import type { ClaimHistoryContent } from '../carrier-inventory.js';
import type { OccurrenceCarrierProjection } from './carrier-types.js';

export interface CurrentClaimProjection {
  version: 1|2;
  nativeFingerprint: string;
  history: ClaimHistoryContent;
  actionableIdentities: string[];
  carriers: OccurrenceCarrierProjection[];
  claims: Array<{
    identity: string;
    standing: 'pending'|'dismissed'|'confirmed-fixed'|'nongating';
    dispositionEventId: string|null;
    reasons: string[];
  }>;
  residuals: Array<{
    reason: string;
    runId?: string;
    round?: number;
  }>;
}
