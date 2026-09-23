import { deriveCurrentClaimProjection, nativeProjectionFingerprint } from './current-projection.js';
import { claimHistoryContent, type AuthenticatedClaimHistory, type ClaimHistoryContent } from '../carrier-inventory.js';
import { nativeMaterial, operationOccurrences, packNativeMaterial } from './native-material.js';
import type { RecoveryMaterial } from './materials.js';
import { deriveNativeOccurrenceEvidence, occurrencePendingIdentities, type NativeOccurrenceInput } from './native-occurrences.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { claimDescriptorSchema } from './claims.js';
import { correctionAnchor, type NativeCorrectionAnchor } from './anchors.js';
import type { EventReceipt } from './receipts.js';
import { decodeRecoveryOriginal as decodeOriginalReport } from './recovery-json.js';
import { object, uuidSchema } from './primitives.js';
import type { ConvergeRunState } from './types.js';
import { migratedLegacyPendingRound } from './obligations.js';
import { validateSemanticState } from './semantic-validation.js';
import type { RetainedSources, SourcePathRequirement } from './sources.js';

const MAX_BYTES = 64 * 1024 * 1024;
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const uuid = (value: unknown): value is string => uuidSchema.safeParse(value).success;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const requireSource = (valid: unknown): void => { if (!valid) throw new Error('native_recovery_source_conflict'); };

