import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ReviewResult } from '../consensus/types.js';
import { withRecoveryTarget } from './target-ownership.js';
import { convergeAttemptStatePath, validateConvergeAttemptState } from './attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunStateEvidence, writeState, type ConvergeRunState } from './run-state.js';
import { gapManifest, roundGapManifestSchema, validateRoundGapAudit, type RoundGapEntry, type RoundGapManifest } from './round-gap-schema.js';
import { readStable, platformPath, sha256 } from '../telemetry/recovery/files.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { originalRunReportSchema } from '../telemetry/recovery/source.js';
import { inspectRecoveryDirectory, prepareLockRoot } from '../evidence/original-run/lock-path.js';
import { openJournal, serializeRecoveryDocument, syncDirectory, writeExclusiveBytes } from '../evidence/original-run/journal.js';
export type { RoundGapManifest } from './round-gap-schema.js';

const MAX_MANIFEST = 1024 * 1024;
const selectionSchema = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const previewSchema = z.object({ target: z.string().min(1).max(200).refine(s => s.trim() === s),
  gapRound: z.number().int().positive().max(99), admittingRound: z.number().int().positive().max(99),
  attempt: z.number().int().positive().safe(), runId: z.string().uuid(),
  reportPath: z.string().min(1), reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
  incompletePath: z.string().min(1), incompleteSha256: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.array(selectionSchema).max(20).optional(), operationId: z.string().uuid().optional(),
}).strict();
export type RoundGapSelection = z.infer<typeof previewSchema>;
type Snapshot = Awaited<ReturnType<typeof readStable>>;
const parse = (raw: Snapshot) => decodeOriginalReport(raw.text).value;
const source = (path: string, snap: Snapshot) => ({ path: platformPath(path), sha256: snap.sha256, bytes: snap.raw.length });

