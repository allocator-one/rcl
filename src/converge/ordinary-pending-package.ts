import { guardedInputSha256, stableStringify } from '../report/run-header.js';
import { isDeepStrictEqual } from 'node:util';
import type { NativeReviewCycle } from './review-cycle.js';
import { retainGuardedInput, restoreGuardedInput, type RetainedGuardedInput,
  type StoredGuardedInput } from './guarded-input-retention.js';

export interface OrdinaryPendingPackage {
  version?: 2;
  guardedInputRepresentation?: {
    version: 1;
    encoding: 'json-string-table-v1';
  };
  target: string;
  headSha: string;
  baseSha: string;
  attempt: number;
  round: number;
  pid: number;
  cycle?: NativeReviewCycle;
  attemptCap?: number;
  roundCap?: number;
  attemptsUsed?: number;
  asyncAttribution?: 'cycle-history-unattributed';
  retainedAsyncSha256: string[];
  retainedAsync: { sha256: string; model: string; role: string; provider: string; lane: 'async' }[];
  guardedInput: StoredGuardedInput;
}
export interface PendingLaunchIdentity {
  target: string;
  headSha: string;
  inputSha256: string;
  baseSha: string;
  attempt: number;
  round: number;
  pid: number;
  retainedAsyncSha256: readonly string[];
  cycle?: NativeReviewCycle;
  attemptCap?: number;
  roundCap?: number;
  attemptsUsed?: number;
}

export interface PreparedOrdinaryPendingGuardedInput {
  readonly wireInput: Record<string, unknown>;
  readonly input: Record<string, unknown>;
  readonly retained: RetainedGuardedInput;
  inputSha256(): string;
}

const preparedInputs = new WeakSet<PreparedOrdinaryPendingGuardedInput>();
const deeplyFrozen = new WeakSet<object>();

