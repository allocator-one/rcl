import { nativeReviewCycleSchema } from '../../../converge/review-cycle.js';
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
import type { ConvergeRunState, FindingEntry } from './types.js';
import { migratedLegacyPendingRound, verdictClearsPending } from './obligations.js';
import { validateSemanticState } from './semantic-validation.js';
import type { RetainedSources, SourcePathRequirement } from './sources.js';

const MAX_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_RECOVERY_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
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
  requireSource(state.startOverPending === undefined && (state.cycle === undefined ||
    state.version !== 1 && nativeReviewCycleSchema.safeParse(state.cycle).success));
  // Released cycle-v2 predates semantic sightings. A hybrid must not use its
  // cycle metadata to bypass the separate semantic-v2 membership requirements.
  const cycleOrigin = state.version === 2 && state.cycle !== undefined;
  requireSource(!cycleOrigin || state.sightings === undefined && state.migration === undefined);
  requireSource((state.version === 1 || state.version === 2 || state.version === 3) && state.target === target &&
    Number.isSafeInteger(state.roundCap) && (state.roundCap as number) >= 2 && (state.roundCap as number) <= 99 &&
    Array.isArray(state.rounds) && object(state.findings) && typeof state.updatedAt === 'string');
  requireSource(state.version === 3 ? object(state.recovery) && [1, 2].includes(state.recovery.version as number) &&
    Array.isArray(state.recovery.operations) && state.recovery.operations.length > 0 &&
    state.recovery.operations.every(operation => object(operation) && uuid(operation.operationId) &&
      [1, 2, 3].includes(operation.sourceVersion as number) && digest(operation.sourceSha256) &&
      Array.isArray(operation.anchors) && operation.anchors.every(anchor => object(anchor) && identity(anchor.identity)) &&
      Array.isArray(operation.sourceReceipts)) : state.recovery === undefined);
  requireSource(state.migration === undefined || object(state.migration) && digest(state.migration.sourceSha256) &&
    typeof state.migration.snapshotPath === 'string' && typeof state.migration.migratedAt === 'string');
  requireSource(state.version !== 1 || state.sightings === undefined && state.migration === undefined);
  const rounds = state.rounds as Record<string, unknown>[]; const seen = new Set<number>();
  const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
  for (const round of rounds) {
    requireSource(object(round) && positive(round.round) && round.round <= (state.roundCap as number) && !seen.has(round.round) && object(round.counts) &&
      ['new', 'repeat', 'suppressed', 'regating'].every(k => Number.isSafeInteger((round.counts as Record<string, unknown>)[k]) && ((round.counts as Record<string, number>)[k] ?? -1) >= 0));
    seen.add(round.round as number);
    requireSource(round.runId === undefined || uuid(round.runId));
    requireSource(round.severities === undefined || object(round.severities) && Object.entries(round.severities).every(([key, value]) =>
      identity(key) && ['critical', 'important', 'minor', 'nitpick'].includes(value as string)));
    requireSource(round.admission === undefined || object(round.admission) && round.admission.version === 1 &&
      Number.isSafeInteger(round.admission.recoveryOperationCount) && (round.admission.recoveryOperationCount as number) >= 0 &&
      digest(round.admission.sourceStateSha256) &&
      Array.isArray(round.admission.actionableIdentities) && round.admission.actionableIdentities.every(identity) &&
      isDeepStrictEqual(round.admission.actionableIdentities,
        [...new Set(round.admission.actionableIdentities as string[])].sort()));
    requireSource(!cycleOrigin || round.reportBinding === undefined);
  }
  const recoveryOperationCount = state.version === 3 && object(state.recovery) &&
    Array.isArray(state.recovery.operations) ? state.recovery.operations.length : 0;
  for (const round of rounds) {
    const admission = round.admission;
    requireSource(admission === undefined || object(admission) &&
      (admission.recoveryOperationCount as number) <= recoveryOperationCount);
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
    requireSource(entry.verdictSeverity === undefined || ['critical', 'important', 'minor', 'nitpick'].includes(entry.verdictSeverity as string));
    requireSource(entry.claimDescriptor === undefined || state.version !== 1 && claimDescriptorSchema.safeParse(entry.claimDescriptor).success);
    requireSource(!cycleOrigin || entry.claimDescriptor === undefined && entry.pendingRound === undefined);
  }
  // A recovered v3 descendant may omit its semantic sighting cache only
  // provisionally. The full snapshot walk below proves its released cycle-v2
  // root; this parser must not trust an operation's claimed source version.
  requireSource(state.version === 1 || cycleOrigin || Array.isArray(state.sightings) ||
    state.version === 3 && state.sightings === undefined);
  if (state.lastAnnotations !== undefined) {
    requireSource(object(state.lastAnnotations)); const annotations = state.lastAnnotations as Record<string, unknown>;
    requireSource(positive(annotations.round) && seen.has(annotations.round) && Array.isArray(annotations.identities) &&
      annotations.identities.every(row => object(row) && identity(row.identity) && Object.hasOwn(state.findings as object, row.identity) &&
        ['new', 'repeat', 'suppressed', 'regating'].includes(row.status as string) && typeof row.gating === 'string'));
    const actionableBeforeTriage = annotations.actionableBeforeTriage;
    requireSource(actionableBeforeTriage === undefined || Array.isArray(actionableBeforeTriage) &&
      actionableBeforeTriage.every(identity) &&
      isDeepStrictEqual(actionableBeforeTriage, [...new Set(actionableBeforeTriage)].sort()));
  }
  return state as unknown as ConvergeRunState;
}

