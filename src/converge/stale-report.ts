import { randomUUID } from 'node:crypto';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readStable, sha256, platformPath } from '../telemetry/recovery/files.js';
import { originalRunReportSchema } from '../telemetry/recovery/source.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { serializeRecoveryDocument, syncDirectory, writeExclusiveBytes } from '../evidence/original-run/journal.js';
import { prepareLockRoot, inspectRecoveryDirectory } from '../evidence/original-run/lock-path.js';
import { convergeAttemptStatePath, validateConvergeAttemptState } from './attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState, resolveRoundResolution, validateRoundCap, writeState, type ConvergeRunState } from './run-state.js';
import { launchSchema, hasHealthyGuardedLaunch } from './launch-guard.js';
import { withRecoveryTarget } from './target-ownership.js';
import { staleManifest, staleManifestSchema, staleSelectionSchema, validateStaleReportAudit,
  type StaleReportEntry, type StaleReportManifest, type StaleReportSelection } from './stale-report-schema.js';
import { scrubText } from '../telemetry/scrub.js';

const parse = (s: Awaited<ReturnType<typeof readStable>>) => decodeOriginalReport(s.text).value;
async function selected(path: string, digest: string) {
  const s = await readStable(path);
  if (s.sha256 !== digest) throw new Error('stale_report_digest_mismatch');
  return s;
}
function eligible(state: ConvergeRunState, attemptsRaw: unknown, reportRaw: unknown, s: StaleReportSelection) {
  if (state.version !== 1 || state.target !== s.target || !Array.isArray(state.rounds) || !state.findings || Array.isArray(state.findings)) throw new Error('stale_report_unsupported_state');
  validateRoundCap(state.roundCap); validateStaleReportAudit(state);
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
  if (s.inputSha256 === previous.inputSha256) throw new Error('inputs_unchanged');
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
  return {...before,updatedAt:m.createdAt,staleReportAudit:[...(before.staleReportAudit ?? []),entry]};
}
/** Atomic exclusive publication keeps torn staging files separate from acknowledged evidence. */
async function retain(path: string, bytes: Buffer): Promise<void> {
  try {
    const current = await readStable(path);
    if (!current.raw.equals(bytes)) throw new Error('stale_report_retained_conflict');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const staging = `${path}.${randomUUID()}.pending`;
    await writeExclusiveBytes(staging,bytes);
    await link(staging,path); await syncDirectory(dirname(path));
    await unlink(staging);
  }
  const current = await selected(path,sha256(bytes));
  const handle = await open(path,'r');
  try { if (!(await handle.readFile()).equals(current.raw)) throw new Error('stale_report_retained_conflict'); }
  finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
async function retained(common: string, entry: StaleReportEntry) {
  const m = staleManifest(entry), dir = directory(common,m);
  if (m.gitCommonDir !== common) throw new Error('stale_report_repository_mismatch');
  await inspectRecoveryDirectory(dirname(dir),true); await inspectRecoveryDirectory(dir,true);
  await selected(join(dir,'manifest.json'),entry.manifestSha256);
  const before = await selected(join(dir,'native-before.json'),m.stateSha256);
  const attempts = await selected(join(dir,'attempts-before.json'),m.attemptSha256);
  const report = await selected(join(dir,'report.json'),m.reportSha256);
  const state = parse(before) as ConvergeRunState;
  const previous = eligible(state,parse(attempts),parse(report),m);
  if (previous.attempt !== m.attempt || previous.round !== m.round || previous.runId !== m.runId ||
    previous.headSha !== m.previousHeadSha || previous.inputSha256 !== m.previousInputSha256) throw new Error('stale_report_manifest_binding_mismatch');
  const next = nextState(state,entry,m), afterSha256 = sha256(serializeRecoveryDocument(next));
  await selected(join(dir,'native-after.json'),afterSha256);
  return {m,dir,next,afterSha256};
}

/** Receipt inspection is read-only and cannot repair or fabricate a disposition. */
export async function verifyStaleReportReceipt(common: string, entry: StaleReportEntry): Promise<void> {
  const {m,dir,afterSha256} = await retained(common,entry);
  const expected = {kind:'rcl-stale-report-receipt',version:1,operationId:m.operationId,manifestSha256:entry.manifestSha256,
    beforeStateSha256:m.stateSha256,afterStateSha256:afterSha256};
  await selected(join(dir,'complete.json'),sha256(serializeRecoveryDocument(expected)));
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
    if (prior) {
      await verifyStaleReportReceipt(common,entry);
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
    if (pinned.mode === 'resume') { const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('stale_report_operation_missing'); }
    await prepareLockRoot(dirname(dir)); await syncDirectory(common);
    await prepareLockRoot(dir); await syncDirectory(dirname(dir));
    await retain(join(dir,'manifest.json'),original.raw);
    await retain(join(dir,'native-before.json'),before.raw);
    await retain(join(dir,'attempts-before.json'),attempts.raw);
    await retain(join(dir,'report.json'),report.raw);
    const next = nextState(state,entry,m), after = Buffer.from(serializeRecoveryDocument(next));
    await retain(join(dir,'native-after.json'),after);
    const receipt = {kind:'rcl-stale-report-receipt',version:1,operationId:m.operationId,manifestSha256:entry.manifestSha256,
      beforeStateSha256:m.stateSha256,afterStateSha256:sha256(after)};
    // A receipt is usable only in conjunction with its atomically published native audit entry.
    await retain(join(dir,'complete.json'),Buffer.from(serializeRecoveryDocument(receipt)));
    await hooks.beforeNativeWrite?.();
    await selected(pinned.manifest,pinned.manifestSha256); await selected(m.reportPath,m.reportSha256);
    await selected(convergeRunStatePath(common,m.target),m.stateSha256);
    await selected(convergeAttemptStatePath(common,m.target),m.attemptSha256);
    await verifyStaleReportReceipt(common,entry);
    await writeState(common,next,ownership);
    await hooks.afterNativeWrite?.();
    await selected(convergeRunStatePath(common,m.target),sha256(after));
    return 'applied';
  });
}
