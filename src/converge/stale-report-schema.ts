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

export class StaleReportAuditError extends Error {
  constructor(message = 'invalid_stale_report_audit', options?: ErrorOptions) {
    super(message, options);
    this.name = 'StaleReportAuditError';
  }
}

const manifests = new WeakMap<StaleReportEntry,{json:string;digest:string;manifest:StaleReportManifest}>();

export function staleManifest(entry: StaleReportEntry): StaleReportManifest {
  try {
    const cached = manifests.get(entry);
    if (cached && cached.json === entry.manifestJson && cached.digest === entry.manifestSha256) return cached.manifest;
    if (!staleEntrySchema.safeParse(entry).success || sha256(entry.manifestJson) !== entry.manifestSha256) throw new StaleReportAuditError();
    const manifest = Object.freeze(staleManifestSchema.parse(decodeOriginalReport(entry.manifestJson).value));
    manifests.set(entry,{json:entry.manifestJson,digest:entry.manifestSha256,manifest});
    return manifest;
  } catch (cause) { throw new StaleReportAuditError(undefined,{cause}); }
}

export function validateStaleReportAudit(state: ConvergeRunState): void {
  if (state.staleReportAudit === undefined) {
    if (state.staleReportAuditCount !== undefined) throw new StaleReportAuditError();
    return;
  }
  if (!Array.isArray(state.staleReportAudit) || state.staleReportAudit.length === 0 || state.staleReportAudit.length > 10000 || state.staleReportAuditCount !== state.staleReportAudit.length) {
    throw new StaleReportAuditError();
  }
  const entries = state.staleReportAudit;
  const operations = new Set<string>();
  const replacements = new Set<string>();
  const originals = new Map<number, StaleReportManifest>();
  const runs = new Map<string,number>();
  let lastAttempt = 0;
  for (const entry of entries) {
    const m = staleManifest(entry);
    const original = originals.get(m.attempt);
    const replacement = `${m.attempt}:${m.headSha}:${m.inputSha256}`;
    if (m.target !== state.target || (m.inputSha256 === m.previousInputSha256 && original === undefined) || operations.has(m.operationId) ||
      replacements.has(replacement) || m.attempt < lastAttempt ||
      (runs.has(m.runId) && runs.get(m.runId) !== m.attempt) ||
      state.rounds.some(r => r.runId === m.runId) ||
      (original !== undefined && (original.runId !== m.runId || original.round !== m.round ||
        original.reportSha256 !== m.reportSha256 || original.attemptSha256 !== m.attemptSha256 ||
        original.gitCommonDir !== m.gitCommonDir ||
        original.previousHeadSha !== m.previousHeadSha || original.previousInputSha256 !== m.previousInputSha256))) {
      throw new StaleReportAuditError();
    }
    operations.add(m.operationId);
    replacements.add(replacement);
    originals.set(m.attempt,m); runs.set(m.runId,m.attempt); lastAttempt = m.attempt;
  }
}