function deepFreezeJson<T>(value: T): T {
  if (!value || typeof value !== 'object' || deeplyFrozen.has(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  Object.freeze(value);
  deeplyFrozen.add(value);
  return value;
}

/** Prepare one bounded canonical archive and lazily memoized digest for trusted internal reuse. */
export function prepareOrdinaryPendingGuardedInput(
  stored: StoredGuardedInput): PreparedOrdinaryPendingGuardedInput {
  const compact = !!stored && typeof stored === 'object' && !Array.isArray(stored) &&
    (stored as Record<string, unknown>).encoding === 'json-string-table-v1';
  let input: Record<string, unknown> | undefined;
  let wireInput: Record<string, unknown>;
  let retained: RetainedGuardedInput;
  if (compact) {
    input = deepFreezeJson(restoreGuardedInput(stored));
    wireInput = input;
    retained = deepFreezeJson({ version: 1 as const, encoding: 'json-string-table-v1' as const,
      strings: (stored as RetainedGuardedInput).strings,
      root: (stored as RetainedGuardedInput).root });
  } else {
    wireInput = stored as Record<string, unknown>;
    // This single encoder pass both validates raw recursive bounds and creates
    // the immutable wire archive. Canonical expansion stays lazy for retention
    // paths that only need the archive, exact raw bytes and digest.
    retained = deepFreezeJson(retainGuardedInput(wireInput));
  }
  const digest = guardedInputSha256(input ?? wireInput);
  const prepared = Object.freeze({ wireInput, retained,
    get input() {
      return input ??= deepFreezeJson(restoreGuardedInput(retained));
    },
    inputSha256: () => digest });
  preparedInputs.add(prepared);
  return prepared;
}

function validateGuardedInputRepresentation(value: OrdinaryPendingPackage): void {
  const representation = value?.guardedInputRepresentation;
  const compact = !!value?.guardedInput &&
    (value.guardedInput as Record<string, unknown>).encoding === 'json-string-table-v1';
  const representationValid = representation === undefined
    ? !compact
    : !!representation && typeof representation === 'object' && !Array.isArray(representation) &&
      representation.version === 1 && representation.encoding === 'json-string-table-v1' &&
      Object.keys(representation).sort().join(',') === 'encoding,version' && compact;
  if (!representationValid) throw new Error('ordinary_pending_package_mismatch');
}

export function ordinaryPendingGuardedInput(value: OrdinaryPendingPackage): Record<string, unknown> {
  validateGuardedInputRepresentation(value);
  return restoreGuardedInput(value.guardedInput);
}

export function validateOrdinaryPendingPackage(value: OrdinaryPendingPackage, expected: PendingLaunchIdentity,
  prepared?: PreparedOrdinaryPendingGuardedInput): OrdinaryPendingPackage {
  let input: Record<string, unknown> | undefined;
  try {
    if (value) validateGuardedInputRepresentation(value);
    if (prepared !== undefined &&
        (!preparedInputs.has(prepared) || value?.guardedInput !== prepared.retained)) {
      throw new Error('ordinary_pending_package_mismatch');
    }
    input = value ? prepared?.input ?? restoreGuardedInput(value.guardedInput) : undefined;
  } catch {
    throw new Error('ordinary_pending_package_mismatch');
  }
  const specPresent = !!input && Object.hasOwn(input, 'spec');
  const keys = ['asyncRoles','config','diff','head','kind','pr','prompts','repo','roster',
    ...(specPresent ? ['spec'] : [])];
  const digest = (candidate: unknown): candidate is string => typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate);
  const structuredInput = input && (input.kind === 'patch' || input.kind === 'pr') && typeof input.repo === 'string' && /^[^/\s]+\/[^/\s]+$/.test(input.repo) &&
    Number.isSafeInteger(input.pr) && (input.pr as number) > 0 && digest(input.diff) && digest(input.config) &&
    Array.isArray(input.roster) && Array.isArray(input.prompts) && Array.isArray(input.asyncRoles) &&
    input.roster.every(item => item && typeof item === 'object') &&
    input.prompts.every(item => item && typeof item === 'object') &&
    input.asyncRoles.every(item => {
      const role = item as Record<string, unknown>;
      return item && typeof item === 'object' && typeof role.name === 'string' && role.name.length > 0;
    }) &&
    (!specPresent || (input.spec && typeof input.spec === 'object'));
  const cycleBacked = expected.cycle !== undefined;
  const cycleFieldsValid = cycleBacked
    ? value.version === 2 && isDeepStrictEqual(value.cycle, expected.cycle) &&
      value.attemptCap === expected.attemptCap && value.roundCap === expected.roundCap &&
      value.attemptsUsed === expected.attemptsUsed && value.attemptsUsed === value.attempt &&
      value.asyncAttribution === 'cycle-history-unattributed'
    : value.version === undefined && value.cycle === undefined && value.attemptCap === undefined &&
      value.roundCap === undefined && value.attemptsUsed === undefined && value.asyncAttribution === undefined;
  if (!value || !cycleFieldsValid || value.target !== expected.target || value.headSha !== expected.headSha || value.baseSha !== expected.baseSha || value.attempt !== expected.attempt || value.round !== expected.round || value.pid !== expected.pid || !/^[a-f0-9]{40}$/.test(value.baseSha) ||
    !Number.isSafeInteger(value.attempt) || value.attempt < 1 || !Number.isSafeInteger(value.round) || value.round < 1 ||
    !Number.isSafeInteger(value.pid) || value.pid < 1 || !input || Object.keys(input).sort().join(',') !== keys.join(',') ||
    !Array.isArray(value.retainedAsyncSha256) || [...value.retainedAsyncSha256].sort().join(',') !== [...expected.retainedAsyncSha256].sort().join(',') || input.head !== value.headSha ||
    (prepared ? prepared.inputSha256() : guardedInputSha256(input)) !== expected.inputSha256) throw new Error('ordinary_pending_package_mismatch');
  const cycleHistory = value.version === 2;
  const descriptorHashes = Array.isArray(value.retainedAsync)
    ? value.retainedAsync.map(item => item?.sha256).sort() : [];
  if (!structuredInput || !/^[a-f0-9]{40}$/.test(value.headSha) ||
      (!cycleHistory && (!new Set(value.retainedAsyncSha256).size ||
        new Set(value.retainedAsyncSha256).size !== value.retainedAsyncSha256.length)) ||
      value.retainedAsyncSha256.some(hash => !digest(hash)) || !Array.isArray(value.retainedAsync) ||
      value.retainedAsync.length !== value.retainedAsyncSha256.length ||
      (!cycleHistory && new Set(value.retainedAsync.map(item => item?.sha256)).size !== value.retainedAsync.length) ||
      descriptorHashes.join(',') !== [...value.retainedAsyncSha256].sort().join(',') ||
      value.retainedAsync.some(item =>
        !item || !digest(item.sha256) || !value.retainedAsyncSha256.includes(item.sha256) ||
        typeof item.model !== 'string' || !item.model || typeof item.role !== 'string' || !item.role ||
        typeof item.provider !== 'string' || !item.provider || item.lane !== 'async' ||
        !(input.roster as Record<string, unknown>[]).some(seat => seat?.model === item.model &&
          seat.role === item.role && seat.provider === item.provider && seat.lane === 'async'))) throw new Error('ordinary_pending_package_mismatch');
  return prepared
    ? deepFreezeJson(value)
    : Object.freeze(JSON.parse(stableStringify(value)) as OrdinaryPendingPackage);
}
