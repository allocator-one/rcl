import { nativeReviewCycleSchema } from '../../../converge/review-cycle.js';
import type { RecoveryMaterial } from './materials.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { claimDescriptorSchema } from './claims.js';
import type { NativeCorrectionAnchor } from './anchors.js';
import { decodeRecoveryOriginal as decodeOriginalReport } from './recovery-json.js';
import { object, uuidSchema } from './primitives.js';
import type { ConvergeRunState } from './types.js';

const MAX_BYTES = 64 * 1024 * 1024;
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const uuid = (value: unknown): value is string => uuidSchema.safeParse(value).success;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const requireSource = (valid: unknown): void => { if (!valid) throw new Error('native_recovery_source_conflict'); };

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
    requireSource(entry.verdictSeverity === undefined || ['critical', 'important', 'minor', 'nitpick'].includes(entry.verdictSeverity as string));
    requireSource(entry.claimDescriptor === undefined || state.version !== 1 && claimDescriptorSchema.safeParse(entry.claimDescriptor).success);
  }
  requireSource(state.version === 1 || cycleOrigin || Array.isArray(state.sightings));
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
        isDeepStrictEqual(current.cycle, predecessor.cycle) &&
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

export function recoveryAnchors(state: ConvergeRunState): NativeCorrectionAnchor[] {
  return state.version === 3 ? state.recovery!.operations.flatMap(operation => operation.anchors) : [];
}
/** Exact bytes supplied by an outer reader; no filesystem or authenticated-read qualification is implied. */
export interface RetainedNativeEvidence {
  sourceJson: string;
  target: string;
  reports: string[];
  nativeSourceJsons?: string[];
  recoveryMaterials?: RecoveryMaterial[];
}
