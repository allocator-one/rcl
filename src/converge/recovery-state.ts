import { deriveCurrentClaimProjection, nativeProjectionFingerprint } from '../evidence/claim-recovery/validation/current-projection.js';
import { sameClaimHistoryEvidence, claimHistoryContent, type AuthenticatedClaimHistory, type ClaimHistoryContent } from '../evidence/claim-recovery/carrier-inventory.js';
import { nativeMaterial, operationOccurrences, packNativeMaterial, type NativeMaterialReference } from '../evidence/claim-recovery/validation/native-material.js';
import type { RecoveryMaterial } from '../evidence/claim-recovery/validation/materials.js';
import { deriveNativeOccurrenceEvidence, occurrencePendingIdentities, type NativeOccurrenceInput, type NativeOccurrenceEvidence } from '../evidence/claim-recovery/validation/native-occurrences.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { claimDescriptorSchema } from '../consensus/claim-identity.js';
import { correctionAnchor, type NativeCorrectionAnchor } from './correction-anchors.js';
import type { EventReceipt } from '../evidence/event-receipts.js';
import { decodeRecoveryOriginal as decodeOriginalReport } from '../evidence/claim-recovery/validation/recovery-json.js';
import { object } from '../evidence/original-run/remote.js';
import { uuidSchema } from '../evidence/original-run/source.js';
import { inspectRecoveryDirectory } from '../evidence/original-run/lock-path.js';
import { syncDirectory } from '../evidence/original-run/journal.js';
import { readStable } from '../telemetry/recovery/files.js';
import { assertRecoveryTargetOwnership, withOwnedNativeOperation, type NativeTargetOwnership } from './target-ownership.js';
import { convergeRunStatePath, loadConvergeRunStateEvidence, type ConvergeRunState } from './run-state.js';
import { migratedLegacyPendingRound, validateSemanticState } from './semantic-state.js';

const MAX_BYTES = 64 * 1024 * 1024;
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const uuid = (value: unknown): value is string => uuidSchema.safeParse(value).success;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const requireSource = (valid: unknown): void => { if (!valid) throw new Error('native_recovery_source_conflict'); };

/** Recovery evidence never masquerades as a producer finding, round or verdict. */
export interface NativeRecoveryOperation {
  operationId: string;
  sourceVersion: 1 | 2 | 3;
  sourceSha256: string;
  anchors: NativeCorrectionAnchor[];
  sourceReceipts: EventReceipt[];
  occurrences?: NativeOccurrenceEvidence;
  material?: NativeMaterialReference;
}
export interface NativeRecoveryMetadata {
  version: 1 | 2;
  operations: NativeRecoveryOperation[];
}
export interface NativeRecoveryInput extends NativeOccurrenceInput {
  sourceJson: string;
  recoveryMaterials?: RecoveryMaterial[];
  externalMaterial?: boolean;
  currentHistory?: ClaimHistoryContent;
  target: string;
  operationId: string;
  anchors: NativeCorrectionAnchor[];
  /** Exact source bytes, not objects reserialized from the current projection. */
  reports: string[];
  sourceReceipts: EventReceipt[];
  /** Exact predecessor and (when present) original v1 migration snapshots. */
  nativeSourceJsons?: string[];
}
export interface NativeRecoveryPlan extends NativeRecoveryInput {
  sourceVersion: 1 | 2 | 3;
  sourceSha256: string;
  resultSha256: string;
  resultJson: string;
  actionableIdentities: string[];
}

