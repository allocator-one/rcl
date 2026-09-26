import { z } from 'zod';

/** Local predecessor evidence only; it conveys no review or attestation authority. */
export const recoverySourceSchema = z.object({
  version: z.literal(1),
  native_sha256: z.string().length(64).regex(/^[a-f0-9]{64}(?![\s\S])/),
}).strict();
export type RecoverySource = z.infer<typeof recoverySourceSchema>;