async function selected(path: string, digest: string): Promise<Snapshot> {
  const snap = await readStable(path);
  if (snap.sha256 !== digest) throw new Error('round_gap_source_digest_mismatch');
  return snap;
}
function validateNative(state: ConvergeRunState, m: { target: string; gapRound: number; admittingRound: number }): void {
  if (state.version !== 1 || state.target !== m.target || !Number.isSafeInteger(state.roundCap) || state.roundCap < 2 || state.roundCap > 99 ||
      m.admittingRound > state.roundCap || !state.rounds.length || Math.max(...state.rounds.map(r => r.round)) !== m.gapRound - 1) throw new Error('round_gap_not_contiguous');
  const seen = new Set<number>();
  for (const round of state.rounds) {
    if (!Number.isSafeInteger(round.round) || round.round < 1 || round.round > state.roundCap || seen.has(round.round) ||
        !round.counts || ['new', 'repeat', 'suppressed', 'regating'].some(k => !Number.isSafeInteger(round.counts[k as keyof typeof round.counts]) || round.counts[k as keyof typeof round.counts] < 0)) throw new Error('invalid_round_gap_native_state');
    seen.add(round.round);
  }
  // This operation covers one gap only; prior audits do not establish its prefix.
  for (let round = 1; round < m.gapRound; round++) {
    if (!seen.has(round)) throw new Error('round_gap_not_contiguous');
  }
  if (!state.findings || Array.isArray(state.findings) || Object.entries(state.findings).some(([key, f]) =>
    !f || f.key !== key || !seen.has(f.firstRound) || !seen.has(f.lastRound) || f.firstRound > f.lastRound ||
    !['critical','important','minor','nitpick'].includes(f.severity) ||
    (f.verdict !== undefined && (!['fixed','dismissed'].includes(f.verdict) || !seen.has(f.verdictRound!))))) throw new Error('invalid_round_gap_native_state');
  validateRoundGapAudit(state);
}
function validateReport(snap: Snapshot, m: { target: string; runId: string; admittingRound: number }): number {
  const decoded = decodeOriginalReport(snap.text);
  if (decoded.transformations.length) throw new Error('round_gap_report_requires_interpretation');
  const report = originalRunReportSchema.safeParse(decoded.value);
  const converge = report.success ? report.data.run.converge : undefined;
  const attempt = converge?.attempt;
  if (!report.success || report.data.run.id !== m.runId || converge?.target !== m.target ||
      converge.round !== m.admittingRound || typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('round_gap_report_binding_mismatch');
  }
  return attempt;
}
async function evidenceSources(m: RoundGapSelection | RoundGapManifest): Promise<Snapshot[]> {
  const specs = 'report' in m ? [m.report, m.incomplete, ...m.evidence] :
    [{ path: m.reportPath, sha256: m.reportSha256 }, { path: m.incompletePath, sha256: m.incompleteSha256 }, ...(m.evidence ?? [])];
  const results: Snapshot[] = [];
  const paths = new Set<string>();
  for (const item of specs) {
    const path = platformPath(item.path);
    if (paths.has(path)) throw new Error('round_gap_duplicate_source');
    const snapshot = await selected(path,item.sha256);
    if ('bytes' in item && snapshot.raw.length !== item.bytes) throw new Error('round_gap_source_changed');
    paths.add(path); results.push(snapshot);
  }
  const admittingAttempt = validateReport(results[0]!, m);
  if ('admittingAttempt' in m && admittingAttempt !== m.admittingAttempt.attempt) throw new Error('round_gap_report_binding_mismatch');
  if (!results[1]!.raw.length) throw new Error('round_gap_incomplete_evidence_empty');
  return results;
}
function attemptRecords(snapshot: Snapshot, target: string, gapAttempt: number, admittingAttempt: number) {
  const attempts = validateConvergeAttemptState(parse(snapshot), target, 'round-gap-selected-attempts');
  const gap = attempts.attempts.find(a => a.attempt === gapAttempt), admitting = attempts.attempts.find(a => a.attempt === admittingAttempt);
  if (!gap || !admitting) throw new Error('round_gap_not_bound_to_spent_attempt');
  return { gapAttempt: gap, admittingAttempt: admitting };
}
/** Read-only preview: the only identities introduced belong to the audit operation. */
export async function previewRoundGap(input: RoundGapSelection, gitCommonDir: string): Promise<RoundGapManifest> {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) throw new Error('invalid_round_gap_selection');
  const selection = parsed.data, commonDir = await realpath(resolve(gitCommonDir));
  const sources = await evidenceSources(selection);
  const native = await readStable(convergeRunStatePath(commonDir, selection.target));
  const attempts = await readStable(convergeAttemptStatePath(commonDir, selection.target));
  const state = parse(native) as ConvergeRunState;
  validateNative(state, selection);
  const admittingAttempt = validateReport(sources[0]!, selection);
  const manifest = { kind: 'rcl-round-gap-audit', version: 1, operationId: selection.operationId ?? randomUUID(), createdAt: new Date().toISOString(),
    gitCommonDir: commonDir, target: selection.target, gapRound: selection.gapRound, admittingRound: selection.admittingRound,
    attempt: selection.attempt, runId: selection.runId, reportSha256: selection.reportSha256, incompleteSha256: selection.incompleteSha256,
    stateSha256: native.sha256, attemptSha256: attempts.sha256,
    ...attemptRecords(attempts, selection.target, selection.attempt, admittingAttempt),
    report: source(selection.reportPath, sources[0]!), incomplete: source(selection.incompletePath, sources[1]!),
    evidence: (selection.evidence ?? []).map((s,i) => source(s.path, sources[i+2]!)),
    disposition: { kind: 'missing-terminal-report', controllerExit: 'unknown', scope: 'supplied-evidence-only' } };
  const checked = roundGapManifestSchema.safeParse(manifest);
  if (!checked.success) throw new Error('invalid_round_gap_manifest');
  // A preview observes one stable pair without creating a lock, snapshot or journal.
  if ((await readStable(convergeRunStatePath(commonDir, selection.target))).sha256 !== native.sha256 ||
      (await readStable(convergeAttemptStatePath(commonDir, selection.target))).sha256 !== attempts.sha256) throw new Error('round_gap_preview_source_changed');
  return checked.data;
}