function decode(raw: string): Record<string, unknown> {
  requireSource(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_BYTES);
  const decoded = decodeOriginalReport(raw, { exactNumbers: true });
  requireSource(decoded.transformations.length === 0 && object(decoded.value));
  return decoded.value as Record<string, unknown>;
}
function nativeSource(raw: string, target: string): ConvergeRunState {
  const state = decode(raw);
  requireSource((state.version === 1 || state.version === 2 || state.version === 3) && state.target === target &&
    Number.isSafeInteger(state.roundCap) && (state.roundCap as number) >= 2 && (state.roundCap as number) <= 99 &&
    Array.isArray(state.rounds) && object(state.findings) && typeof state.updatedAt === 'string');
  requireSource(state.version === 3 ? object(state.recovery) && [1, 2].includes(state.recovery.version as number) &&
    Array.isArray(state.recovery.operations) && state.recovery.operations.length > 0 : state.recovery === undefined);
  requireSource(state.version !== 1 || state.sightings === undefined && state.migration === undefined);
  const rounds = state.rounds as Record<string, unknown>[]; const seen = new Set<number>();
  const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
  for (const round of rounds) {
    requireSource(object(round) && positive(round.round) && !seen.has(round.round) && object(round.counts) &&
      ['new', 'repeat', 'suppressed', 'regating'].every(k => Number.isSafeInteger((round.counts as Record<string, unknown>)[k]) && ((round.counts as Record<string, number>)[k] ?? -1) >= 0));
    seen.add(round.round as number);
    requireSource(round.runId === undefined || uuid(round.runId));
    requireSource(round.severities === undefined || object(round.severities) && Object.entries(round.severities).every(([key, value]) =>
      identity(key) && ['critical', 'important', 'minor', 'nitpick'].includes(value as string)));
  }
  for (const [key, rawEntry] of Object.entries(state.findings as Record<string, unknown>)) {
    requireSource(identity(key) && object(rawEntry)); const entry = rawEntry as Record<string, unknown>;
    requireSource(entry.key === key && ['file', 'category', 'title', 'severity'].every(k => typeof entry[k] === 'string') &&
      ['critical', 'important', 'minor', 'nitpick'].includes(entry.severity as string) && Array.isArray(entry.models) && entry.models.every(m => typeof m === 'string') &&
      Number.isSafeInteger(entry.startLine) && Number.isSafeInteger(entry.endLine) && (entry.startLine as number) >= 0 && (entry.endLine as number) >= (entry.startLine as number) &&
      positive(entry.firstRound) && positive(entry.lastRound) && (entry.firstRound as number) <= (entry.lastRound as number) &&
      seen.has(entry.firstRound as number) && seen.has(entry.lastRound as number));
    requireSource(entry.pendingRound === undefined || positive(entry.pendingRound) && seen.has(entry.pendingRound) && entry.pendingRound <= (entry.lastRound as number));
    requireSource(entry.verdict === undefined ? entry.verdictRound === undefined && entry.verdictSeverity === undefined :
      ['fixed', 'dismissed'].includes(entry.verdict as string) && positive(entry.verdictRound) && seen.has(entry.verdictRound));
    requireSource(entry.claimDescriptor === undefined || state.version !== 1 && claimDescriptorSchema.safeParse(entry.claimDescriptor).success);
  }
  requireSource(state.version === 1 || Array.isArray(state.sightings));
  if (state.lastAnnotations !== undefined) {
    requireSource(object(state.lastAnnotations)); const annotations = state.lastAnnotations as Record<string, unknown>;
    requireSource(positive(annotations.round) && seen.has(annotations.round) && Array.isArray(annotations.identities) &&
      annotations.identities.every(row => object(row) && identity(row.identity) && Object.hasOwn(state.findings as object, row.identity) &&
        ['new', 'repeat', 'suppressed', 'regating'].includes(row.status as string) && typeof row.gating === 'string'));
  }
  return state as unknown as ConvergeRunState;
}

