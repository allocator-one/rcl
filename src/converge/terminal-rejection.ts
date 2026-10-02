import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readStable } from '../telemetry/recovery/files.js';
import { decodeOriginalReport } from '../evidence/original-run/decode.js';
import { serializeRecoveryDocument, syncDirectory } from '../evidence/original-run/journal.js';
import { inspectRecoveryDirectory, prepareLockRoot } from '../evidence/original-run/lock-path.js';
import { originalRunReportSchema } from '../telemetry/recovery/source.js';
import { Quarantine, QUARANTINE_DIR } from '../telemetry/quarantine.js';
import { OUTBOX_DIR } from '../telemetry/outbox.js';
import { REVIEWER_OUTBOX_DIR } from '../telemetry/reviewer-delivery.js';
import { buildRunEnvelope, type ArtifactBytes } from '../telemetry/envelope.js';
import { validateRunEnvelope } from '../telemetry/envelope-validation.js';
import { verifiedConsensusDiagnostics } from '../telemetry/deliver.js';
import type { ReviewResult } from '../consensus/types.js';
import { mergedBlockingHealth } from './legacy-launch-health.js';
import { convergeAttemptStatePath, validateConvergeAttemptState } from './attempt-budget.js';
import { convergeRunStatePath, loadConvergeRunState, writeState, type ConvergeRunState } from './run-state.js';
import { launchSchema } from './launch-record.js';
import { assertNoPendingFreshReview, assertReviewCyclePair } from './fresh-review.js';
import { withRecoveryTarget } from './target-ownership.js';
import { retainStaleFile as retain, selectedStaleFile as selected } from './stale-report-storage.js';
import { rejectionManifest, rejectionManifestSchema, rejectionSelectionSchema, validateTerminalRejectionAudit,
  type RejectionEntry, type RejectionManifest, type RejectionSelection } from './terminal-rejection-schema.js';

