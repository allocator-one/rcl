import { z } from 'zod';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { sha256 } from '../telemetry/recovery/files.js';
import type { ConvergeRunState } from './run-state.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const staleSelectionSchema = z.object({
  target: z.string().min(1).max(200).refine(s => s.trim() === s),
  headSha: z.string().regex(/^[a-f0-9]{40}$/), inputSha256: digest,
  reportPath: z.string().min(1), reportSha256: digest,
  reason: z.string().trim().min(1).max(500),
}).strict();
export const staleManifestSchema = staleSelectionSchema.extend({
  kind: z.literal('rcl-stale-report'), version: z.literal(1),
  operationId: z.string().uuid().refine(s => s === s.toLowerCase()),
  createdAt: z.string().datetime(), gitCommonDir: z.string().min(1),
  stateSha256: digest, attemptSha256: digest,
  runId: z.string().uuid(), attempt: z.number().int().positive().safe(),
  round: z.number().int().positive().max(99),
  previousHeadSha: z.string().regex(/^[a-f0-9]{40}$/), previousInputSha256: digest,
}).strict();
export type StaleReportSelection = z.infer<typeof staleSelectionSchema>;
export type StaleReportManifest = z.infer<typeof staleManifestSchema>;
export const staleEntrySchema = z.object({manifestJson:z.string().max(16384),manifestSha256:digest}).strict();
export type StaleReportEntry = z.infer<typeof staleEntrySchema>;

export function staleManifest(entry: StaleReportEntry): StaleReportManifest {
  if (!staleEntrySchema.safeParse(entry).success || sha256(entry.manifestJson) !== entry.manifestSha256) throw new Error('invalid_stale_report_audit');
  return staleManifestSchema.parse(decodeOriginalReport(entry.manifestJson).value);
}

export function validateStaleReportAudit(state: ConvergeRunState): void {
  if (state.staleReportAudit === undefined) return;
  const entries = z.array(staleEntrySchema).min(1).max(10000).parse(state.staleReportAudit);
  const operations = new Set<string>(), attempts = new Set<number>(), runs = new Set<string>();
  for (const entry of entries) {
    const m = staleManifest(entry);
    if (m.target !== state.target || m.inputSha256 === m.previousInputSha256 || operations.has(m.operationId) ||
      attempts.has(m.attempt) || runs.has(m.runId) || state.rounds.some(r => r.runId === m.runId)) throw new Error('invalid_stale_report_audit');
    operations.add(m.operationId); attempts.add(m.attempt); runs.add(m.runId);
  }
}