/** Pure snapshot lineage proof; remote acceptance is validated separately. */
export function verifyNativeRecoveryLineage(sourceJson: string, target: string, nativeSourceJsons: string[] = []): {
  state: ConvergeRunState; original: ConvergeRunState; legacy?: ConvergeRunState; reservedIdentities: string[];
} {
  try {
    const state = nativeSource(sourceJson, target);
    requireSource(Array.isArray(nativeSourceJsons));
    const snapshots = new Map(nativeSourceJsons.map(raw => [sha(raw), raw]));
    requireSource(snapshots.size === nativeSourceJsons.length);
    const used = new Set<string>();
    const take = (digest: string): ConvergeRunState => {
      requireSource(/^[a-f0-9]{64}$/.test(digest) && !used.has(digest) && snapshots.has(digest));
      used.add(digest); return nativeSource(snapshots.get(digest)!, target);
    };
    let current = state;
    const reserved = new Set<string>();
    if (state.version === 3) for (const anchor of recoveryAnchors(state)) {
      requireSource(identity(anchor.identity) && !reserved.has(anchor.identity)); reserved.add(anchor.identity);
    }
    while (current.version === 3) {
      const operations = current.recovery!.operations; const operation = operations.at(-1)!;
      requireSource(object(operation) && uuid(operation.operationId));
      const predecessor = take(operation.sourceSha256);
      requireSource(operation.sourceVersion === predecessor.version &&
        isDeepStrictEqual(operations.slice(0, -1), predecessor.recovery?.operations ?? []) &&
        isDeepStrictEqual(current.migration, predecessor.migration) &&
        predecessor.rounds.every(round => isDeepStrictEqual(current.rounds.find(row => row.round === round.round), round)) &&
        Object.keys(predecessor.findings).every(key => Object.hasOwn(current.findings, key)));
      current = predecessor;
    }
    let legacy = current.version === 1 ? current : undefined;
    if (current.version === 2 && current.migration) {
      legacy = take(current.migration.sourceSha256);
      requireSource(legacy.version === 1 && legacy.rounds.every(round => isDeepStrictEqual(current.rounds.find(row => row.round === round.round), round)) &&
        Object.keys(legacy.findings).every(key => Object.hasOwn(current.findings, key)));
    }
    requireSource(used.size === snapshots.size);
    return { state, original: current, ...(legacy ? { legacy } : {}), reservedIdentities: [...reserved].sort() };
  } catch (cause) { throw new Error('native_recovery_lineage_conflict', { cause }); }
}

