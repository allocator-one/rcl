import { guardedInputSha256, stableStringify } from '../report/run-header.js';
import { isDeepStrictEqual } from 'node:util';
import type { NativeReviewCycle } from './review-cycle.js';

export interface OrdinaryPendingPackage {
  version?: 2;
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
  guardedInput: Record<string, unknown>;
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

export function validateOrdinaryPendingPackage(value: OrdinaryPendingPackage, expected: PendingLaunchIdentity): OrdinaryPendingPackage {
  const input = value?.guardedInput;
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
    !Array.isArray(value.retainedAsyncSha256) || [...value.retainedAsyncSha256].sort().join(',') !== [...expected.retainedAsyncSha256].sort().join(',') || input.head !== value.headSha || guardedInputSha256(input) !== expected.inputSha256) throw new Error('ordinary_pending_package_mismatch');
  if (!structuredInput || !/^[a-f0-9]{40}$/.test(value.headSha) || !new Set(value.retainedAsyncSha256).size ||
      new Set(value.retainedAsyncSha256).size !== value.retainedAsyncSha256.length ||
      value.retainedAsyncSha256.some(hash => !digest(hash)) || !Array.isArray(value.retainedAsync) ||
      value.retainedAsync.length !== value.retainedAsyncSha256.length ||
      new Set(value.retainedAsync.map(item => item?.sha256)).size !== value.retainedAsync.length ||
      value.retainedAsync.some(item =>
        !item || !digest(item.sha256) || !value.retainedAsyncSha256.includes(item.sha256) ||
        typeof item.model !== 'string' || !item.model || typeof item.role !== 'string' || !item.role ||
        typeof item.provider !== 'string' || !item.provider || item.lane !== 'async' ||
        !(input.roster as Record<string, unknown>[]).some(seat => seat?.model === item.model &&
          seat.role === item.role && seat.provider === item.provider && seat.lane === 'async'))) throw new Error('ordinary_pending_package_mismatch');
  return Object.freeze(JSON.parse(stableStringify(value)) as OrdinaryPendingPackage);
}