const parse = (file: Awaited<ReturnType<typeof readStable>>) => decodeOriginalReport(file.text).value;
function refuse(code: string): never { throw new Error(`terminal_rejection_${code}`); }
function deadOwner(pid: number): void {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
  refuse('owner_live_or_uncertain');
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  refuse('pending_delivery');
}
/** Do not use Outbox.list: incomplete directories and unreadable entries must block too. */
async function noDelivery(dataDir: string, runId: string): Promise<void> {
  await inspectRecoveryDirectory(dataDir, true);
  for (const root of [OUTBOX_DIR, REVIEWER_OUTBOX_DIR]) {
    const directory = join(dataDir, root);
    try { await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    await inspectRecoveryDirectory(directory, true);
    await absent(join(directory, runId.toLowerCase()));
  }
}
function eligible(state: ConvergeRunState, attemptBytes: Awaited<ReturnType<typeof readStable>>, m: RejectionSelection) {
  const attempts = validateConvergeAttemptState(parse(attemptBytes), m.target, 'terminal rejection');
  validateTerminalRejectionAudit(state);
  const launch = launchSchema.parse(state.lastLaunch);
  if (state.target !== m.target || launch.status !== 'completed' || launch.runId !== m.runId ||
    launch.reportJsonSha256 !== m.reportSha256 || launch.retainedOriginal || launch.recovery || launch.pendingResume ||
    launch.attempt !== attempts.attemptsUsed || !attempts.attempts.some(a => a.attempt === launch.attempt && a.pid === launch.pid) ||
    !isDeepStrictEqual(state.cycle, attempts.cycle) || !launch.reviewerHealth ||
    state.rounds.some(r => r.runId === launch.runId || r.round === launch.round) ||
    launch.round !== Math.max(0, ...state.rounds.map(r => r.round)) + 1) refuse('ineligible_launch');
  return launch;
}
async function proof(state: ConvergeRunState, attempts: Awaited<ReturnType<typeof readStable>>,
  m: RejectionSelection, dataDir: string, retainedDirectory?: string) {
  const launch = eligible(state, attempts, m);
  const reportBytes = await selected(retainedDirectory ? join(retainedDirectory, 'report.json') : m.reportPath, m.reportSha256);
  const raw = parse(reportBytes), report = originalRunReportSchema.parse(raw);
  if (report.run.id !== launch.runId || report.run.target.head_sha !== launch.headSha ||
    report.run.converge?.target !== m.target || report.run.converge?.attempt !== launch.attempt ||
    report.run.converge?.round !== launch.round || report.run.cycle_id !== state.cycle?.id ||
    report.run.provenance === 'backfill' || report.run.gating.mode !== 'verified-consensus' ||
    report.stats.totalReviews !== launch.totalReviews || report.stats.successfulReviews !== launch.successfulReviews ||
    report.reviews.length !== launch.totalReviews || report.reviews.filter(r => r.status === 'success').length !== launch.successfulReviews ||
    !isDeepStrictEqual(mergedBlockingHealth(report, launch.reviewerHealth!.policy.fraction), launch.reviewerHealth)) refuse('report_binding');
  const quarantine = new Quarantine(retainedDirectory ? join(retainedDirectory, QUARANTINE_DIR) : join(dataDir, QUARANTINE_DIR));
  await inspectRecoveryDirectory(quarantine.dir, true);
  const retained = await quarantine.inspect(m.runId);
  if (retained?.status !== 'complete' || retained.manifest!.acknowledged || retained.observations!.length > 0 ||
    retained.manifest!.artifacts['report_json']?.sha256 !== m.reportSha256 || !retained.manifest!.envelope) refuse('quarantine_proof');
  await inspectRecoveryDirectory(retained.path, true);
  const manifest = await readStable(join(retained.path, 'manifest.json'), 64000);
  const artifacts: ArtifactBytes = { report_json: reportBytes.text };
  if (retained.manifest!.artifacts['report_md']) artifacts.report_md = (await readStable(join(retained.path, 'report.md'))).text;
  const storedEnvelope = parse(await readStable(join(retained.path, 'envelope.json')));
  // Only the supported, pre-network missing-label rejection is disposable. A
  // transport/server refusal, malformed envelope or valid report is not proof.
  const diagnostics = verifiedConsensusDiagnostics(raw as ReviewResult);
  if (diagnostics.length === 0 || diagnostics.some(d => !/^(findings|belowThresholdFindings)\.\d+\.gating\.reason$/.test(d.path))) refuse('unsupported_local_rejection');
  const levels = ['full', 'findings', 'envelope'] as const;
  const projections = levels.flatMap(level => [false, true].map(parseFailures =>
    buildRunEnvelope(raw as ReviewResult, artifacts, { level, parseFailures, delivery: { mode: 'direct' } })));
  const envelope = projections.find(candidate => isDeepStrictEqual(candidate, storedEnvelope));
  if (!envelope || validateRunEnvelope(envelope, artifacts).length > 0 ||
    !isDeepStrictEqual(retained.manifest!.diagnostics, diagnostics)) refuse('rejection_diagnostics');
  return { launch, reportBytes, manifest, quarantinePath: retained.path, quarantineManifest: retained.manifest! };
}
function bound(m: RejectionManifest, state: ConvergeRunState, launch: ReturnType<typeof launchSchema.parse>): void {
  if (m.cycleId !== (state.cycle?.id ?? null) || m.attempt !== launch.attempt || m.round !== launch.round ||
    m.headSha !== launch.headSha || m.inputSha256 !== launch.inputSha256) refuse('identity_changed');
}
function directory(common: string, m: RejectionManifest): string { return join(common, 'rcl-terminal-rejections', m.operationId); }
function nextState(before: ConvergeRunState, entry: RejectionEntry, m: RejectionManifest): ConvergeRunState {
  return { ...before, lastLaunch: { ...before.lastLaunch!, deliveryPending: false },
    terminalRejections: [...(before.terminalRejections ?? []), entry],
    terminalRejectionCount: (before.terminalRejections?.length ?? 0) + 1, updatedAt: m.createdAt };
}

/** Read-only selection: no admission, accounting, provider or server operation. */
export async function previewTerminalRejection(input: RejectionSelection, gitCommonDir: string, dataDirectory: string): Promise<RejectionManifest> {
  const s = rejectionSelectionSchema.parse(input), common = await realpath(resolve(gitCommonDir));
  const dataDir = await realpath(resolve(dataDirectory));
  await assertNoPendingFreshReview(common, s.target);
  const native = await readStable(convergeRunStatePath(common, s.target));
  const attempts = await readStable(convergeAttemptStatePath(common, s.target));
  const state = await loadConvergeRunState(common, s.target);
  if (!state || !isDeepStrictEqual(state, parse(native))) refuse('state_changed');
  await assertReviewCyclePair(common, s.target, state.cycle);
  await verifyTerminalRejections(common, state);
  if (state.terminalRejections?.some(e => rejectionManifest(e).runId === s.runId)) refuse('already_disposed');
  const evidence = await proof(state, attempts, s, dataDir);
  deadOwner(evidence.launch.pid); await noDelivery(dataDir, s.runId);
  const m = rejectionManifestSchema.parse({ ...s, reportPath: await realpath(resolve(s.reportPath)),
    kind: 'rcl-terminal-rejection', version: 1, operationId: randomUUID(), createdAt: new Date().toISOString(),
    gitCommonDir: common, dataDir, stateSha256: native.sha256, attemptSha256: attempts.sha256,
    quarantineSha256: evidence.manifest.sha256, cycleId: state.cycle?.id ?? null,
    attempt: evidence.launch.attempt, round: evidence.launch.round, headSha: evidence.launch.headSha, inputSha256: evidence.launch.inputSha256 });
  await selected(convergeRunStatePath(common, s.target), native.sha256);
  await selected(convergeAttemptStatePath(common, s.target), attempts.sha256);
  return m;
}

/** Immutable proof precedes the atomic native write; replay never duplicates an audit. */
export async function applyTerminalRejection(input: { manifest: string; manifestSha256: string }, gitCommonDir: string, dataDirectory: string): Promise<'applied' | 'unchanged'> {
  z.object({ manifest: z.string().min(1), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input);
  const original = await selected(input.manifest, input.manifestSha256);
  const m = rejectionManifestSchema.parse(parse(original)), common = await realpath(resolve(gitCommonDir));
  if (m.gitCommonDir !== common || m.dataDir !== await realpath(resolve(dataDirectory))) refuse('repository_or_data_directory');
  const entry: RejectionEntry = { manifestJson: original.text, manifestSha256: original.sha256 };
  return withRecoveryTarget(common, m.target, async ownership => {
    await assertNoPendingFreshReview(common, m.target);
    const current = await readStable(convergeRunStatePath(common, m.target));
    const state = await loadConvergeRunState(common, m.target);
    if (!state || !isDeepStrictEqual(state, parse(current))) refuse('state_changed');
    await assertReviewCyclePair(common, m.target, state.cycle);
    await verifyTerminalRejections(common, state);
    const prior = state.terminalRejections?.find(e => rejectionManifest(e).operationId === m.operationId);
    if (prior) {
      if (!isDeepStrictEqual(prior, entry)) refuse('operation_conflict');
      const before = parse(await selected(join(directory(common, m), 'native-before.json'), m.stateSha256)) as ConvergeRunState;
      if (!isDeepStrictEqual(state, nextState(before, entry, m))) refuse('state_changed');
      await selected(convergeAttemptStatePath(common, m.target), m.attemptSha256);
      deadOwner(state.lastLaunch!.pid); await noDelivery(m.dataDir, m.runId);
      return 'unchanged';
    }
    if (state.terminalRejections?.some(e => {
      const priorManifest = rejectionManifest(e);
      return priorManifest.runId === m.runId || priorManifest.reportSha256 === m.reportSha256;
    })) refuse('already_disposed');
    const before = await selected(convergeRunStatePath(common, m.target), m.stateSha256);
    const attempts = await selected(convergeAttemptStatePath(common, m.target), m.attemptSha256);
    const evidence = await proof(state, attempts, m, m.dataDir);
    bound(m, state, evidence.launch);
    if (evidence.manifest.sha256 !== m.quarantineSha256) refuse('quarantine_changed');
    deadOwner(evidence.launch.pid); await noDelivery(m.dataDir, m.runId);
    const dir = directory(common, m);
    await prepareLockRoot(dirname(dir)); await syncDirectory(common);
    await prepareLockRoot(dir); await syncDirectory(dirname(dir));
    await retain(join(dir, 'manifest.json'), original.raw);
    await retain(join(dir, 'native-before.json'), before.raw);
    await retain(join(dir, 'attempts-before.json'), attempts.raw);
    await retain(join(dir, 'report.json'), evidence.reportBytes.raw);
    await retain(join(dir, 'quarantine-manifest.json'), evidence.manifest.raw);
    const retainedQuarantine = join(dir, QUARANTINE_DIR, m.runId);
    await prepareLockRoot(dirname(retainedQuarantine)); await syncDirectory(dir);
    await prepareLockRoot(retainedQuarantine); await syncDirectory(dirname(retainedQuarantine));
    const files = ['manifest.json', 'pending.json', 'envelope.json', 'events.json', 'report.json',
      ...(evidence.quarantineManifest.artifacts['report_md'] ? ['report.md'] : [])];
    for (const file of files) await retain(join(retainedQuarantine, file), (await readStable(join(evidence.quarantinePath, file))).raw);
    const retainedEvidence = await proof(state, attempts, m, m.dataDir, dir);
    if (retainedEvidence.manifest.sha256 !== m.quarantineSha256) refuse('quarantine_changed');
    // Recheck mutable source observations immediately before the atomic write.
    const final = await proof(state, attempts, m, m.dataDir);
    if (final.manifest.sha256 !== m.quarantineSha256) refuse('quarantine_changed');
    await selected(convergeRunStatePath(common, m.target), m.stateSha256);
    await selected(convergeAttemptStatePath(common, m.target), m.attemptSha256);
    deadOwner(evidence.launch.pid); await noDelivery(m.dataDir, m.runId);
    await writeState(common, nextState(state, entry, m), ownership);
    return 'applied';
  });
}

/** Each native audit references durable original bytes, never a bare cleared bit. */
export async function verifyTerminalRejections(common: string, state: ConvergeRunState): Promise<void> {
  validateTerminalRejectionAudit(state);
  if (state.terminalRejections === undefined) return;
  if (!Array.isArray(state.terminalRejections) || state.terminalRejections.length === 0 || state.terminalRejections.length > 10000) refuse('audit_invalid');
  const prefix: RejectionEntry[] = [];
  const runs = new Set<string>();
  for (const entry of state.terminalRejections) {
    const m = rejectionManifest(entry), dir = directory(common, m);
    if (m.gitCommonDir !== common || m.target !== state.target || m.cycleId !== (state.cycle?.id ?? null) || runs.has(m.runId) ||
      state.rounds.some(r => r.runId === m.runId)) refuse('audit_binding');
    await inspectRecoveryDirectory(dirname(dir), true); await inspectRecoveryDirectory(dir, true);
    await selected(join(dir, 'manifest.json'), entry.manifestSha256);
    const before = parse(await selected(join(dir, 'native-before.json'), m.stateSha256)) as ConvergeRunState;
    const attempts = await selected(join(dir, 'attempts-before.json'), m.attemptSha256);
    if (!isDeepStrictEqual(before.terminalRejections ?? [], prefix)) refuse('audit_prefix');
    await selected(join(dir, 'report.json'), m.reportSha256);
    await selected(join(dir, 'quarantine-manifest.json'), m.quarantineSha256);
    const evidence = await proof(before, attempts, m, m.dataDir, dir);
    bound(m, before, evidence.launch);
    if (evidence.manifest.sha256 !== m.quarantineSha256) refuse('quarantine_changed');
    prefix.push(entry); runs.add(m.runId);
  }
}

/** Called under ordinary native ownership; a disposition still needs an explicit bounded retry. */
export async function terminalRejectionForLaunch(common: string, state: ConvergeRunState): Promise<boolean> {
  await verifyTerminalRejections(common, state);
  const launch = state.lastLaunch;
  const entry = state.terminalRejections?.find(e => rejectionManifest(e).runId === launch?.runId);
  if (!entry) return false;
  const m = rejectionManifest(entry);
  const before = parse(await selected(join(directory(common, m), 'native-before.json'), m.stateSha256)) as ConvergeRunState;
  if (!isDeepStrictEqual(launch, { ...before.lastLaunch, deliveryPending: false })) refuse('launch_changed');
  await selected(convergeAttemptStatePath(common, m.target), m.attemptSha256);
  deadOwner(launch!.pid); await noDelivery(m.dataDir, m.runId);
  return true;
}