function validateAnchors(input: NativeRecoveryInput, source: ConvergeRunState): void {
  requireSource(uuid(input.operationId) && input.target.trim() === input.target && input.target.length > 0 &&
    Array.isArray(input.anchors) && (input.anchors.length > 0 ||
      [input.transfers, input.dispositions, input.carriers].some(rows => Array.isArray(rows) && rows.length > 0)) && Array.isArray(input.reports) && Array.isArray(input.sourceReceipts));
  requireSource(input.transfers === undefined || Array.isArray(input.transfers));
  requireSource(input.dispositions === undefined || Array.isArray(input.dispositions));
  const reports = new Map(input.reports.map(raw => [sha(raw), raw]));
  requireSource(reports.size === input.reports.length);
  const receipts = new Map(input.sourceReceipts.map(receipt => [receipt.id, receipt]));
  requireSource(receipts.size === input.sourceReceipts.length);
  const usedReports = new Set<string>(); const usedReceipts = new Set<string>();
  const identities = new Set<string>(); const members = new Set<string>(); const eventIds = new Set<string>();
  const destination = input.anchors[0]?.destination;
  const prior = recoveryAnchors(source);
  requireSource(source.version !== 3 || source.recovery!.operations.every(operation => operation.operationId !== input.operationId));
  for (const anchor of input.anchors) {
    requireSource(object(anchor) && anchor.operationId === input.operationId && identity(anchor.identity) &&
      !Object.hasOwn(source.findings, anchor.identity) && !prior.some(existing => existing.identity === anchor.identity) && !identities.has(anchor.identity));
    identities.add(anchor.identity);
    requireSource(['base_url', 'org_id', 'repo', 'pr_number'].every(field =>
      anchor.destination[field as keyof typeof destination] === destination![field as keyof NonNullable<typeof destination>]));
    const event = decode(anchor.eventJson); const payload = event.payload as Record<string, unknown>;
    requireSource(object(payload) && Array.isArray(payload.source_event_ids) && payload.source_event_ids.length >= 1 && payload.source_event_ids.length <= 2 &&
      payload.source_event_ids.every(uuid) && !eventIds.has(event.id as string));
    eventIds.add(event.id as string);
    const raw = reports.get(anchor.source.reportSha256); requireSource(raw !== undefined); usedReports.add(anchor.source.reportSha256);
    const ids = payload.source_event_ids as string[];
    const selected = ids.map(id => { const receipt = receipts.get(id); requireSource(receipt !== undefined); usedReceipts.add(id); return receipt!; });
    const expected = correctionAnchor({ scope: anchor.destination, target: input.target, eventId: event.id as string,
      occurredAt: event.occurred_at as string, nativeJson: input.sourceJson, reportJson: raw!, findingRef: anchor.source.findingRef,
      ...(input.nativeSourceJsons ? { nativeSourceJsons: input.nativeSourceJsons } : {}),
      previousIdentity: anchor.source.previousIdentity, identity: anchor.identity, descriptor: anchor.descriptor,
      reason: payload.reason as string, expectedEventSequence: payload.expected_event_sequence as number,
      classificationId: ids[0]!, ...(ids[1] ? { correctionId: ids[1] } : {}), sourceReceipts: selected },
    anchor.receipt, anchor.receipt.actor_user_id!, input.operationId);
    requireSource(isDeepStrictEqual(expected, anchor));
    const member = JSON.stringify([anchor.destination, anchor.source.runId, anchor.source.reportSha256, anchor.source.findingRef]);
    requireSource(!members.has(member)); members.add(member);
  }
  requireSource(usedReports.size === reports.size && usedReceipts.size === receipts.size);
}

/** Pure exact-byte preview. No clock, identifier allocation, filesystem or network. */
export function deriveNativeRecovery(input: NativeRecoveryInput): NativeRecoveryPlan {
  try {
    const source = verifyNativeRecoveryLineage(input.sourceJson, input.target, input.nativeSourceJsons).state;
    validateAnchors(input, source);
    const occurrences = deriveNativeOccurrenceEvidence(input, { target: input.target, sourceJson: input.sourceJson,
      nativeSourceJsons: input.nativeSourceJsons, anchors: [...recoveryAnchors(source), ...input.anchors],
      previous: source.recovery?.operations.flatMap(op => { const value = operationOccurrences(op, input.recoveryMaterials ?? []); return value ? [value] : []; }) ?? [] });
    const priorOccurrences=source.recovery?.operations.flatMap(op=>{const value=operationOccurrences(op,input.recoveryMaterials??[]);return value?[value]:[];})??[];
    const currentProjection=input.currentHistory?deriveCurrentClaimProjection(source,[...recoveryAnchors(source),...input.anchors],
      [...priorOccurrences,...(occurrences?[occurrences]:[])],input.currentHistory,input.nativeSourceJsons,input.sourceJson):undefined;
    requireSource(!currentProjection || input.externalMaterial);
    const packed = input.externalMaterial && (occurrences || currentProjection) ? packNativeMaterial({ ...(occurrences?{occurrences}:{}),...(currentProjection?{currentProjection}:{}) }) : undefined;
    const operation: NativeRecoveryOperation = { operationId: input.operationId, sourceVersion: source.version,
      sourceSha256: sha(input.sourceJson), anchors: structuredClone(input.anchors), sourceReceipts: structuredClone(input.sourceReceipts), ...(packed ? { material: packed.reference } : occurrences ? { occurrences } : {}) };
    const result: ConvergeRunState = { ...source, version: 3, sightings: source.sightings ?? [],
      recovery: { version: packed || source.recovery?.version === 2 ? 2 : 1, operations: [...(source.recovery?.operations ?? []), operation] } };
    const resultJson = JSON.stringify(result, null, 2) + '\n'; requireSource(Buffer.byteLength(resultJson) <= MAX_BYTES);
    return { ...structuredClone(input), ...(packed ? { recoveryMaterials: mergeMaterials(input.recoveryMaterials ?? [], packed.materials) } : {}), sourceVersion: source.version, sourceSha256: operation.sourceSha256,
      resultJson, resultSha256: sha(resultJson), actionableIdentities: effectivePendingIdentities(result) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('native_recovery_')) throw error;
    throw new Error('native_recovery_source_conflict', { cause: error });
  }
}

