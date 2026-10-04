import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { reviewerHealthSchema, strongDeliveryReconciliationSchema } from './launch-record.js';
import { decodeRecoveryDocument } from '../evidence/original-run/decode.js';
import { serializeRecoveryDocument } from '../evidence/original-run/journal.js';
import { sha256 } from '../telemetry/recovery/files.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const uuid = z.string().uuid();

export const historicalServerProjectionSchema = z.object({
  origin: z.string().url(),
  runId: uuid,
  provenance: z.literal('live'),
  receivedAt: z.string().datetime({ offset: true }),
  cycleId: uuid,
  repoVerified: z.literal(true),
  isCrossRepository: z.literal(false),
  headVerified: z.string().min(1),
  target: z.object({
    kind: z.enum(['pr', 'patch']),
    repo: z.string().min(1),
    prNumber: z.number().int().positive().safe(),
    headSha: commit,
    baseSha: commit,
    diffSha256: digest,
  }).strict(),
  converge: z.object({
    target: z.string().min(1),
    attempt: z.number().int().positive().safe(),
    round: z.number().int().positive().safe(),
  }).strict(),
  report: z.object({
    declaredSha256: digest,
    declaredBytes: z.number().int().nonnegative().safe(),
    stored: z.literal(true),
  }).strict(),
}).strict();

export const historicalDeliveryReconciliationManifestSchema = z.object({
  kind: z.literal('rcl-historical-delivery-reconciliation'),
  version: z.literal(1),
  operationId: uuid,
  createdAt: z.string().datetime({ offset: true }),
  gitCommonDir: z.string().min(1),
  target: z.string().min(1),
  runId: uuid,
  nativeStateSha256: digest,
  attemptStateSha256: digest,
  sourceStaleManifestSha256s: z.array(digest).min(1).max(100).refine(
    values => new Set(values).size === values.length && isDeepStrictEqual(values, [...values].sort()),
    'Historical stale manifest digests must be unique and sorted'
  ),
  successor: z.object({
    runId: uuid,
    attempt: z.number().int().positive().safe(),
    round: z.number().int().positive().safe(),
    headSha: commit,
    inputSha256: digest,
  }).strict(),
  reconciliation: strongDeliveryReconciliationSchema,
  baseSha: commit,
  diffSha256: digest,
  reviewerHealth: reviewerHealthSchema,
  server: historicalServerProjectionSchema,
  serverProjectionSha256: digest,
}).strict();

export type HistoricalDeliveryReconciliationManifest = z.infer<typeof historicalDeliveryReconciliationManifestSchema>;

export const historicalDeliveryReconciliationReceiptSchema = z.object({
  kind: z.literal('rcl-historical-delivery-reconciliation-receipt'),
  version: z.literal(1),
  operationId: uuid,
  runId: uuid,
  manifestSha256: digest,
  beforeStateSha256: digest,
  afterStateSha256: digest,
  attemptStateSha256: digest,
  sourceStaleManifestSha256s: z.array(digest).min(1).max(100),
  serverProjectionSha256: digest,
}).strict();

export type HistoricalDeliveryReconciliationReceipt = z.infer<typeof historicalDeliveryReconciliationReceiptSchema>;

export interface HistoricalDeliveryReconciliationEntry {
  manifestJson: string;
  manifestSha256: string;
}

const historicalDeliveryReconciliationEntrySchema = z.object({
  manifestJson:z.string().max(128 * 1024),manifestSha256:digest,
}).strict();

export function historicalDeliveryManifest(entry: HistoricalDeliveryReconciliationEntry): HistoricalDeliveryReconciliationManifest {
  const parsedEntry = historicalDeliveryReconciliationEntrySchema.parse(entry);
  if (sha256(parsedEntry.manifestJson) !== parsedEntry.manifestSha256) throw new Error('historical_delivery_reconciliation_manifest_digest_mismatch');
  const manifest = historicalDeliveryReconciliationManifestSchema.parse(decodeRecoveryDocument(parsedEntry.manifestJson));
  if (parsedEntry.manifestJson !== serializeRecoveryDocument(manifest)) {
    throw new Error('historical_delivery_reconciliation_manifest_noncanonical');
  }
  return manifest;
}

export function validateHistoricalDeliveryReconciliationAudit(value: {
  target?: string;
  historicalDeliveryReconciliationAudit?: HistoricalDeliveryReconciliationEntry[];
  historicalDeliveryReconciliationAuditCount?: number;
}): void {
  const audit = value.historicalDeliveryReconciliationAudit;
  if (audit === undefined) {
    if (value.historicalDeliveryReconciliationAuditCount !== undefined) {
      throw new Error('historical_delivery_reconciliation_audit_count_mismatch');
    }
    return;
  }
  if (!Array.isArray(audit) || audit.length === 0 || audit.length > 10_000 ||
    value.historicalDeliveryReconciliationAuditCount !== audit.length) {
    throw new Error('historical_delivery_reconciliation_audit_count_mismatch');
  }
  const operations = new Set<string>();
  const runs = new Set<string>();
  for (const entry of audit) {
    const manifest = historicalDeliveryManifest(entry);
    if (manifest.target !== value.target || operations.has(manifest.operationId) || runs.has(manifest.runId)) {
      throw new Error('historical_delivery_reconciliation_audit_duplicate');
    }
    operations.add(manifest.operationId);
    runs.add(manifest.runId);
  }
}
