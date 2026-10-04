import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { convergeAttemptStatePath, validateConvergeAttemptState } from './attempt-budget.js';
import { assertNoPendingFreshReview } from './fresh-review.js';
import {
  historicalDeliveryManifest,
  historicalDeliveryReconciliationManifestSchema,
  historicalDeliveryReconciliationReceiptSchema,
  historicalServerProjectionSchema,
  validateHistoricalDeliveryReconciliationAudit,
  type HistoricalDeliveryReconciliationEntry,
  type HistoricalDeliveryReconciliationManifest,
} from './historical-delivery-reconciliation-schema.js';
import { strongDeliveryReconciliationSchema } from './launch-record.js';
import {
  convergeRunStatePath,
  loadConvergeRunStateEvidence,
  writeState,
  type ConvergeRunState,
} from './run-state.js';
import { inspectVerifiedStaleReportReceipts } from './stale-report.js';
import { readStaleObject, retainStaleFile as retain, selectedStaleFile as selected } from './stale-report-storage.js';
import type { StaleReportManifest } from './stale-report-schema.js';
import { assertDeadOwner } from './terminal-rejection.js';
import { withRecoveryTarget } from './target-ownership.js';
import { getRun } from '../evidence/reads.js';
import { decodeRecoveryDocument } from '../evidence/original-run/decode.js';
import { serializeRecoveryDocument, syncDirectory } from '../evidence/original-run/journal.js';
import { inspectRecoveryDirectory, prepareLockRoot } from '../evidence/original-run/lock-path.js';
import { normalizeUrl } from '../telemetry/credentials.js';
import { readStable, sha256 } from '../telemetry/recovery/files.js';
import type { HarnessSink } from '../telemetry/sink.js';
import type { RunDetail } from '../evidence/types.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const selectionSchema = z.object({
  target:z.string().min(1).max(200).refine(value => value.trim() === value),
  runId:z.string().uuid(),
}).strict();
const applySchema = z.object({ manifest:z.string().min(1), manifestSha256:digest }).strict();

interface HistoricalReconciliationOptions {
  getRun?: typeof getRun;
  now?: () => Date;
}

function fail(code: string): never { throw new Error(`historical_delivery_reconciliation_${code}`); }

function endpoint(value: string): string {
  const normalized = normalizeUrl(value);
  if (!normalized) fail('origin_invalid');
  return normalized;
}

function selectedServerProjection(
  sink: HarnessSink,
  detail: RunDetail,
  local: Awaited<ReturnType<typeof localAuthority>>
): z.infer<typeof historicalServerProjectionSchema> {
  const cycle = local.state.cycle;
  if (!cycle || endpoint(sink.baseUrl) !== endpoint(cycle.url)) fail('server_origin_mismatch');
  const reports = detail.artifacts?.filter(artifact => artifact.kind === 'report_json') ?? [];
  const report = reports[0];
  if (detail.id.toLowerCase() !== local.runId.toLowerCase() || detail.provenance !== 'live' ||
    detail.repo_verified !== true || detail.is_cross_repository !== false ||
    typeof detail.head_verified !== 'string' || detail.head_verified.length === 0 ||
    detail.cycle_id !== cycle.id || reports.length !== 1 || !report ||
    report.stored !== true || report.declared_sha256 !== local.reportSha256 ||
    report.declared_bytes !== local.reportBytes || detail.target.kind !== local.targetKind ||
    detail.target.repo?.toLowerCase() !== cycle.repo.toLowerCase() || detail.target.pr_number !== cycle.prNumber ||
    detail.target.head_sha !== local.headSha || detail.target.base_sha !== local.baseSha ||
    detail.target.diff_sha256 !== local.diffSha256 ||
    detail.converge?.target !== local.target || detail.converge.attempt !== local.attempt ||
    detail.converge.round !== local.round || typeof detail.received_at !== 'string') {
    fail('server_binding_mismatch');
  }
  const parsed = z.string().datetime({ offset:true }).safeParse(detail.received_at);
  if (!parsed.success) fail('server_binding_mismatch');
  return historicalServerProjectionSchema.parse({
    origin:endpoint(sink.baseUrl),runId:detail.id,provenance:'live' as const,receivedAt:detail.received_at,
    cycleId:cycle.id,repoVerified:true as const,isCrossRepository:false as const,
    headVerified:detail.head_verified,
    target:{kind:detail.target.kind as 'pr',repo:detail.target.repo!,prNumber:detail.target.pr_number!,
      headSha:detail.target.head_sha!,baseSha:detail.target.base_sha!,diffSha256:detail.target.diff_sha256!},
    converge:{target:detail.converge.target,attempt:detail.converge.attempt!,round:detail.converge.round!},
    report:{declaredSha256:report.declared_sha256!,declaredBytes:report.declared_bytes!,stored:true as const},
  });
}