export function recoveryAnchors(state: ConvergeRunState): NativeCorrectionAnchor[] {
  return state.version === 3 ? state.recovery!.operations.flatMap(operation => operation.anchors) : [];
}
/** All native resolution consumers must count independent recovered occurrences. */
export function effectivePendingIdentities(state: ConvergeRunState): string[] {
  const current=state.recovery?.operations.at(-1)?.material?.current;
  if(current && current.nativeFingerprint===nativeProjectionFingerprint(state))return [...current.actionableIdentities];
  const pending = Object.values(state.findings).filter(entry => entry.pendingRound !== undefined ||
    state.version === 3 && entry.claimDescriptor === undefined && migratedLegacyPendingRound(entry, state) !== undefined).map(entry => entry.key);
  const occurrences = state.recovery?.operations.flatMap(operation => operation.occurrences ? [operation.occurrences] : []).at(-1);
  return [...new Set([...pending, ...occurrencePendingIdentities(occurrences), ...(state.recovery?.operations.at(-1)?.material?.pendingIdentities ?? []),
    ...recoveryAnchors(state).filter(anchor => anchor.source.gating !== 'none').map(anchor => anchor.identity)])].sort();
}
function mergeMaterials(first: RecoveryMaterial[], second: RecoveryMaterial[]): RecoveryMaterial[] {
  const rows = new Map<string,RecoveryMaterial>();
  for(const row of [...first,...second]) { const old=rows.get(row.sha256);requireSource(!old || old.text===row.text);rows.set(row.sha256,row); }
  return [...rows.values()];
}
function materialPath(commonDir:string,target:string,digest:string):string {
  requireSource(/^[a-f0-9]{64}$/.test(digest));return `${convergeRunStatePath(commonDir,target)}.recovery-materials/${digest}`;
}
export async function readNativeRecoveryMaterials(commonDir:string,state:ConvergeRunState):Promise<RecoveryMaterial[]> {
  const ids=[...new Set(state.recovery?.operations.flatMap(op=>op.material?.sha256s ?? []) ?? [])];
  requireSource(ids.length<=20000);const rows:RecoveryMaterial[]=[];let bytes=0;
  for(const id of ids){const raw=await readStable(materialPath(commonDir,state.target,id),MAX_BYTES);requireSource(raw.sha256===id);
    bytes+=Buffer.byteLength(raw.text);requireSource(bytes<=MAX_BYTES);rows.push({sha256:id,text:raw.text});}
  for(const op of state.recovery?.operations??[])if(op.material){requireSource(state.recovery?.version===2);nativeMaterial(op.material,rows);}
  return rows;
}
function snapshotPath(commonDir: string, target: string, digest: string): string {
  return `${convergeRunStatePath(commonDir, target)}.recovery-sources/${digest}.json`;
}
function reportPath(commonDir: string, target: string, digest: string): string {
  return `${convergeRunStatePath(commonDir, target)}.evidence/${digest}.json`;
}