interface NativeRecoveryInput extends NativeOccurrenceInput {
  sourceJson: string;
  target: string;
  operationId: string;
  anchors: NativeCorrectionAnchor[];
  /** Exact source bytes, not objects reserialized from the current projection. */
  reports: string[];
  sourceReceipts: EventReceipt[];
  /** Exact predecessor and (when present) original v1 migration snapshots. */
  nativeSourceJsons?: string[];
  recoveryMaterials?: RecoveryMaterial[];
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

/** Exact bytes supplied by an outer reader; no filesystem or authenticated-read qualification is implied. */
export interface RetainedNativeEvidence {
  sourceJson: string;
  target: string;
  reports: string[];
  nativeSourceJsons?: string[];
  recoveryMaterials?: RecoveryMaterial[];
}
export interface LegacyClaimEvidence {
  kind: 'legacy-identity';
  identity: string;
  /** Present only when recorded in the original native entry. */
  recordedPendingRound?: number;
  /** Existing migration rule, reported separately; no migration or descriptor is created. */
  migrationPendingRound?: number;
}
export interface ContentValidatedNative {
  qualification: 'content-only';
  state: ConvergeRunState;
  sourceSha256: string;
  reservedIdentities: string[];
  actionableIdentities: string[];
  legacyClaims: LegacyClaimEvidence[];
  /** Unperformed physical path/private-directory checks required before any effect. */
  filesystemRequirements: SourcePathRequirement[];
}

/**
 * Revalidate pinned native content, immutable report membership and v3 receipts.
 * This never reads paths, authenticates receipts, acquires ownership, writes state,
 * migrates a producer or acknowledges that any filesystem requirement is met.
 */
// Pure content replays recur through immutable predecessor proofs. Cache only
// fully validated content, keyed by every supplied byte and selector. Physical
// reads and authenticated authority are deliberately outside this cache.
const contentCache=new Map<string,{value:ContentValidatedNative;bytes:number}>();let contentCacheBytes=0;
function contentKey(input:RetainedNativeEvidence):string {
  const contentHash=(text:string)=>createHash('sha256').update(text,'utf16le').digest('hex');
  return sha(JSON.stringify({version:1,target:input.target,source:contentHash(input.sourceJson),reports:input.reports.map(contentHash),
    ancestors:(input.nativeSourceJsons??[]).map(contentHash),materials:(input.recoveryMaterials??[]).map(row=>[row.sha256,contentHash(row.text)])}));
}
export function validateRetainedNativeEvidence(input: RetainedNativeEvidence): ContentValidatedNative {
  try {
    const cacheKey=contentKey(input);const cached=contentCache.get(cacheKey);
    if(cached){contentCache.delete(cacheKey);contentCache.set(cacheKey,cached);return structuredClone(cached.value);}

    requireSource(Array.isArray(input.reports));
    const lineage = verifyNativeRecoveryLineage(input.sourceJson, input.target, input.nativeSourceJsons);
    const state = lineage.state;
    const reports = new Map(input.reports.map(raw => {
      requireSource(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_BYTES);
      return [sha(raw), raw] as const;
    }));
    requireSource(reports.size === input.reports.length);
    const snapshots = new Map((input.nativeSourceJsons ?? []).map(raw => [sha(raw), raw]));
    const sources: RetainedSources = { reports, snapshots, usedReports: new Set(), pathRequirements: [] };
    if (state.version === 2) validateSemanticState(state, sources);
    if (state.version === 3) {
      for (const operation of state.recovery!.operations) {
        const sourceJson = snapshots.get(operation.sourceSha256)!;
        const source = nativeSource(sourceJson, state.target);
        const selectedReports = [...new Set(operation.anchors.map(anchor => anchor.source.reportSha256))].map(digest => {
          const raw = reports.get(digest); requireSource(raw !== undefined); sources.usedReports.add(digest);
          sources.pathRequirements.push({ kind: 'report', sha256: digest, nativePathSuffix: `.evidence/${digest}.json` });
          return raw!;
        });
        const storedOccurrences=operationOccurrences(operation,input.recoveryMaterials ?? []);
        requireSource(!operation.material || state.recovery?.version === 2);
        validateAnchors({ sourceJson, target: state.target, operationId: operation.operationId,
          nativeSourceJsons: ancestorsOf(source, snapshots), anchors: operation.anchors,
          sourceReceipts: operation.sourceReceipts, reports: selectedReports,
          ...(storedOccurrences ? { transfers: storedOccurrences.transfers, dispositions: storedOccurrences.dispositions,
            carriers: storedOccurrences.carriers } : {}) }, source);
        const occurrences = deriveNativeOccurrenceEvidence(storedOccurrences ?? {}, { target: state.target, sourceJson,
          nativeSourceJsons: ancestorsOf(source, snapshots), anchors: [...recoveryAnchors(source), ...operation.anchors],
          previous: source.recovery?.operations.flatMap(op => { const value=operationOccurrences(op,input.recoveryMaterials ?? []);return value?[value]:[];}) ?? [] });
        const currentStored=operation.material?nativeMaterial(operation.material,input.recoveryMaterials??[]).currentProjection:undefined;
        const currentProjection=currentStored?deriveCurrentClaimProjection(source,[...recoveryAnchors(source),...operation.anchors],
          [...source.recovery?.operations.flatMap(op=>{const value=operationOccurrences(op,input.recoveryMaterials??[]);return value?[value]:[];})??[],...(occurrences?[occurrences]:[])],
          currentStored.history,ancestorsOf(source,snapshots),sourceJson):undefined;
        requireSource(!currentStored || isDeepStrictEqual(currentProjection,currentStored));
        requireSource(isDeepStrictEqual(operation, { operationId: operation.operationId,
          sourceVersion: source.version, sourceSha256: sha(sourceJson),
          anchors: operation.anchors, sourceReceipts: operation.sourceReceipts, ...(operation.material ? { material: packNativeMaterial({...(occurrences?{occurrences}:{}),...(currentProjection?{currentProjection}:{})}).reference } : occurrences ? { occurrences } : {}) }));
        sources.pathRequirements.push({ kind: 'native-predecessor', sha256: operation.sourceSha256,
          nativePathSuffix: `.recovery-sources/${operation.sourceSha256}.json` });
      }
      if (lineage.original.version === 2) validateSemanticState(lineage.original, sources);
      validateSemanticState(state, sources, lineage.original.version === 1 ? lineage.original : undefined);
    }
    requireSource(sources.usedReports.size === reports.size);
    const legacyClaims: LegacyClaimEvidence[] = Object.values(state.findings).filter(entry => entry.claimDescriptor === undefined).map(entry => {
      const migrationPendingRound = migratedLegacyPendingRound(entry, state);
      return { kind: 'legacy-identity', identity: entry.key,
        ...(entry.pendingRound === undefined ? {} : { recordedPendingRound: entry.pendingRound }),
        ...(migrationPendingRound === undefined ? {} : { migrationPendingRound }) };
    });
    const result:ContentValidatedNative={ qualification: 'content-only', state, sourceSha256: sha(input.sourceJson),
      reservedIdentities: lineage.reservedIdentities, actionableIdentities: effectivePendingIdentities(state), legacyClaims,
      filesystemRequirements: [...new Map(sources.pathRequirements.map(row => [JSON.stringify(row), row])).values()] };
    const bytes=Buffer.byteLength(JSON.stringify(result));
    if(bytes<=16*1024*1024){
      while(contentCache.size>=32||contentCacheBytes+bytes>16*1024*1024){const oldest=contentCache.keys().next().value!;
        contentCacheBytes-=contentCache.get(oldest)!.bytes;contentCache.delete(oldest);}
      contentCache.set(cacheKey,{value:structuredClone(result),bytes});contentCacheBytes+=bytes;
    }
    return result;

  } catch (cause) { throw new Error('native_recovery_content_invalid', { cause }); }
}