async function readServerProjection(sink: HarnessSink, local: Awaited<ReturnType<typeof localAuthority>>,
  options: HistoricalReconciliationOptions) {
  const outcome = await (options.getRun ?? getRun)(sink,local.runId,{requireCompleteRead:true});
  if (outcome.kind !== 'ok') fail(`server_${outcome.kind}`);
  return selectedServerProjection(sink,outcome.value,local);
}

function commonPredecessor(proofs: Awaited<ReturnType<typeof inspectVerifiedStaleReportReceipts>>,
  target: string, runId: string) {
  type Delivered = Extract<StaleReportManifest,{version:2}>;
  const matches = proofs.filter((proof): proof is typeof proof & {m:Delivered} => proof.m.version === 2 &&
    proof.m.outcome === 'delivered-hard-failure' && proof.m.target === target &&
    proof.m.runId.toLowerCase() === runId.toLowerCase());
  if (matches.length === 0) fail('predecessor_not_found');
  const first = matches[0]!;
  const launch = first.previous;
  const marker = launch.deliveryReconciliation;
  if (marker?.version !== 1 || launch.status !== 'completed' || launch.hardFailure !== true ||
    launch.deliveryPending !== false || launch.exitCode !== 4 || !launch.reviewerHealth ||
    launch.runId !== runId || launch.reportJsonSha256 !== first.m.reportSha256 ||
    first.m.deliveryReconciliation.version !== 1 || !isDeepStrictEqual(first.m.deliveryReconciliation,marker)) {
    fail('predecessor_ineligible');
  }
  const binding = {
    target:first.m.target,runId:first.m.runId,reportSha256:first.m.reportSha256,
    headSha:first.m.previousHeadSha,inputSha256:first.m.previousInputSha256,
    attempt:first.m.attempt,round:first.m.round,cycleId:first.m.cycleId,
    marker:first.m.deliveryReconciliation,reviewerHealth:first.m.reviewerHealth,
    launch,evidence:first.evidence,
  };
  for (const proof of matches.slice(1)) {
    const candidate = {
      target:proof.m.target,runId:proof.m.runId,reportSha256:proof.m.reportSha256,
      headSha:proof.m.previousHeadSha,inputSha256:proof.m.previousInputSha256,
      attempt:proof.m.attempt,round:proof.m.round,cycleId:proof.m.cycleId,
      marker:proof.m.deliveryReconciliation,reviewerHealth:proof.m.reviewerHealth,
      launch:proof.previous,evidence:proof.evidence,
    };
    if (!isDeepStrictEqual(candidate,binding)) fail('predecessor_ambiguous');
  }
  return {binding,sourceDigests:matches.map(proof => proof.entry.manifestSha256).sort()};
}

