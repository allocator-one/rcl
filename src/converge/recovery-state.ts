import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { claimHistoryContent, sameClaimHistoryEvidence, type AuthenticatedClaimHistory, type ClaimHistoryContent } from '../evidence/claim-recovery/carrier-inventory.js';
import { deriveCurrentClaimProjection, type CurrentClaimProjection } from '../evidence/claim-recovery/validation/current-projection.js';
import { nativeMaterial, operationOccurrences, packNativeMaterial } from '../evidence/claim-recovery/validation/native-material.js';
import { deriveNativeOccurrenceEvidence, type NativeOccurrenceInput } from '../evidence/claim-recovery/validation/native-occurrences.js';
import { validateRetainedNativeEvidence, effectivePendingIdentities, recoveryAnchors,
  validateNativeRecoveryOperationInput, verifyNativeRecoveryLineage,
  MAX_NATIVE_RECOVERY_SNAPSHOT_BYTES } from '../evidence/claim-recovery/validation/native-state.js';
import type { NativeCorrectionAnchor } from '../evidence/claim-recovery/validation/anchors.js';
import type { EventReceipt } from '../evidence/claim-recovery/validation/receipts.js';
import type { RecoveryMaterial } from '../evidence/claim-recovery/validation/materials.js';
import { validateRecoveryMaterials } from '../evidence/claim-recovery/validation/materials.js';
import type { ConvergeRunState, NativeRecoveryOperation } from '../evidence/claim-recovery/validation/types.js';
import { decodeRecoveryOriginal } from '../evidence/claim-recovery/validation/recovery-json.js';
import { object } from '../evidence/claim-recovery/validation/primitives.js';
import { inspectRecoveryDirectory } from '../evidence/original-run/lock-path.js';
import { syncDirectory } from '../evidence/original-run/journal.js';
import { readStable } from '../telemetry/recovery/files.js';
import { assertRecoveryTargetOwnership, withOwnedNativeOperation, type NativeTargetOwnership } from './target-ownership.js';
import { convergeRunStatePath, loadConvergeRunStateEvidence } from './run-state.js';

const MAX_BYTES = 64 * 1024 * 1024;
export { MAX_NATIVE_RECOVERY_SNAPSHOT_BYTES };
const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const requireSource: (valid: unknown) => asserts valid = (valid): asserts valid => {
  if (!valid) throw new Error('native_recovery_source_conflict');
};

export interface NativeRecoveryInput extends NativeOccurrenceInput {
  sourceJson: string;
  recoveryMaterials?: RecoveryMaterial[];
  externalMaterial?: boolean;
  currentHistory?: ClaimHistoryContent;
  target: string;
  operationId: string;
  anchors: NativeCorrectionAnchor[];
  reports: string[];
  sourceReceipts: EventReceipt[];
  nativeSourceJsons?: string[];
}

export interface NativeRecoveryPlan extends NativeRecoveryInput {
  sourceVersion: 1 | 2 | 3;
  sourceSha256: string;
  resultSha256: string;
  resultJson: string;
  actionableIdentities: string[];
}

function mergeMaterials(first: RecoveryMaterial[], second: RecoveryMaterial[]): RecoveryMaterial[] {
  const rows = new Map<string, RecoveryMaterial>();
  for (const row of [...first, ...second]) {
    const old = rows.get(row.sha256);
    requireSource(!old || old.text === row.text);
    rows.set(row.sha256, row);
  }
  return [...rows.values()];
}

