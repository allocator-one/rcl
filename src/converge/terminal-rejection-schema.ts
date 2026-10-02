import { z } from 'zod';
import { sha256 } from '../telemetry/recovery/files.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const rejectionSelectionSchema = z.object({
  target: z.string().min(1).max(200).refine(value => value.trim() === value),
  runId: z.string().uuid(), reportPath: z.string().min(1), reportSha256: digest,
  reason: z.string().trim().min(1).max(500),
}).strict();
export const rejectionManifestSchema = rejectionSelectionSchema.extend({
  kind: z.literal('rcl-terminal-rejection'), version: z.literal(1),
  operationId: z.string().uuid(), createdAt: z.string().datetime(),
  gitCommonDir: z.string().min(1), dataDir: z.string().min(1),
  stateSha256: digest, attemptSha256: digest, quarantineSha256: digest,
  cycleId: z.string().uuid().nullable(), attempt: z.number().int().positive().safe(),
  round: z.number().int().positive().safe(), headSha: z.string().regex(/^[a-f0-9]{40}$/), inputSha256: digest,
}).strict();
export type RejectionSelection = z.infer<typeof rejectionSelectionSchema>;
export type RejectionManifest = z.infer<typeof rejectionManifestSchema>;
export const rejectionEntrySchema = z.object({ manifestJson: z.string().max(16384), manifestSha256: digest }).strict();
export type RejectionEntry = z.infer<typeof rejectionEntrySchema>;
export function rejectionManifest(entry: RejectionEntry): RejectionManifest {
  rejectionEntrySchema.parse(entry);
  if (sha256(entry.manifestJson) !== entry.manifestSha256) throw new Error('rejection_manifest_digest_mismatch');
  return rejectionManifestSchema.parse(decodeOriginalReport(entry.manifestJson).value);
}

/** A missing/truncated audit cannot silently revive the original report. */
export function validateTerminalRejectionAudit(state: { terminalRejections?: RejectionEntry[]; terminalRejectionCount?: number }): void {
  const entries = state.terminalRejections;
  if (entries === undefined) {
    if (state.terminalRejectionCount !== undefined) throw new Error('terminal_rejection_audit_invalid');
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 10000 || state.terminalRejectionCount !== entries.length) {
    throw new Error('terminal_rejection_audit_invalid');
  }
  for (const entry of entries) rejectionManifest(entry);
}