async function deriveLocalAuthority(common: string, target: string, runId: string,
  state: ConvergeRunState, nativeSha256: string, attemptFile: Awaited<ReturnType<typeof readStable>>,
  requireDeadOwner: boolean) {
  validateHistoricalDeliveryReconciliationAudit(state);
  if (!state.cycle) fail('cycle_missing');
  const attemptsPath = convergeAttemptStatePath(common,target);
  const attempts = validateConvergeAttemptState(decodeRecoveryDocument(attemptFile.text),target,attemptsPath);
  if (!isDeepStrictEqual(attempts.cycle,state.cycle)) fail('cycle_mismatch');
  const proofs = await inspectVerifiedStaleReportReceipts(common,state.staleReportAudit ?? []);
  const {binding,sourceDigests} = commonPredecessor(proofs,target,runId);
  if (binding.cycleId !== state.cycle.id || !isDeepStrictEqual(binding.evidence.attempts.cycle,state.cycle)) {
    fail('cycle_mismatch');
  }
  const claim = attempts.attempts.find(record => record.attempt === binding.attempt && record.source === 'claim');
  if (!claim || claim.pid !== binding.launch.pid || binding.launch.pid !== binding.evidence.attempts.attempts
    .find(record => record.attempt === binding.attempt && record.source === 'claim')?.pid) fail('attempt_mismatch');
  if (requireDeadOwner) assertDeadOwner(binding.launch.pid);
  const reportTarget = binding.evidence.report.run.target;
  if (!['pr','patch'].includes(reportTarget.kind)) fail('retained_report_target_kind_mismatch');
  if (reportTarget.repo?.toLowerCase() !== state.cycle.repo.toLowerCase()) fail('retained_report_repository_mismatch');
  if (reportTarget.pr_number !== state.cycle.prNumber) fail('retained_report_pull_request_mismatch');
  if (reportTarget.head_sha !== binding.headSha) fail('retained_report_head_mismatch');
  if (!/^[a-f0-9]{40}$/.test(reportTarget.base_sha ?? '')) fail('retained_report_base_missing');
  if (!/^[a-f0-9]{64}$/.test(reportTarget.diff_sha256 ?? '')) fail('retained_report_diff_missing');
  const retainedReport = await readStaleObject(common,binding.reportSha256);
  const successor = state.lastLaunch;
  if (!successor?.runId || successor.status !== 'completed' || successor.attempt <= binding.attempt ||
    successor.runId === binding.runId) fail('successor_missing');
  const successorClaim = attempts.attempts.find(record =>
    record.attempt === successor.attempt && record.source === 'claim');
  if (attempts.attemptsUsed !== successor.attempt || !successorClaim || successorClaim.pid !== successor.pid) {
    fail('successor_attempt_mismatch');
  }
  const reconciliation = strongDeliveryReconciliationSchema.parse({version:2,runId:binding.runId,
    reportJsonSha256:binding.reportSha256,headSha:binding.headSha,inputSha256:binding.inputSha256,
    attempt:binding.attempt,round:binding.round,claimPid:binding.launch.pid,cycleId:state.cycle.id,
    reconciledAt:'1970-01-01T00:00:00.000Z'});
  return {common,target,runId,state,nativeSha256,attempts,attemptFile,attemptSha256:attemptFile.sha256,
    sourceDigests,headSha:binding.headSha,reportSha256:binding.reportSha256,attempt:binding.attempt,
    round:binding.round,reviewerHealth:binding.reviewerHealth,reconciliation,
    targetKind:reportTarget.kind as 'pr'|'patch',baseSha:reportTarget.base_sha!,
    diffSha256:reportTarget.diff_sha256,reportBytes:retainedReport.raw.byteLength,
    successor:{runId:successor.runId,attempt:successor.attempt,round:successor.round,
      headSha:successor.headSha,inputSha256:successor.inputSha256}};
}

async function localAuthority(common: string, target: string, runId: string) {
  await assertNoPendingFreshReview(common,target);
  const native = await loadConvergeRunStateEvidence(common,target);
  if (!native) fail('state_missing');
  if (native.state.historicalDeliveryReconciliationAudit?.some(entry =>
    historicalDeliveryManifest(entry).runId === runId)) fail('already_applied');
  const attemptFile = await readStable(convergeAttemptStatePath(common,target));
  return deriveLocalAuthority(common,target,runId,native.state,native.sha256,attemptFile,true);
}

function assertServerBinding(local: Awaited<ReturnType<typeof deriveLocalAuthority>>,
  server: z.infer<typeof historicalServerProjectionSchema>): void {
  const cycle=local.state.cycle;
  if (!cycle || server.origin !== endpoint(cycle.url) || server.runId.toLowerCase() !== local.runId.toLowerCase() ||
    server.cycleId !== cycle.id || server.target.kind !== local.targetKind ||
    server.target.repo.toLowerCase() !== cycle.repo.toLowerCase() || server.target.prNumber !== cycle.prNumber ||
    server.target.headSha !== local.headSha || server.target.baseSha !== local.baseSha ||
    server.target.diffSha256 !== local.diffSha256 || server.converge.target !== local.target ||
    server.converge.attempt !== local.attempt || server.converge.round !== local.round ||
    server.report.declaredSha256 !== local.reportSha256 || server.report.declaredBytes !== local.reportBytes) {
    fail('retained_server_binding_mismatch');
  }
}

function buildManifest(local: Awaited<ReturnType<typeof localAuthority>>,
  server: z.infer<typeof historicalServerProjectionSchema>, operationId: string, createdAt: string) {
  assertServerBinding(local,server);
  return historicalDeliveryReconciliationManifestSchema.parse({
    kind:'rcl-historical-delivery-reconciliation',version:1,operationId,createdAt,
    gitCommonDir:local.common,target:local.target,runId:local.runId,
    nativeStateSha256:local.nativeSha256,attemptStateSha256:local.attemptSha256,
    sourceStaleManifestSha256s:local.sourceDigests,successor:local.successor,
    reconciliation:{...local.reconciliation,reconciledAt:createdAt},
    baseSha:server.target.baseSha,diffSha256:server.target.diffSha256,
    reviewerHealth:local.reviewerHealth,server,
    serverProjectionSha256:sha256(Buffer.from(serializeRecoveryDocument(server))),
  });
}