/** Pure exact-byte preview. Effectful authority is checked by applyNativeRecovery. */
export function deriveNativeRecovery(
  input: NativeRecoveryInput,
  projectionVersion: CurrentClaimProjection['version'] = 2,
): NativeRecoveryPlan {
  try {
    const source = verifyNativeRecoveryLineage(input.sourceJson, input.target, input.nativeSourceJsons).state;
    validateNativeRecoveryOperationInput(input);
    const priorOccurrences = source.recovery?.operations.flatMap(operation => {
      const value = operationOccurrences(operation, input.recoveryMaterials ?? []);
      return value ? [value] : [];
    }) ?? [];
    const occurrences = deriveNativeOccurrenceEvidence(input, {
      target: input.target,
      sourceJson: input.sourceJson,
      nativeSourceJsons: input.nativeSourceJsons,
      anchors: [...recoveryAnchors(source), ...input.anchors],
      previous: priorOccurrences,
    });
    const currentProjection = input.currentHistory
      ? deriveCurrentClaimProjection(source, [...recoveryAnchors(source), ...input.anchors],
          [...priorOccurrences, ...(occurrences ? [occurrences] : [])], input.currentHistory,
          input.nativeSourceJsons, input.sourceJson, projectionVersion)
      : undefined;
    requireSource(!currentProjection || input.externalMaterial);
    const packed = input.externalMaterial && (occurrences || currentProjection)
      ? packNativeMaterial({ ...(occurrences ? { occurrences } : {}), ...(currentProjection ? { currentProjection } : {}) })
      : undefined;
    const operation: NativeRecoveryOperation = {
      operationId: input.operationId,
      sourceVersion: source.version,
      sourceSha256: sha(input.sourceJson),
      anchors: structuredClone(input.anchors),
      sourceReceipts: structuredClone(input.sourceReceipts),
      ...(packed ? { material: packed.reference } : occurrences ? { occurrences } : {}),
    };
    const materials = packed
      ? mergeMaterials(input.recoveryMaterials ?? [], packed.materials)
      : structuredClone(input.recoveryMaterials ?? []);
    const result: ConvergeRunState = {
      ...source,
      version: 3,
      sightings: source.sightings ?? [],
      recovery: {
        version: packed || source.recovery?.version === 2 ? 2 : 1,
        operations: [...(source.recovery?.operations ?? []), operation],
      },
    };
    const resultJson = `${JSON.stringify(result, null, 2)}\n`;
    requireSource(Buffer.byteLength(resultJson) <= MAX_BYTES);
    return {
      ...structuredClone(input),
      ...(packed ? { recoveryMaterials: materials } : {}),
      sourceVersion: source.version,
      sourceSha256: operation.sourceSha256,
      resultJson,
      resultSha256: sha(resultJson),
      actionableIdentities: effectivePendingIdentities(result),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('native_recovery_')) throw error;
    throw new Error('native_recovery_source_conflict', { cause: error });
  }
}

export function nativeRecoveryPlanProjectionVersion(plan: NativeRecoveryPlan): CurrentClaimProjection['version'] {
  if (!plan.currentHistory) return 2;
  requireSource(sha(plan.resultJson) === plan.resultSha256);
  const result = decodeState(plan.resultJson, plan.target);
  const operation = result.recovery?.operations.at(-1);
  requireSource(operation?.operationId === plan.operationId && operation.sourceSha256 === plan.sourceSha256 && operation.material);
  const projection = nativeMaterial(operation!.material!, plan.recoveryMaterials ?? []).currentProjection;
  requireSource(projection && isDeepStrictEqual(projection.history, plan.currentHistory));
  return projection!.version;
}

function materialPath(commonDir: string, target: string, digest: string): string {
  requireSource(/^[a-f0-9]{64}$/.test(digest));
  return `${convergeRunStatePath(commonDir, target)}.recovery-materials/${digest}`;
}
function snapshotPath(commonDir: string, target: string, digest: string): string {
  return `${convergeRunStatePath(commonDir, target)}.recovery-sources/${digest}.json`;
}
function reportPath(commonDir: string, target: string, digest: string): string {
  return `${convergeRunStatePath(commonDir, target)}.evidence/${digest}.json`;
}
function decodeState(raw: string, target: string): ConvergeRunState {
  const decoded = decodeRecoveryOriginal(raw, { exactNumbers: true });
  requireSource(decoded.transformations.length === 0 && object(decoded.value));
  const state = decoded.value as unknown as ConvergeRunState;
  requireSource([1, 2, 3].includes(state.version) && state.target === target && Array.isArray(state.rounds) && object(state.findings));
  return state;
}