function retainedFindingIdentity(current: FindingEntry, predecessor: FindingEntry): boolean {
  // Ordinary verdicts can follow recovery, and semantic sightings update their
  // caches. Their evidence is validated by the semantic proof kernel; lineage
  // preserves the original identity rather than freezing those later results.
  const mutable = new Set(['pendingRound', 'verdict', 'verdictRound', 'verdictSeverity', 'verdictReason',
    ...(predecessor.claimDescriptor ? ['lastRound', 'models', 'startLine', 'endLine', 'severity'] : [])]);
  const retained = (entry: FindingEntry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !mutable.has(key)));
  return isDeepStrictEqual(retained(current), retained(predecessor)) && current.lastRound >= predecessor.lastRound &&
    (predecessor.verdict === undefined || current.verdict !== undefined && current.verdictRound! >= predecessor.verdictRound!);
}

/** Pure snapshot lineage proof; remote acceptance is validated separately. */
function retainedRounds(current: ConvergeRunState, predecessor: ConvergeRunState): boolean {
  const rounds = new Map(current.rounds.map(round => [round.round, round]));
  return predecessor.rounds.every(round => isDeepStrictEqual(rounds.get(round.round), round));
}

/** @internal Validate the only mutations ordinary verdict recording can make without a semantic sighting ledger. */
export function validateSightinglessLegacyEvolution(state: ConvergeRunState, original: ConvergeRunState): void {
  requireSource(isDeepStrictEqual(state.rounds, original.rounds));
  requireSource(isDeepStrictEqual(Object.keys(state.findings).sort(), Object.keys(original.findings).sort()));
  requireSource(isDeepStrictEqual(state.lastAnnotations, original.lastAnnotations));
  const mutable = new Set(['pendingRound', 'verdict', 'verdictRound', 'verdictSeverity', 'verdictReason']);
  const fixed = (entry: FindingEntry) => Object.fromEntries(Object.entries(entry).filter(([field]) => !mutable.has(field)));
  const verdictTuple = (entry: FindingEntry) => ({ verdict: entry.verdict, verdictRound: entry.verdictRound,
    verdictSeverity: entry.verdictSeverity, verdictReason: entry.verdictReason });
  for (const [key, entry] of Object.entries(state.findings)) {
    const prior = original.findings[key]!;
    requireSource(isDeepStrictEqual(fixed(entry), fixed(prior)));
    const unchangedVerdict = isDeepStrictEqual(verdictTuple(entry), verdictTuple(prior));
    requireSource(entry.verdict === undefined ? entry.verdictReason === prior.verdictReason :
      entry.verdictReason === undefined || typeof entry.verdictReason === 'string');
    if (prior.verdict !== undefined) requireSource(entry.verdict !== undefined && entry.verdictRound! >= prior.verdictRound!);
    if (entry.verdict !== undefined) {
      const reviewed = state.rounds.find(round => round.round === entry.verdictRound);
      const unchangedImplicitSeverity = prior.verdict === entry.verdict && prior.verdictRound === entry.verdictRound &&
        prior.verdictSeverity === undefined && entry.verdictSeverity === undefined;
      requireSource(reviewed !== undefined && (unchangedImplicitSeverity || reviewed.severities?.[key] !== undefined));
      requireSource(unchangedImplicitSeverity || entry.verdictSeverity === reviewed?.severities?.[key]);
    }
    const clearsPrior = prior.pendingRound !== undefined && entry.verdict !== undefined &&
      verdictClearsPending(state, key, prior.pendingRound, entry.verdictRound!, entry.verdictSeverity);
    const expectedPending = prior.pendingRound !== undefined && !clearsPrior ? prior.pendingRound : undefined;
    requireSource(unchangedVerdict ? entry.pendingRound === prior.pendingRound || clearsPrior && entry.pendingRound === undefined :
      entry.pendingRound === expectedPending);
  }
}

