import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readStable, sha256, platformPath } from '../telemetry/recovery/files.js';
import { originalRunReportSchema } from '../telemetry/recovery/source.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { serializeRecoveryDocument, syncDirectory } from '../evidence/original-run/journal.js';
import { prepareLockRoot, inspectRecoveryDirectory } from '../evidence/original-run/lock-path.js';
import { convergeAttemptStatePath, validateConvergeAttemptState } from './attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState, resolveRoundResolution, validateRoundCap, writeState, type ConvergeRunState } from './run-state.js';
import { launchSchema, hasHealthyGuardedLaunch } from './launch-guard.js';
import { withRecoveryTarget } from './target-ownership.js';
import { staleManifest, staleManifestSchema, staleSelectionSchema, validateStaleReportAudit, StaleReportAuditError,
  type StaleReportEntry, type StaleReportManifest, type StaleReportSelection } from './stale-report-schema.js';
import { selectedStaleFile as selected, retainStaleFile as retain, retainStaleObject,
  retainStaleSnapshot, StaleHistoryReader } from './stale-report-storage.js';
import { scrubText } from '../telemetry/scrub.js';

const parse = (s: Awaited<ReturnType<typeof readStable>>) => decodeOriginalReport(s.text).value;
function eligible(state: ConvergeRunState, attemptsRaw: unknown, reportRaw: unknown, s: StaleReportSelection, auditValidated = false) {
  if (state.version !== 1 || state.target !== s.target || !Array.isArray(state.rounds) || !state.findings || Array.isArray(state.findings)) throw new Error('stale_report_unsupported_state');
  validateRoundCap(state.roundCap); if (!auditValidated) validateStaleReportAudit(state);
  const previous = launchSchema.parse(state.lastLaunch);
  const attempts = validateConvergeAttemptState(attemptsRaw,s.target,'stale-report');
  const report = originalRunReportSchema.parse(reportRaw);
  const round = Math.max(0,...state.rounds.map(r => r.round)) + 1;
  if (!Number.isSafeInteger(round) || round > state.roundCap || previous.round !== round ||
    state.rounds.some(r => r.runId === previous.runId)) throw new Error('stale_report_not_unadmitted');
  if (round > 1 && (!resolveRoundResolution(state,round-1) || resolveRoundResolution(state,round-1)?.status === 'unresolved')) throw new Error('triage_required');
  if (previous.status !== 'completed' || previous.deliveryPending || previous.hardFailure ||
    !hasHealthyGuardedLaunch(previous)) throw new Error('stale_report_outcome_ineligible');
  if (attempts.attemptsUsed !== previous.attempt || !attempts.attempts.some(a => a.attempt === previous.attempt && a.source === 'claim')) throw new Error('stale_report_attempt_mismatch');
  if (s.inputSha256 === previous.inputSha256 && !state.staleReportAudit?.some(e => staleManifest(e).attempt === previous.attempt)) throw new Error('inputs_unchanged');
  if (previous.reportJsonSha256 !== s.reportSha256 || report.run.id !== previous.runId ||
    report.run.target.head_sha !== previous.headSha || report.run.converge?.target !== s.target ||
    report.run.converge?.round !== previous.round || report.run.converge?.attempt !== previous.attempt ||
    report.stats.totalReviews !== previous.totalReviews || report.stats.successfulReviews !== previous.successfulReviews ||
    report.reviews.length !== previous.totalReviews || report.reviews.filter(r => r.status === 'success').length !== previous.successfulReviews ||
    ![0,1].includes(report.run.ci_exit_code)) throw new Error('stale_report_binding_mismatch');
  return previous;
}

