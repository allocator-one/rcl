import { createHash } from 'node:crypto';
import type { ClaimDescriptor } from '../../../src/evidence/claim-recovery/validation/claims.js';

export const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
export const descriptor: ClaimDescriptor = {
  version: 1, operation: 'cache.ts :: cache.read',
  invariant: 'The cache returns expired entries without checking their expiry timestamp.',
  evidence: ['Check the expiry timestamp before returning a cached result.'],
};