/** Read only canonical, exact native predecessors; never discover unrelated targets. */
export async function readNativeRecoverySourceJsons(gitCommonDir: string, state: ConvergeRunState): Promise<string[]> {
  const snapshots: string[] = []; const seen = new Set<string>();
  let current = state;
  while (current.version === 3) {
    requireSource(object(current.recovery) && [1, 2].includes(current.recovery.version as number) &&
      Array.isArray(current.recovery.operations) && current.recovery.operations.length > 0);
    const operation = current.recovery!.operations.at(-1)!;
    requireSource(object(operation) && /^[a-f0-9]{64}$/.test(operation.sourceSha256) && !seen.has(operation.sourceSha256));
    seen.add(operation.sourceSha256);
    const source = await readStable(snapshotPath(gitCommonDir, state.target, operation.sourceSha256), MAX_BYTES);
    requireSource(source.sha256 === operation.sourceSha256); snapshots.push(source.text);
    current = nativeSource(source.text, state.target);
  }
  if (current.version === 2 && current.migration) {
    const migration = current.migration;
    requireSource(/^[a-f0-9]{64}$/.test(migration.sourceSha256));
    requireSource(await realpath(migration.snapshotPath) === await realpath(`${convergeRunStatePath(gitCommonDir, state.target)}.v1-${migration.sourceSha256}.snapshot`));
    const source = await readStable(migration.snapshotPath, MAX_BYTES);
    requireSource(source.sha256 === migration.sourceSha256 && !seen.has(source.sha256)); snapshots.push(source.text);
  }
  return snapshots;
}

function ancestorsOf(source: ConvergeRunState, snapshots: Map<string, string>): string[] {
  const selected: string[] = []; let current = source; const seen = new Set<string>();
  const take = (digest: string) => {
    requireSource(!seen.has(digest) && snapshots.has(digest)); seen.add(digest);
    const raw = snapshots.get(digest)!; selected.push(raw); return nativeSource(raw, source.target);
  };
  while (current.version === 3) current = take(current.recovery!.operations.at(-1)!.sourceSha256);
  if (current.version === 2 && current.migration) take(current.migration.sourceSha256);
  return selected;
}

/** Validate immutable conversion provenance before any v3 read is usable. */
export async function validateNativeRecoveryState(state: ConvergeRunState, gitCommonDir: string, raw?: Buffer): Promise<void> {
  try {
    if (raw) requireSource(raw.equals(Buffer.from(raw.toString('utf8'))) && isDeepStrictEqual(decode(raw.toString('utf8')), state));
    requireSource(state.version === 3);
    const sources = await readNativeRecoverySourceJsons(gitCommonDir, state);
    const lineage = verifyNativeRecoveryLineage(raw?.toString('utf8') ?? JSON.stringify(state), state.target, sources);
    const snapshots = new Map(sources.map(text => [sha(text), text]));
    const recoveryMaterials=await readNativeRecoveryMaterials(gitCommonDir,state);
    for (const operation of state.recovery!.operations) {
      const sourceJson = snapshots.get(operation.sourceSha256)!; const source = nativeSource(sourceJson, state.target);
      const reports = await Promise.all([...new Set(operation.anchors.map(anchor => anchor.source.reportSha256))]
        .map(async digest => (await readStable(reportPath(gitCommonDir, state.target, digest), MAX_BYTES)).text));
      const occurrences=operationOccurrences(operation,recoveryMaterials);
      const plan = deriveNativeRecovery({ sourceJson, recoveryMaterials, externalMaterial: !!operation.material,
        ...(operation.material && nativeMaterial(operation.material,recoveryMaterials).currentProjection ? {currentHistory:nativeMaterial(operation.material,recoveryMaterials).currentProjection!.history}:{}), target: state.target, operationId: operation.operationId,
        nativeSourceJsons: ancestorsOf(source, snapshots), anchors: operation.anchors, sourceReceipts: operation.sourceReceipts, reports,
        ...(occurrences ? { transfers: occurrences.transfers, dispositions: occurrences.dispositions,
          carriers: occurrences.carriers } : {}) });
      const initial = JSON.parse(plan.resultJson) as ConvergeRunState;
      requireSource(isDeepStrictEqual(operation, initial.recovery!.operations.at(-1)));
    }
    if (lineage.original.version === 2) await validateSemanticState(lineage.original, gitCommonDir);
    await validateSemanticState(state, gitCommonDir, lineage.original.version === 1 ? lineage.original : undefined);
  } catch (cause) { throw new Error('native_recovery_state_invalid', { cause }); }
}

