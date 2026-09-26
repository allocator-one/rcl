import { z } from 'zod';

const uuid = z.string().uuid();
const counter = z.number().int().nonnegative().safe();
export const reviewCycleReceiptSchema = z.object({
  id: uuid, operation_id: uuid, previous_cycle_id: uuid.nullable(),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/), inserted_at: z.string().datetime({ offset: true }),
}).strict();
export type ReviewCycleReceipt = z.infer<typeof reviewCycleReceiptSchema>;
export interface ReviewCycleRequest {
  operation_id: string;
  previous_cycle_id: string | null;
  head_sha: string;
}
/** The HTTP implementation must negotiate cycle_protocol before returning current membership. */
export interface ReviewCycleRemote {
  readonly repo: string;
  readonly prNumber: number;
  readonly url: string;
  current(): Promise<ReviewCycleReceipt | null>;
  start(request: ReviewCycleRequest): Promise<ReviewCycleReceipt>;
}

export const cycleHistorySchema = z.object({
  attempts: counter, rounds: counter,
  /** Known lower bounds, never a claim that missing historical accounting was zero. */
  incomplete: z.literal(true).optional(),
}).strict();
export const nativeReviewCycleSchema = z.object({
  id: uuid, operationId: uuid, previousCycleId: uuid.nullable(),
  repo: z.string().min(1), prNumber: z.number().int().positive().safe(), url: z.string().url(),
  archivePath: z.string().min(1), archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  history: cycleHistorySchema,
}).strict();
export type NativeReviewCycle = z.infer<typeof nativeReviewCycleSchema>;

/** Version upgrades are explicit barriers: legacy state must never hide fresh-cycle fields. */
export function validCycleVersion(value: { version?: unknown; cycle?: unknown; startOverPending?: unknown }, legacy: number): boolean {
  if (value.startOverPending !== undefined) return false;
  return value.version === legacy ? value.cycle === undefined
    : value.version === legacy + 1 && nativeReviewCycleSchema.safeParse(value.cycle).success;
}