export function verifyNativeRecoveryLineage(sourceJson: string, target: string, nativeSourceJsons: string[] = []): {
  state: ConvergeRunState; original: ConvergeRunState; legacy?: ConvergeRunState; reservedIdentities: string[];
} {
  try {
    const state = nativeSource(sourceJson, target);
    requireSource(Array.isArray(nativeSourceJsons));
    const maximumSnapshots = (state.recovery?.operations.length ?? 0) + (state.migration ? 1 : 0);
    requireSource(nativeSourceJsons.length <= maximumSnapshots);
    // Bound the whole ancestry before hashing any predecessor. Oversized
    // histories remain retained but cannot be admitted to an in-memory proof.
    let snapshotBytes = 0;
    for (const raw of nativeSourceJsons) {
      requireSource(typeof raw === 'string' && raw.length <= MAX_NATIVE_RECOVERY_SNAPSHOT_BYTES - snapshotBytes);
      snapshotBytes += Buffer.byteLength(raw);
      requireSource(snapshotBytes <= MAX_NATIVE_RECOVERY_SNAPSHOT_BYTES);
    }
    const snapshots = new Map(nativeSourceJsons.map(raw => [sha(raw), raw]));
    requireSource(snapshots.size === nativeSourceJsons.length);
    const used = new Set<string>();
    const take = (digest: string): ConvergeRunState => {
      requireSource(/^[a-f0-9]{64}$/.test(digest) && !used.has(digest) && snapshots.has(digest));
      used.add(digest); return nativeSource(snapshots.get(digest)!, target);
    };
    let current = state;
    let requiresReleasedCycleRoot = false;
    const reserved = new Set<string>();
    if (state.version === 3) for (const anchor of recoveryAnchors(state)) {
      requireSource(identity(anchor.identity) && !reserved.has(anchor.identity)); reserved.add(anchor.identity);
    }
    while (current.version === 3) {
      requiresReleasedCycleRoot ||= current.sightings === undefined;
      const operations = current.recovery!.operations; const operation = operations.at(-1)!;
      requireSource(object(operation) && uuid(operation.operationId));
      const predecessor = take(operation.sourceSha256);
      requireSource(operation.sourceVersion === predecessor.version &&
        isDeepStrictEqual(operations.slice(0, -1), predecessor.recovery?.operations ?? []) &&
        isDeepStrictEqual(current.migration, predecessor.migration) &&
        isDeepStrictEqual(current.cycle, predecessor.cycle) &&
        current.roundCap === predecessor.roundCap &&
        retainedRounds(current, predecessor) &&
        Object.entries(predecessor.findings).every(([key, finding]) =>
          Object.hasOwn(current.findings, key) && retainedFindingIdentity(current.findings[key]!, finding)));
      current = predecessor;
    }
    // A sighting-less recovery can start at either exact legacy boundary:
    // native-v1, or the released cycle-v2 format that also predates semantic
    // sightings. The snapshot walk above retains that root byte-for-byte.
    if (requiresReleasedCycleRoot) requireSource(current.version === 1 ||
      current.version === 2 && current.cycle !== undefined &&
      current.sightings === undefined && current.migration === undefined);
    let legacy = current.version === 1 ? current : undefined;
    if (current.version === 2 && current.migration) {
      legacy = take(current.migration.sourceSha256);
      requireSource(legacy.version === 1 && current.roundCap === legacy.roundCap && retainedRounds(current, legacy) &&
        Object.entries(legacy.findings).every(([key, finding]) =>
          Object.hasOwn(current.findings, key) && retainedFindingIdentity(current.findings[key]!, finding)));
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
  requireSource(validateAnchorIdentityBatch(prior, input.anchors, source.findings));
  requireSource(source.version !== 3 || source.recovery!.operations.every(operation => operation.operationId !== input.operationId));
  for (const anchor of input.anchors) {
    requireSource(object(anchor) && anchor.operationId === input.operationId && identity(anchor.identity));
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

/** Validate one proposed additive operation without requiring retained files
 * for already-qualified predecessor operations. The effectful adapter validates
 * the complete resulting lineage before publication. */
export function validateNativeRecoveryOperationInput(input: NativeRecoveryInput): void {
  const source = verifyNativeRecoveryLineage(input.sourceJson, input.target, input.nativeSourceJsons).state;
  validateAnchors(input, source);
}

/** @internal Validate one new identity batch against retained anchors in linear time. */
export function validateAnchorIdentityBatch(prior: readonly Pick<NativeCorrectionAnchor, 'identity'>[],
  anchors: readonly Pick<NativeCorrectionAnchor, 'identity'>[], findings: Readonly<Record<string, unknown>>): boolean {
  const priorIdentities = new Set(prior.map(anchor => anchor.identity));
  const identities = new Set<string>();
  for (const anchor of anchors) {
    if (!identity(anchor.identity) || Object.hasOwn(findings, anchor.identity) ||
        priorIdentities.has(anchor.identity) || identities.has(anchor.identity)) return false;
    identities.add(anchor.identity);
  }
  return true;
}

/** @internal Pure retained-material projection used by validation regressions. */
export function recoveredDismissalsByRound(state: ConvergeRunState, materials: RecoveryMaterial[], snapshots: ReadonlyMap<string, string>): Map<number, Map<string, string>> {
  const dismissals = new Map<number, Map<string, string>>();
  for (const operation of state.recovery?.operations ?? []) {
    const raw = snapshots.get(operation.sourceSha256); requireSource(raw !== undefined);
    const source = nativeSource(raw!, state.target);
    const sourceRound = Math.max(0, ...source.rounds.map(round => round.round));
    const reference = operation.material;
    const values = dismissals.get(sourceRound) ?? new Map<string, string>();
    if (!reference?.current) { dismissals.set(sourceRound, values); continue; }
    const content = nativeMaterial(reference, materials);
    const projection = content.currentProjection;
    if (projection && projection.residuals.length === 0) for (const claim of projection.claims) {
      const proof = content.occurrences?.dispositions.find(row => row.receipt.id === claim.dispositionEventId);
      if (claim.standing === 'dismissed' && proof?.preparation.split.selection.identity === claim.identity &&
          proof.preparation.verdict === 'dismissed') values.set(claim.identity, proof.preparation.severity);
    }
    dismissals.set(sourceRound, values);
  }
  return dismissals;
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
  const operations = state.recovery?.operations ?? [];
  const occurrencePending = operations.flatMap(operation => occurrencePendingIdentities(operation.occurrences));
  const materialPending = operations.flatMap(operation => operation.material?.pendingIdentities ?? []);
  return [...new Set([...pending, ...occurrencePending, ...materialPending,
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
  admissionSourceJsons?: string[];
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
    ancestors:(input.nativeSourceJsons??[]).map(contentHash),admissions:(input.admissionSourceJsons??[]).map(contentHash),
    materials:(input.recoveryMaterials??[]).map(row=>[row.sha256,contentHash(row.text)])}));
}
export function validateRetainedNativeEvidence(input: RetainedNativeEvidence): ContentValidatedNative {
  try {
    const cacheKey=contentKey(input);const cached=contentCache.get(cacheKey);
    if(cached){contentCache.delete(cacheKey);contentCache.set(cacheKey,cached);return structuredClone(cached.value);}

    requireSource(Array.isArray(input.reports));
    requireSource(Array.isArray(input.admissionSourceJsons ?? []));
    let admissionSourceBytes = 0;
    const admissionSnapshots = new Map((input.admissionSourceJsons ?? []).map(raw => {
      requireSource(typeof raw === 'string');
      admissionSourceBytes += Buffer.byteLength(raw);
      requireSource(admissionSourceBytes <= MAX_BYTES);
      return [sha(raw), raw] as const;
    }));
    requireSource(admissionSnapshots.size === (input.admissionSourceJsons ?? []).length);
    const lineage = verifyNativeRecoveryLineage(input.sourceJson, input.target, input.nativeSourceJsons);
    const state = lineage.state;
    const reports = new Map(input.reports.map(raw => {
      requireSource(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_BYTES);
      return [sha(raw), raw] as const;
    }));
    requireSource(reports.size === input.reports.length);
    const snapshots = new Map([...(input.nativeSourceJsons ?? []), ...admissionSnapshots.values()]
      .map(raw => [sha(raw), raw] as const));
    const referencedAdmissionSources = new Set(state.rounds.flatMap(round =>
      round.admission ? [round.admission.sourceStateSha256] : []));
    requireSource(referencedAdmissionSources.size === admissionSnapshots.size &&
      [...referencedAdmissionSources].every(digest => admissionSnapshots.has(digest)));
    const sources: RetainedSources = { reports, snapshots, usedReports: new Set(), pathRequirements: [] };
    // Released cycle-v2 has ordinary legacy rounds, not a semantic ledger.
    // nativeSource rejects semantic fields in that disjoint producer format.
    if (state.version === 2 && state.cycle === undefined) validateSemanticState(state, sources);
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
          currentStored.history,ancestorsOf(source,snapshots),sourceJson,currentStored.version):undefined;
        requireSource(!currentStored || isDeepStrictEqual(currentProjection,currentStored));
        requireSource(isDeepStrictEqual(operation, { operationId: operation.operationId,
          sourceVersion: source.version, sourceSha256: sha(sourceJson),
          anchors: operation.anchors, sourceReceipts: operation.sourceReceipts, ...(operation.material ? { material: packNativeMaterial({...(occurrences?{occurrences}:{}),...(currentProjection?{currentProjection}:{})}).reference } : occurrences ? { occurrences } : {}) }));
        sources.pathRequirements.push({ kind: 'native-predecessor', sha256: operation.sourceSha256,
          nativePathSuffix: `.recovery-sources/${operation.sourceSha256}.json` });
      }
      const legacyOrigin = lineage.original.version === 1 || lineage.original.version === 2 && lineage.original.cycle !== undefined;
      if (!legacyOrigin) validateSemanticState(lineage.original, sources);
      // Only exact predecessor rounds are legacy; added rounds still require
      // the full immutable report, sighting membership and cache validation.
      // Released cycle-v2 roots have no semantic sightings or report bindings.
      // Their exact predecessor bytes, anchors, receipts and reports were
      // validated above; descendants do not invent a semantic ledger merely
      // to cross the recovery boundary.
      if (legacyOrigin && state.sightings === undefined) validateSightinglessLegacyEvolution(state, lineage.original);
      if (!legacyOrigin || state.sightings !== undefined) {
        validateSemanticState(state, sources, legacyOrigin ? lineage.original : undefined,
          recoveredDismissalsByRound(state, input.recoveryMaterials ?? [], snapshots));
      }
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
