import { z } from 'zod';
import { sha256 } from '../telemetry/recovery/files.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import type { ConvergeRunState } from './run-state.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const ordinal = z.number().int().min(1).max(99);
const timestamp = z.string().datetime();
export const gapAttemptSchema = z.object({ attempt: z.number().int().positive().safe(), claimedAt: timestamp,
  pid: z.number().int().positive().safe(), source: z.literal('claim') }).strict();
const file = z.object({ path: z.string().min(1), sha256: digest, bytes: z.number().int().nonnegative().max(25 * 1024 * 1024) }).strict();
export const roundGapManifestSchema = z.object({
  kind: z.literal('rcl-round-gap-audit'), version: z.literal(1), operationId: uuid, createdAt: timestamp,
  gitCommonDir: z.string().min(1), target: z.string().min(1).max(200).refine(s => s.trim() === s),
  gapRound: ordinal, admittingRound: ordinal, attempt: z.number().int().positive().safe(), runId: uuid,
  reportSha256: digest, incompleteSha256: digest, stateSha256: digest, attemptSha256: digest,
  gapAttempt: gapAttemptSchema, admittingAttempt: gapAttemptSchema,
  report: file, incomplete: file, evidence: z.array(file).max(20),
  disposition: z.object({ kind: z.literal('missing-terminal-report'), controllerExit: z.literal('unknown'),
    scope: z.literal('supplied-evidence-only') }).strict(),
}).strict().refine(m => m.admittingRound === m.gapRound + 1 && m.attempt === m.gapAttempt.attempt &&
  m.gapAttempt.attempt < m.admittingAttempt.attempt &&
  m.reportSha256 === m.report.sha256 && m.incompleteSha256 === m.incomplete.sha256);
export type RoundGapManifest = z.infer<typeof roundGapManifestSchema>;
export const roundGapEntrySchema = z.object({ manifestSha256: digest, manifestJson: z.string().max(1024 * 1024) }).strict();
export type RoundGapEntry = z.infer<typeof roundGapEntrySchema>;

/** Parse only the supported complete receipt shape, without inventing a producer round. */
export function gapManifest(entry: RoundGapEntry): RoundGapManifest {
  if (!roundGapEntrySchema.safeParse(entry).success || sha256(entry.manifestJson) !== entry.manifestSha256) throw new Error('invalid_round_gap_audit');
  const parsed = roundGapManifestSchema.safeParse(decodeOriginalReport(entry.manifestJson).value);
  if (!parsed.success) throw new Error('invalid_round_gap_audit');
  return parsed.data;
}

/** Older clients may preserve these unknown fields; candidates must validate them. */
export function validateRoundGapAudit(state: ConvergeRunState): void {
  if (state.roundGapAudit === undefined) return;
  const audit = z.object({ version: z.literal(1), entries: z.array(roundGapEntrySchema).min(1).max(98) }).strict().safeParse(state.roundGapAudit);
  if (!audit.success) throw new Error('invalid_round_gap_audit');
  const operations = new Set<string>(), gaps = new Set<number>();
  for (const entry of audit.data.entries) {
    const m = gapManifest(entry);
    if (m.target !== state.target || operations.has(m.operationId) || gaps.has(m.gapRound) ||
        state.rounds.some(r => r.round === m.gapRound)) throw new Error('invalid_round_gap_audit');
    operations.add(m.operationId); gaps.add(m.gapRound);
  }
}