export async function readNativeRecoveryMaterials(commonDir: string, state: ConvergeRunState): Promise<RecoveryMaterial[]> {
  const ids = [...new Set(state.recovery?.operations.flatMap(operation => operation.material?.sha256s ?? []) ?? [])];
  requireSource(ids.length <= 20_000);
  const rows: RecoveryMaterial[] = [];
  let remaining = MAX_BYTES;
  for (const id of ids) {
    const raw = await readStable(materialPath(commonDir, state.target, id), remaining);
    requireSource(raw.sha256 === id);
    remaining -= raw.raw.length;
    requireSource(remaining >= 0);
    rows.push({ sha256: id, text: raw.text });
  }
  validateRecoveryMaterials(rows);
  return rows;
}

/** Read only canonical exact predecessors, with one aggregate pre-read budget. */
export async function readNativeRecoverySourceJsons(commonDir: string, state: ConvergeRunState): Promise<string[]> {
  const snapshots: string[] = [];
  const seen = new Set<string>();
  const maximum = (state.recovery?.operations.length ?? 0) + (state.migration ? 1 : 0);
  let remaining = MAX_NATIVE_RECOVERY_SNAPSHOT_BYTES;
  let current = state;
  while (current.version === 3) {
    requireSource(snapshots.length < maximum && current.recovery?.operations.length);
    const operation = current.recovery!.operations.at(-1)!;
    requireSource(/^[a-f0-9]{64}$/.test(operation.sourceSha256) && !seen.has(operation.sourceSha256));
    seen.add(operation.sourceSha256);
    const source = await readStable(snapshotPath(commonDir, state.target, operation.sourceSha256), remaining);
    remaining -= source.raw.length;
    requireSource(remaining >= 0 && source.sha256 === operation.sourceSha256);
    snapshots.push(source.text);
    current = decodeState(source.text, state.target);
  }
  if (current.version === 2 && current.migration) {
    requireSource(snapshots.length < maximum);
    const migration = current.migration;
    requireSource(await realpath(migration.snapshotPath) ===
      await realpath(`${convergeRunStatePath(commonDir, state.target)}.v1-${migration.sourceSha256}.snapshot`));
    const source = await readStable(migration.snapshotPath, remaining);
    requireSource(source.sha256 === migration.sourceSha256 && !seen.has(source.sha256));
    snapshots.push(source.text);
  }
  return snapshots;
}

/** Validate exact retained bytes and all physical recovery reads. */
export async function validateNativeRecoveryState(state: ConvergeRunState, commonDir: string, raw?: Buffer): Promise<void> {
  try {
    requireSource(state.version === 3);
    const sourceRaw = raw ?? Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
    requireSource(sourceRaw.equals(Buffer.from(sourceRaw.toString('utf8'))));
    const sources = await readNativeRecoverySourceJsons(commonDir, state);
    const materials = await readNativeRecoveryMaterials(commonDir, state);
    const reportDigests = [...new Set([
      ...state.recovery!.operations.flatMap(operation => operation.anchors.map(anchor => anchor.source.reportSha256)),
      ...state.rounds.flatMap(round => round.reportBinding ? [round.reportBinding.reportSha256] : []),
    ])];
    let remaining = MAX_BYTES;
    const reports: string[] = [];
    for (const digest of reportDigests) {
      const report = await readStable(reportPath(commonDir, state.target, digest), remaining);
      remaining -= report.raw.length;
      requireSource(remaining >= 0 && report.sha256 === digest);
      reports.push(report.text);
    }
    validateRetainedNativeEvidence({
      sourceJson: sourceRaw.toString('utf8'), target: state.target, reports,
      nativeSourceJsons: sources, recoveryMaterials: materials,
    });
  } catch (cause) {
    throw new Error('native_recovery_state_invalid', { cause });
  }
}