/** Print-only qualification; callers may write the returned reviewed manifest separately. */
export async function previewHistoricalDeliveryReconciliation(input: unknown, gitCommonDir: string,
  sink: HarnessSink, options: HistoricalReconciliationOptions = {}): Promise<HistoricalDeliveryReconciliationManifest> {
  const selection = selectionSchema.parse(input);
  const common = await realpath(resolve(gitCommonDir));
  const local = await localAuthority(common,selection.target,selection.runId);
  const server = await readServerProjection(sink,local,options);
  return buildManifest(local,server,randomUUID(),(options.now ?? (() => new Date()))().toISOString());
}

function nextState(before: ConvergeRunState, entry: HistoricalDeliveryReconciliationEntry,
  at: string): ConvergeRunState {
  const {staleReportAudit,staleReportAuditCount,historicalDeliveryReconciliationAudit:audit = [],
    historicalDeliveryReconciliationAuditCount:_historicalCount,updatedAt:_updatedAt,...rest} = before;
  return {
    ...(staleReportAudit ? {staleReportAudit} : {}),...rest,
    historicalDeliveryReconciliationAudit:[...audit,entry],
    historicalDeliveryReconciliationAuditCount:audit.length+1,
    ...(staleReportAuditCount !== undefined ? {staleReportAuditCount} : {}),updatedAt:at,
  };
}

function directory(common: string, manifest: HistoricalDeliveryReconciliationManifest): string {
  return join(common,'rcl-historical-delivery-reconciliations',manifest.operationId);
}

function receiptFor(manifest: HistoricalDeliveryReconciliationManifest, manifestSha256: string,
  afterStateSha256: string) {
  return historicalDeliveryReconciliationReceiptSchema.parse({
    kind:'rcl-historical-delivery-reconciliation-receipt',version:1,
    operationId:manifest.operationId,runId:manifest.runId,manifestSha256,
    beforeStateSha256:manifest.nativeStateSha256,afterStateSha256,
    attemptStateSha256:manifest.attemptStateSha256,
    sourceStaleManifestSha256s:manifest.sourceStaleManifestSha256s,
    serverProjectionSha256:manifest.serverProjectionSha256,
  });
}

