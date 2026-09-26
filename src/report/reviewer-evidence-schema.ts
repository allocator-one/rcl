import { z } from 'zod';

/**
 * Dependency-leaf wire schema shared by report inspection and transport
 * validation. Keep this module free of report, checkpoint and telemetry
 * imports so ordinary envelope validation cannot initialize a recovery cycle.
 */
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
export const reviewerEvidenceSourceSchema = z.object({
  run_id: uuid,
  report_sha256: hash,
  checkpoint_sha256: hash,
}).strict();

const common = {
  version: z.literal(1),
  checkpoint_schema: z.literal(1),
  plan_sha256: hash,
  checkpoint_sha256: hash,
  captured_inputs_sha256: hash,
  aggregation_sha256: hash.optional(),
  supplemental_async_sha256: hash.optional(),
  policy: z.object({ version: z.literal(1), fraction: z.number().min(2 / 3).max(1) }).strict(),
};

export const reviewerEvidenceDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('original'), launch_sha256: hash.optional() }).strict(),
  z.object({ ...common, kind: z.literal('supplemented'), source: reviewerEvidenceSourceSchema, operation_id: uuid }).strict(),
]);

export type ReviewerEvidenceDescriptor = z.infer<typeof reviewerEvidenceDescriptorSchema>;
export type ReviewerEvidenceSource = z.infer<typeof reviewerEvidenceSourceSchema>;