async function retainRaw(path: string, raw: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await inspectRecoveryDirectory(directory, true);
  await syncDirectory(dirname(directory));
  const temporary = `${path}.${randomUUID()}.retain-tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readStable(path, MAX_BYTES)).text !== raw) throw error;
      const retained = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try { await retained.sync(); } finally { await retained.close(); }
    }
    await syncDirectory(directory);
  } finally {
    try { if (handle) await handle.close(); }
    finally { if (created) await rm(temporary, { force: true }); }
  }
}

/** Exact CAS under strict target ownership; an already-applied result is not rewritten. */
export function applyNativeRecovery(options: {
  gitCommonDir: string;
  plan: NativeRecoveryPlan;
  ownership: NativeTargetOwnership;
  history?: AuthenticatedClaimHistory;
}) {
  const plan = structuredClone(options.plan);
  const commonInput = options.gitCommonDir;
  return withOwnedNativeOperation(options.ownership, commonInput, plan.target, async ownership => {
    await assertRecoveryTargetOwnership(ownership, commonInput, plan.target);
    const commonDir = await realpath(commonInput);
    if (plan.currentHistory) {
      requireSource(options.history && sameClaimHistoryEvidence(claimHistoryContent(options.history), plan.currentHistory) &&
        Date.parse(plan.currentHistory.readWindow.completedAt) <= Date.parse(claimHistoryContent(options.history).readWindow.completedAt));
    }
    validateRecoveryMaterials(plan.recoveryMaterials ?? []);
    const expected = deriveNativeRecovery(plan, nativeRecoveryPlanProjectionVersion(plan));
    requireSource(plan.sourceVersion === expected.sourceVersion && plan.sourceSha256 === expected.sourceSha256 &&
      plan.resultJson === expected.resultJson && plan.resultSha256 === expected.resultSha256 &&
      isDeepStrictEqual(plan.actionableIdentities, expected.actionableIdentities));
    const { assertReviewCyclePair, assertNoPendingFreshReview } = await import('./fresh-review.js');
    await assertNoPendingFreshReview(commonDir, plan.target);
    await assertReviewCyclePair(commonDir, plan.target, decodeState(plan.resultJson, plan.target).cycle);
    const path = convergeRunStatePath(commonDir, plan.target);
    await inspectRecoveryDirectory(dirname(path), true);
    const observed = await readStable(path, MAX_BYTES);
    const snapshot = snapshotPath(commonDir, plan.target, plan.sourceSha256);
    if (observed.sha256 === plan.resultSha256 && observed.text === plan.resultJson) {
      await validateNativeRecoveryState(decodeState(observed.text, plan.target), commonDir, observed.raw);
      await retainRaw(path, plan.resultJson);
      return { status: 'already_applied' as const, snapshotPath: snapshot, resultSha256: plan.resultSha256 };
    }
    requireSource(observed.sha256 === plan.sourceSha256 && observed.text === plan.sourceJson);
    const native = await loadConvergeRunStateEvidence(commonDir, plan.target);
    requireSource(native?.sha256 === observed.sha256);
    await retainRaw(snapshot, plan.sourceJson);
    for (const report of plan.reports) await retainRaw(reportPath(commonDir, plan.target, sha(report)), report);
    for (const row of plan.recoveryMaterials ?? []) await retainRaw(materialPath(commonDir, plan.target, row.sha256), row.text);
    await validateNativeRecoveryState(decodeState(plan.resultJson, plan.target), commonDir, Buffer.from(plan.resultJson));
    const temporary = `${path}.${randomUUID()}.recovery-tmp`;
    try {
      await retainRaw(temporary, plan.resultJson);
      requireSource((await readStable(path, MAX_BYTES)).sha256 === plan.sourceSha256);
      await rename(temporary, path);
      await syncDirectory(dirname(path));
    } finally {
      await rm(temporary, { force: true });
    }
    return { status: 'applied' as const, snapshotPath: snapshot, resultSha256: plan.resultSha256 };
  });
}

export { effectivePendingIdentities, recoveryAnchors, verifyNativeRecoveryLineage };
