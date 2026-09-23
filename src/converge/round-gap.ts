import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withNativeTarget } from './target-ownership.js';
import { convergeAttemptStatePath } from './attempt-budget.js';
import { loadConvergeRunStateEvidence, writeState, type ConvergeRunState } from './run-state.js';

export interface RoundGapManifest {
  version: 1;
  operationId: string;
  target: string;
  gapRound: number;
  admittingRound: number;
  attempt: number;
  runId: string;
  reportSha256: string;
  incompleteSha256: string;
  stateSha256: string;
  attemptSha256: string;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
type StoredGap = NonNullable<ConvergeRunState['roundGapAudit']>['entries'][number];
const sameManifest = (a: StoredGap, b: RoundGapManifest) =>
  a.operationId === b.operationId && a.gapRound === b.gapRound &&
  a.admittingRound === b.admittingRound && a.attempt === b.attempt && a.runId === b.runId &&
  a.reportSha256 === b.reportSha256 && a.incompleteSha256 === b.incompleteSha256 &&
  a.stateSha256 === b.stateSha256 && a.attemptSha256 === b.attemptSha256;

function valid(manifest: RoundGapManifest): void {
  if (!uuid(manifest.operationId) || !manifest.target.trim() || !Number.isSafeInteger(manifest.gapRound) || manifest.gapRound < 1 ||
      manifest.admittingRound !== manifest.gapRound + 1 || !Number.isSafeInteger(manifest.attempt) || manifest.attempt < 1 ||
      !uuid(manifest.runId) || !digest(manifest.reportSha256) || !digest(manifest.incompleteSha256) || !digest(manifest.stateSha256) || !digest(manifest.attemptSha256)) {
    throw new Error('invalid_round_gap_manifest');
  }
}

async function attemptEvidence(gitCommonDir: string, target: string): Promise<{ raw: Buffer; sha256: string; attemptsUsed: number }> {
  const raw = await readFile(convergeAttemptStatePath(gitCommonDir, target));
  const parsed = JSON.parse(raw.toString('utf8')) as { target?: unknown; attemptsUsed?: unknown };
  if (parsed.target !== target || !Number.isSafeInteger(parsed.attemptsUsed)) throw new Error('invalid_round_gap_attempt_state');
  return { raw, sha256: sha256(raw), attemptsUsed: parsed.attemptsUsed as number };
}

/** Build a read-only binding for one missing terminal report, never a synthetic round. */
export async function previewRoundGap(manifest: Omit<RoundGapManifest, 'version' | 'operationId' | 'stateSha256' | 'attemptSha256'> & { operationId?: string }, gitCommonDir: string): Promise<RoundGapManifest> {
  const state = await loadConvergeRunStateEvidence(gitCommonDir, manifest.target);
  if (!state) throw new Error('round_gap_state_missing');
  const attempt = await attemptEvidence(gitCommonDir, manifest.target);
  const value: RoundGapManifest = { ...manifest, version: 1, operationId: manifest.operationId ?? randomUUID(), stateSha256: state.sha256, attemptSha256: attempt.sha256 };
  valid(value);
  const max = Math.max(...state.state.rounds.map(round => round.round), 0);
  if (max !== value.gapRound - 1 || attempt.attemptsUsed < value.attempt) throw new Error('round_gap_not_bound_to_spent_attempt');
  return value;
}

/** CAS-apply one audit entry; it cannot add a round, finding, verdict or attempt. */
export async function applyRoundGap(manifest: RoundGapManifest, gitCommonDir: string): Promise<'applied' | 'resumed'> {
  valid(manifest);
  const previewState = await loadConvergeRunStateEvidence(gitCommonDir, manifest.target);
  if (!previewState) throw new Error('round_gap_state_missing');
  const prior = previewState.state.roundGapAudit?.entries.find(entry => entry.operationId === manifest.operationId);
  if (prior) { if (sameManifest(prior, manifest)) return 'resumed'; throw new Error('round_gap_operation_conflict'); }
  if (previewState.sha256 !== manifest.stateSha256) throw new Error('round_gap_state_changed');
  return withNativeTarget(gitCommonDir, manifest.target, async ownership => {
    const stateEvidence = await loadConvergeRunStateEvidence(gitCommonDir, manifest.target);
    if (!stateEvidence || stateEvidence.sha256 !== manifest.stateSha256) throw new Error('round_gap_state_changed');
    const attempts = await attemptEvidence(gitCommonDir, manifest.target);
    if (attempts.sha256 !== manifest.attemptSha256 || attempts.attemptsUsed < manifest.attempt) throw new Error('round_gap_attempt_changed');
    const existing = stateEvidence.state.roundGapAudit?.entries ?? [];
    const existingOperation = existing.find(entry => entry.operationId === manifest.operationId);
    if (existingOperation) { if (sameManifest(existingOperation, manifest)) return 'resumed'; throw new Error('round_gap_operation_conflict'); }
    if (existing.some(entry => entry.gapRound === manifest.gapRound || entry.admittingRound === manifest.admittingRound)) throw new Error('round_gap_conflict');
    const max = Math.max(...stateEvidence.state.rounds.map(round => round.round), 0);
    if (max !== manifest.gapRound - 1) throw new Error('round_gap_not_contiguous');
    const next: ConvergeRunState = { ...stateEvidence.state, roundGapAudit: { version: 1, entries: [...existing, manifest] }, updatedAt: new Date().toISOString() };
    await writeState(gitCommonDir, next, ownership);
    return 'applied';
  });
}