/** Sync verified existing bytes; a missing file is never recreated as an acknowledgment. */
async function syncIdentical(path: string, bytes: Buffer): Promise<void> {
  const current = await readStable(path);
  if (!current.raw.equals(bytes)) throw new Error('round_gap_retained_source_conflict');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.readFile()).equals(bytes)) throw new Error('round_gap_retained_source_conflict');
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
/** An existing identical file still needs a successful fsync before it is durable. */
async function retain(path: string, bytes: Buffer): Promise<void> {
  try { await writeExclusiveBytes(path, bytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await syncIdentical(path,bytes);
  }
}
export function roundGapOperationPath(gitCommonDir: string, operationId: string): string {
  if (!z.string().uuid().safeParse(operationId).success) throw new Error('invalid_round_gap_operation');
  return join(platformPath(gitCommonDir), 'rcl-converge-gap-audits', operationId);
}
function afterState(before: ConvergeRunState, entry: RoundGapEntry, m: RoundGapManifest): ConvergeRunState {
  return { ...before, updatedAt: m.createdAt, roundGapAudit: { version: 1, entries: [...(before.roundGapAudit?.entries ?? []), entry] } };
}
const receipt = (m: RoundGapManifest, entry: RoundGapEntry, after: Buffer) => ({ version: 1, operationId: m.operationId,
  manifestSha256: entry.manifestSha256, beforeStateSha256: m.stateSha256, afterStateSha256: sha256(after) });

/** Read the existing journal chain; admission never repairs or appends checkpoints. */
async function verifyJournal(path: string, entry: RoundGapEntry, m: RoundGapManifest, expected: ReturnType<typeof receipt>, completed = true): Promise<void> {
  const names = (await readdir(path)).sort();
  if ((completed && !names.length) || names.length > 1000 || names.some((name,index) => name !== `${String(index+1).padStart(8,'0')}.json`)) throw new Error('round_gap_journal_invalid');
  let previous = entry.manifestSha256, verified = false;
  let torn: Array<{file:string;sha256:string}> = [];
  for (const [index,name] of names.entries()) {
    const snapshot = await readStable(join(path,name),MAX_MANIFEST);
    let record: Record<string,unknown>;
    try { JSON.parse(snapshot.text); }
    catch { torn.push({file:name,sha256:snapshot.sha256}); previous=snapshot.sha256; continue; }
    try { record = decodeOriginalReport(snapshot.text).value as Record<string,unknown>; }
    catch { throw new Error('round_gap_journal_invalid'); }
    if (!record || record.operation_id !== m.operationId || record.manifest_sha256 !== entry.manifestSha256 ||
        record.sequence !== index+1 || record.previous_sha256 !== previous ||
        !['sources_retained','native_write_intent','native_audit_verified','complete','interrupted_checkpoints_retained'].includes(String(record.phase)) ||
        !z.string().datetime().safeParse(record.recorded_at).success ||
        Object.keys(record).sort().join(',') !== 'data,manifest_sha256,operation_id,phase,previous_sha256,recorded_at,sequence') throw new Error('round_gap_journal_invalid');
    if (torn.length && (record.phase !== 'interrupted_checkpoints_retained' || !isDeepStrictEqual(record.data,{files:torn}))) throw new Error('round_gap_journal_invalid');
    torn=[]; previous=snapshot.sha256;
    if (record.phase === 'native_audit_verified' && isDeepStrictEqual(record.data,expected)) verified=true;
  }
  if (completed && (torn.length || !verified)) throw new Error('round_gap_journal_incomplete');
}

/** Verify retained original bytes and the exact committed result without mutating audit files. */
export async function verifyRoundGapReceipt(gitCommonDir: string, entry: RoundGapEntry): Promise<ReviewResult> {
  const m = gapManifest(entry), commonDir = await realpath(resolve(gitCommonDir));
  if (commonDir !== m.gitCommonDir) throw new Error('round_gap_repository_changed');
  const dir = roundGapOperationPath(commonDir, m.operationId);
  await inspectRecoveryDirectory(dir,true);
  const manifest = await readStable(join(dir, 'manifest.json'), MAX_MANIFEST);
  if (manifest.sha256 !== entry.manifestSha256 || manifest.text !== entry.manifestJson) throw new Error('round_gap_manifest_conflict');
  const before = await selected(join(dir, 'native-before.json'), m.stateSha256);
  const attempts = await selected(join(dir, 'attempts-before.json'), m.attemptSha256);
  const state = parse(before) as ConvergeRunState; validateNative(state, m);
  if (!isDeepStrictEqual(attemptRecords(attempts, m.target, m.gapAttempt.attempt, m.admittingAttempt.attempt), { gapAttempt: m.gapAttempt, admittingAttempt: m.admittingAttempt })) throw new Error('round_gap_attempt_changed');
  let report: ReviewResult | undefined;
  for (const [index, source] of [m.report,m.incomplete,...m.evidence].entries()) {
    const snapshot = await selected(join(dir, `source-${index}.bin`), source.sha256);
    if (snapshot.raw.length !== source.bytes) throw new Error('round_gap_source_changed');
    if (index === 0) {
      if (validateReport(snapshot, m) !== m.admittingAttempt.attempt) throw new Error('round_gap_report_binding_mismatch');
      report = parse(snapshot) as ReviewResult;
    }
  }
  const expected = Buffer.from(serializeRecoveryDocument(afterState(state, entry, m)));
  if (!(await readStable(join(dir, 'native-after.json'))).raw.equals(expected) ||
      !isDeepStrictEqual(parse(await readStable(join(dir, 'complete.json'))), receipt(m,entry,expected))) throw new Error('round_gap_completion_missing_or_conflicting');
  await verifyJournal(join(dir,'journal'),entry,m,receipt(m,entry,expected));
  return report!;
}
export interface ApplyRoundGapOptions { manifest: string; manifestSha256: string; mode: 'apply' | 'resume' }
export interface RoundGapHooks {
  beforeCheckpoint?: (phase: string) => Promise<void>;
  /** Test-only interruption seam after the native CAS is durable. */
  afterNativeWrite?: () => Promise<void>;
}
/** Target-owned CAS with exact snapshots and append-only audit. No round or budget is created. */
export async function applyRoundGap(input: ApplyRoundGapOptions, gitCommonDir: string, hooks: RoundGapHooks = {}): Promise<'applied' | 'resumed'> {
  const selection = z.object({ manifest: z.string().min(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), mode: z.enum(['apply','resume']) }).strict().safeParse(input);
  if (!selection.success) throw new Error('invalid_round_gap_apply_selection');
  const pinned = selection.data, original = await selected(pinned.manifest, pinned.manifestSha256);
  if (original.raw.length > MAX_MANIFEST) throw new Error('round_gap_manifest_oversized');
  const entry = { manifestSha256: original.sha256, manifestJson: original.text }, m = gapManifest(entry);
  const commonDir = await realpath(resolve(gitCommonDir));
  if (commonDir !== m.gitCommonDir) throw new Error('round_gap_repository_changed');
  await evidenceSources(m); // Refuse substitutions before even registering a target writer.
  return withRecoveryTarget(commonDir, m.target, async ownership => {
    await selected(pinned.manifest, pinned.manifestSha256);
    const sources = await evidenceSources(m);
    const current = await loadConvergeRunStateEvidence(commonDir, m.target);
    if (!current) throw new Error('round_gap_state_missing');
    const currentBytes = await readStable(convergeRunStatePath(commonDir,m.target));
    if (currentBytes.sha256 !== current.sha256) throw new Error('round_gap_state_changed');
    parse(currentBytes); // Reject duplicate/ambiguous structural keys before any receipt effects.
    const prior = current.state.roundGapAudit?.entries.find(e => gapManifest(e).operationId === m.operationId);
    if (prior && !isDeepStrictEqual(prior,entry)) throw new Error('round_gap_operation_conflict');
    const dir = roundGapOperationPath(commonDir, m.operationId);
    let exists = false;
    try { exists = (await lstat(dir)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!exists && (pinned.mode === 'resume' || prior)) throw new Error('round_gap_operation_missing');
    const native = prior ? await selected(join(dir,'native-before.json'), m.stateSha256) : await selected(convergeRunStatePath(commonDir,m.target), m.stateSha256);
    const attempts = prior ? await selected(join(dir,'attempts-before.json'),m.attemptSha256) : await selected(convergeAttemptStatePath(commonDir,m.target),m.attemptSha256);
    const before = parse(native) as ConvergeRunState; validateNative(before,m);
    if (!isDeepStrictEqual(attemptRecords(attempts,m.target,m.gapAttempt.attempt,m.admittingAttempt.attempt), {gapAttempt:m.gapAttempt,admittingAttempt:m.admittingAttempt})) throw new Error('round_gap_attempt_changed');
    if (!prior && current.state.roundGapAudit?.entries.some(e => gapManifest(e).gapRound === m.gapRound)) throw new Error('round_gap_conflict');
    await prepareLockRoot(dirname(dir)); await syncDirectory(commonDir);
    await prepareLockRoot(dir); await syncDirectory(dirname(dir));
    await retain(join(dir,'manifest.json'),original.raw);
    await retain(join(dir,'native-before.json'),native.raw);
    await retain(join(dir,'attempts-before.json'),attempts.raw);
    for (const [index,snapshot] of sources.entries()) await retain(join(dir,`source-${index}.bin`),snapshot.raw);
    const next = afterState(before,entry,m), nextBytes = Buffer.from(serializeRecoveryDocument(next));
    await retain(join(dir,'native-after.json'),nextBytes);
    const journalDir = join(dir,'journal'); let journalExists = false;
    try { journalExists = (await lstat(journalDir)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (journalExists) {
      await verifyJournal(journalDir,entry,m,receipt(m,entry,nextBytes),false);
      // A complete JSON checkpoint may have survived a failed file fsync.
      for (const name of (await readdir(journalDir)).sort()) {
        const path = join(journalDir,name);
        await syncIdentical(path,(await readStable(path,MAX_MANIFEST)).raw);
      }
    }
    const journal = await openJournal(journalDir,original.sha256,m.operationId,journalExists ? 'resume' : 'apply', hooks.beforeCheckpoint);
    await journal.append('sources_retained', { stateSha256:m.stateSha256,attemptSha256:m.attemptSha256,reportSha256:m.reportSha256 });
    if (!prior) {
      await journal.append('native_write_intent', { afterStateSha256:sha256(nextBytes) });
      // Every selected source must still be exact at the final publication boundary.
      await selected(pinned.manifest,pinned.manifestSha256);
      await evidenceSources(m);
      await selected(convergeRunStatePath(commonDir,m.target),m.stateSha256);
      await selected(convergeAttemptStatePath(commonDir,m.target),m.attemptSha256);
      await writeState(commonDir,next,ownership);
      await selected(convergeRunStatePath(commonDir,m.target),sha256(nextBytes));
      await hooks.afterNativeWrite?.();
    } else {
      // A prior rename can be visible even when its directory sync failed.
      await syncIdentical(convergeRunStatePath(commonDir,m.target),currentBytes.raw);
    }
    await journal.append('native_audit_verified',receipt(m,entry,nextBytes));
    await retain(join(dir,'complete.json'),Buffer.from(serializeRecoveryDocument(receipt(m,entry,nextBytes))));
    await verifyRoundGapReceipt(commonDir,entry);
    await journal.append('complete',receipt(m,entry,nextBytes));
    return prior ? 'resumed' : 'applied';
  });
}