/** Reverify every authority source under the target lock, then append one local receipt atomically. */
export async function applyHistoricalDeliveryReconciliation(input: unknown, gitCommonDir: string,
  sink: HarnessSink, options: HistoricalReconciliationOptions = {}): Promise<'applied'|'unchanged'> {
  const pinned = applySchema.parse(input);
  const selectedManifest = await readStable(pinned.manifest,128 * 1024);
  if (selectedManifest.sha256 !== pinned.manifestSha256) fail('manifest_digest_mismatch');
  const manifest = historicalDeliveryReconciliationManifestSchema.parse(decodeRecoveryDocument(selectedManifest.text));
  if (selectedManifest.text !== serializeRecoveryDocument(manifest)) fail('manifest_noncanonical');
  const common = await realpath(resolve(gitCommonDir));
  if (manifest.gitCommonDir !== common) fail('repository_mismatch');
  return withRecoveryTarget(common,manifest.target,async ownership => {
    const currentFile = await readStable(convergeRunStatePath(common,manifest.target));
    const current = await loadConvergeRunStateEvidence(common,manifest.target);
    if (!current || current.sha256 !== currentFile.sha256) fail('state_missing');
    validateHistoricalDeliveryReconciliationAudit(current.state);
    await verifyHistoricalDeliveryReconciliations(common,current.state);
    const entry: HistoricalDeliveryReconciliationEntry = {
      manifestJson:selectedManifest.text,manifestSha256:selectedManifest.sha256,
    };
    const prior = current.state.historicalDeliveryReconciliationAudit?.find(entry =>
      historicalDeliveryManifest(entry).runId === manifest.runId);
    if (prior) {
      if (!isDeepStrictEqual(prior,entry)) fail('operation_conflict');
      return 'unchanged';
    }
    await assertNoPendingFreshReview(common,manifest.target);
    if (current.sha256 !== manifest.nativeStateSha256) fail('state_changed');
    const attemptFile = await readStable(convergeAttemptStatePath(common,manifest.target));
    const local = await deriveLocalAuthority(common,manifest.target,manifest.runId,current.state,
      current.sha256,attemptFile,true);
    const server = await readServerProjection(sink,local,options);
    assertServerBinding(local,server);
    const expected = buildManifest(local,server,manifest.operationId,manifest.createdAt);
    if (!isDeepStrictEqual(expected,manifest)) fail('manifest_binding_mismatch');
    const next = nextState(current.state,entry,manifest.createdAt);
    validateHistoricalDeliveryReconciliationAudit(next);
    const afterBytes = Buffer.from(serializeRecoveryDocument(next));
    const serverBytes = Buffer.from(serializeRecoveryDocument(server));
    if (sha256(serverBytes) !== manifest.serverProjectionSha256) fail('server_projection_digest_mismatch');
    const receipt = receiptFor(manifest,selectedManifest.sha256,sha256(afterBytes));
    const dir = directory(common,manifest);
    await prepareLockRoot(dirname(dir)); await syncDirectory(common);
    await prepareLockRoot(dir); await syncDirectory(dirname(dir));
    await retain(join(dir,'manifest.json'),selectedManifest.raw);
    await retain(join(dir,'native-before.json'),currentFile.raw);
    await retain(join(dir,'attempts-before.json'),attemptFile.raw);
    await retain(join(dir,'server-projection.json'),serverBytes);
    await retain(join(dir,'complete.json'),Buffer.from(serializeRecoveryDocument(receipt)));
    const finalState = await selected(convergeRunStatePath(common,manifest.target),manifest.nativeStateSha256);
    const finalAttempts = await selected(convergeAttemptStatePath(common,manifest.target),manifest.attemptStateSha256);
    const finalLocal = await deriveLocalAuthority(common,manifest.target,manifest.runId,
      decodeRecoveryDocument(finalState.text) as ConvergeRunState,finalState.sha256,finalAttempts,true);
    const finalServer = await readServerProjection(sink,finalLocal,options);
    assertServerBinding(finalLocal,finalServer);
    if (!isDeepStrictEqual(buildManifest(finalLocal,finalServer,manifest.operationId,manifest.createdAt),manifest)) {
      fail('manifest_binding_mismatch');
    }
    await verifyHistoricalDeliveryReconciliations(common,next);
    await writeState(common,next,ownership);
    await selected(convergeRunStatePath(common,manifest.target),sha256(afterBytes));
    return 'applied';
  });
}

/** Local fail-closed verification used before claims and report admission. */
export async function verifyHistoricalDeliveryReconciliations(common: string, state: ConvergeRunState): Promise<void> {
  validateHistoricalDeliveryReconciliationAudit(state);
  const audit = state.historicalDeliveryReconciliationAudit ?? [];
  if (audit.length === 0) return;
  const root = join(common,'rcl-historical-delivery-reconciliations');
  await inspectRecoveryDirectory(root,true);
  const prefix: HistoricalDeliveryReconciliationEntry[] = [];
  for (const entry of audit) {
    const manifest = historicalDeliveryManifest(entry);
    const dir = directory(common,manifest);
    await inspectRecoveryDirectory(dir,true);
    await selected(join(dir,'manifest.json'),entry.manifestSha256);
    const beforeFile = await selected(join(dir,'native-before.json'),manifest.nativeStateSha256);
    const before = decodeRecoveryDocument(beforeFile.text) as ConvergeRunState;
    if (!isDeepStrictEqual(before.historicalDeliveryReconciliationAudit ?? [],prefix)) fail('audit_prefix');
    const attemptFile = await selected(join(dir,'attempts-before.json'),manifest.attemptStateSha256);
    const serverFile = await selected(join(dir,'server-projection.json'),manifest.serverProjectionSha256);
    const server = historicalServerProjectionSchema.parse(decodeRecoveryDocument(serverFile.text));
    const local = await deriveLocalAuthority(common,manifest.target,manifest.runId,before,
      beforeFile.sha256,attemptFile,false);
    assertServerBinding(local,server);
    if (!isDeepStrictEqual(buildManifest(local,server,manifest.operationId,manifest.createdAt),manifest)) {
      fail('retained_source_mismatch');
    }
    const after = Buffer.from(serializeRecoveryDocument(nextState(before,entry,manifest.createdAt)));
    const receipt = receiptFor(manifest,entry.manifestSha256,sha256(after));
    await selected(join(dir,'complete.json'),sha256(Buffer.from(serializeRecoveryDocument(receipt))));
    prefix.push(entry);
  }
}