async function retainRaw(path: string, raw: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await inspectRecoveryDirectory(dirname(path), true); await syncDirectory(dirname(dirname(path)));
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readStable(path, MAX_BYTES)).text !== raw) throw error;
    const retained = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await retained.sync(); } finally { await retained.close(); }
    await syncDirectory(dirname(path)); return;
  }
  try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}

/** Exact CAS under strict target ownership; an already-applied result is not rewritten. */
export function applyNativeRecovery(options: { gitCommonDir: string; plan: NativeRecoveryPlan; ownership: NativeTargetOwnership; history?: AuthenticatedClaimHistory }) {
  // Pin at invocation, before the first await or any caller mutation.
  const plan = structuredClone(options.plan); const gitCommonDir = options.gitCommonDir;
  return withOwnedNativeOperation(options.ownership, gitCommonDir, plan.target, async ownership => {
    await assertRecoveryTargetOwnership(ownership, gitCommonDir, plan.target);
    const commonDir = await realpath(gitCommonDir);
    if(plan.currentHistory)requireSource(options.history && sameClaimHistoryEvidence(claimHistoryContent(options.history),plan.currentHistory) &&
      Date.parse(plan.currentHistory.readWindow.completedAt)<=Date.parse(claimHistoryContent(options.history).readWindow.completedAt));
    const expected = deriveNativeRecovery(plan);
    requireSource(plan.sourceVersion === expected.sourceVersion && plan.sourceSha256 === expected.sourceSha256 &&
      plan.resultJson === expected.resultJson && plan.resultSha256 === expected.resultSha256 &&
      isDeepStrictEqual(plan.actionableIdentities, expected.actionableIdentities));
    const path = convergeRunStatePath(commonDir, plan.target);
    await inspectRecoveryDirectory(dirname(path), true);
    const observed = await readStable(path, MAX_BYTES);
    const snapshot = snapshotPath(commonDir, plan.target, plan.sourceSha256);
    if (observed.sha256 === plan.resultSha256 && observed.text === plan.resultJson) {
      await validateNativeRecoveryState(JSON.parse(observed.text), commonDir);
      // A previous invocation may have lost its acknowledgement after rename
      // or during directory fsync. Re-prove durability without rewriting it.
      await retainRaw(path, plan.resultJson);
      return { status: 'already_applied' as const, snapshotPath: snapshot, resultSha256: plan.resultSha256 };
    }
    requireSource(observed.sha256 === plan.sourceSha256 && observed.text === plan.sourceJson);
    const native = await loadConvergeRunStateEvidence(commonDir, plan.target);
    requireSource(native?.sha256 === observed.sha256);
    await retainRaw(snapshot, plan.sourceJson);
    for (const report of plan.reports) await retainRaw(reportPath(commonDir, plan.target, sha(report)), report);
    for (const row of plan.recoveryMaterials ?? []) await retainRaw(materialPath(commonDir,plan.target,row.sha256),row.text);
    await validateNativeRecoveryState(JSON.parse(plan.resultJson), commonDir);
    const temporary = `${path}.${randomUUID()}.recovery-tmp`;
    try {
      await retainRaw(temporary, plan.resultJson);
      requireSource((await readStable(path, MAX_BYTES)).sha256 === plan.sourceSha256);
      await rename(temporary, path); await syncDirectory(dirname(path));
    } finally { await rm(temporary, { force: true }); }
    return { status: 'applied' as const, snapshotPath: snapshot, resultSha256: plan.resultSha256 };
  });
}