/** Read-only evidence selection; it never admits findings or claims an attempt. */
export async function previewStaleReport(input: StaleReportSelection, gitCommonDir: string): Promise<StaleReportManifest> {
  const s = staleSelectionSchema.parse(input), common = await realpath(resolve(gitCommonDir));
  const native = await readStable(convergeRunStatePath(common,s.target));
  const attempts = await readStable(convergeAttemptStatePath(common,s.target));
  const report = await selected(s.reportPath,s.reportSha256);
  const state = await loadConvergeRunState(common,s.target);
  if (!state || !isDeepStrictEqual(state,parse(native))) throw new Error('stale_report_state_changed');
  const previous = eligible(state,parse(attempts),parse(report),s);
  await verifyStaleReportReceipts(common,state.staleReportAudit ?? []);
  if (state.staleReportAudit?.some(e => {
    const prior = staleManifest(e);
    return prior.attempt === previous.attempt && prior.headSha === s.headSha && prior.inputSha256 === s.inputSha256;
  })) throw new Error('stale_report_already_disposed');
  const manifest = staleManifestSchema.parse({...s,reportPath:platformPath(s.reportPath),reason:scrubText(s.reason,500),
    kind:'rcl-stale-report',version:1,operationId:randomUUID(),createdAt:new Date().toISOString(),gitCommonDir:common,
    stateSha256:native.sha256,attemptSha256:attempts.sha256,runId:previous.runId,attempt:previous.attempt,round:previous.round,
    previousHeadSha:previous.headSha,previousInputSha256:previous.inputSha256});
  await selected(convergeRunStatePath(common,s.target),native.sha256);
  await selected(convergeAttemptStatePath(common,s.target),attempts.sha256);
  return manifest;
}

function directory(common: string, m: StaleReportManifest) { return join(common,'rcl-stale-report-audits',m.operationId); }
function nextState(before: ConvergeRunState, entry: StaleReportEntry, m: StaleReportManifest): ConvergeRunState {
  const {staleReportAudit: audit = [], staleReportAuditCount: _count, updatedAt: _at, ...rest} = before;
  return {staleReportAudit:[...audit,entry],...rest,staleReportAuditCount:audit.length+1,updatedAt:m.createdAt};
}
async function retained(common: string, entry: StaleReportEntry, reader: StaleHistoryReader) {
  const m = staleManifest(entry), dir = directory(common,m);
  if (m.gitCommonDir !== common) throw new Error('stale_report_repository_mismatch');
  await inspectRecoveryDirectory(dir,true);
  await selected(join(dir,'manifest.json'),entry.manifestSha256);
  const {state,body} = await reader.snapshot(join(dir,'native-before.json'),m.stateSha256);
  const prefix = reader.prefix;
  if (!isDeepStrictEqual(state.staleReportAudit ?? [],prefix)) throw new Error('stale_report_audit_prefix_mismatch');
  const attempts = await reader.object(m.attemptSha256);
  const report = await reader.object(m.reportSha256);
  const previous = eligible(state,parse(attempts),parse(report),m,true);
  if (previous.attempt !== m.attempt || previous.round !== m.round || previous.runId !== m.runId ||
    previous.headSha !== m.previousHeadSha || previous.inputSha256 !== m.previousInputSha256) throw new Error('stale_report_manifest_binding_mismatch');
  const afterSha256 = reader.afterDigest(body,entry,m.createdAt);
  return {m,dir,afterSha256};
}

/** Receipt inspection is read-only and cannot repair or fabricate a disposition. */
async function verifyStaleReportReceipt(common: string, entry: StaleReportEntry, reader: StaleHistoryReader): Promise<void> {
  const {m,dir,afterSha256} = await retained(common,entry,reader);
  const expected = {kind:'rcl-stale-report-receipt',version:1,operationId:m.operationId,manifestSha256:entry.manifestSha256,
    beforeStateSha256:m.stateSha256,afterStateSha256:afterSha256};
  await selected(join(dir,'complete.json'),sha256(serializeRecoveryDocument(expected)));
}

/** Verify the complete ordered history, including every earlier replacement input. */
export async function verifyStaleReportReceipts(common: string, entries: StaleReportEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const root = join(common,'rcl-stale-report-audits');
    await inspectRecoveryDirectory(root,true);
    await inspectRecoveryDirectory(join(root,'objects'),true);
    const reader = new StaleHistoryReader(common);
    for (const entry of entries) {
      await verifyStaleReportReceipt(common,entry,reader);
      reader.append(entry);
    }
  } catch (cause) { throw new StaleReportAuditError('stale_report_audit_invalid',{cause}); }
}

/** Add only an audited disposition under the same native writer lock used by launches. */
export async function applyStaleReport(input: {manifest:string;manifestSha256:string;mode:'apply'|'resume'},gitCommonDir:string,
  hooks: {beforeNativeWrite?:()=>Promise<void>;afterNativeWrite?:()=>Promise<void>} = {}): Promise<'applied'|'resumed'> {
  const pinned = z.object({manifest:z.string().min(1),manifestSha256:z.string().regex(/^[a-f0-9]{64}$/),mode:z.enum(['apply','resume'])}).strict().parse(input);
  const original = await selected(pinned.manifest,pinned.manifestSha256);
  const m = staleManifestSchema.parse(parse(original)), common = await realpath(resolve(gitCommonDir));
  if (m.gitCommonDir !== common) throw new Error('stale_report_repository_mismatch');
  const entry: StaleReportEntry = {manifestJson:original.text,manifestSha256:original.sha256};
  return withRecoveryTarget(common,m.target,async ownership => {
    const current = await readStable(convergeRunStatePath(common,m.target));
    const state = await loadConvergeRunState(common,m.target);
    if (!state || !isDeepStrictEqual(state,parse(current))) throw new Error('stale_report_state_changed');
    const prior = state.staleReportAudit?.find(e => staleManifest(e).operationId === m.operationId);
    if (prior && !isDeepStrictEqual(prior,entry)) throw new Error('stale_report_operation_conflict');
    const dir = directory(common,m);
    await verifyStaleReportReceipts(common,state.staleReportAudit ?? []);
    if (prior) {
      // The native rename may have survived an interrupted directory sync.
      await retain(convergeRunStatePath(common,m.target),current.raw);
      return 'resumed';
    }
    const before = await selected(convergeRunStatePath(common,m.target),m.stateSha256);
    const attempts = await selected(convergeAttemptStatePath(common,m.target),m.attemptSha256);
    const report = await selected(m.reportPath,m.reportSha256);
    const previous = eligible(state,parse(attempts),parse(report),m);
    if (previous.attempt !== m.attempt || previous.round !== m.round || previous.runId !== m.runId ||
      previous.headSha !== m.previousHeadSha || previous.inputSha256 !== m.previousInputSha256) throw new Error('stale_report_manifest_binding_mismatch');
    const next = nextState(state,entry,m), after = Buffer.from(serializeRecoveryDocument(next));
    validateStaleReportAudit(next);
    if (pinned.mode === 'resume') {
      let stat;
      try { stat = await lstat(dir); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        throw new Error('stale_report_operation_missing');
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('stale_report_operation_missing');
    }
    await prepareLockRoot(dirname(dir)); await syncDirectory(common);
    await prepareLockRoot(dir); await syncDirectory(dirname(dir));
    await retain(join(dir,'manifest.json'),original.raw);
    await retainStaleSnapshot(common,join(dir,'native-before.json'),before);
    await retainStaleObject(common,attempts.raw);
    await retainStaleObject(common,report.raw);
    const receipt = {kind:'rcl-stale-report-receipt',version:1,operationId:m.operationId,manifestSha256:entry.manifestSha256,
      beforeStateSha256:m.stateSha256,afterStateSha256:sha256(after)};
    // A receipt is usable only in conjunction with its atomically published native audit entry.
    await retain(join(dir,'complete.json'),Buffer.from(serializeRecoveryDocument(receipt)));
    await hooks.beforeNativeWrite?.();
    await selected(pinned.manifest,pinned.manifestSha256); await selected(m.reportPath,m.reportSha256);
    await selected(convergeRunStatePath(common,m.target),m.stateSha256);
    await selected(convergeAttemptStatePath(common,m.target),m.attemptSha256);
    await verifyStaleReportReceipts(common,next.staleReportAudit!);
    await writeState(common,next,ownership);
    await hooks.afterNativeWrite?.();
    await selected(convergeRunStatePath(common,m.target),sha256(after));
    return 'applied';
  });
}
