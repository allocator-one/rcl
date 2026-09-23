import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processRoundReport, loadConvergeRunState, loadConvergeRunStateEvidence } from '../../src/converge/run-state.js';
import { convergeAttemptStatePath } from '../../src/converge/attempt-budget.js';
import { applyRoundGap, previewRoundGap } from '../../src/converge/round-gap.js';

const dirs: string[] = [];
async function dir() { const value = await mkdtemp(join(tmpdir(), 'rcl-round-gap-')); dirs.push(value); return value; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
const run = '11111111-1111-4111-8111-111111111111';
const sha = 'a'.repeat(64);

it('audits a spent missing report without fabricating round two, then admits bound round three', async () => {
  const gitCommonDir = await dir(), target = 'gap-target';
  await processRoundReport({ gitCommonDir, target, round: 1, findings: [] });
  const path = convergeAttemptStatePath(gitCommonDir, target); await mkdir(join(gitCommonDir, 'rcl-converge-attempts'));
  await writeFile(path, JSON.stringify({ version: 2, target, cap: 20, migratedAttempts: 0, attemptsUsed: 3, attempts: [], updatedAt: '2026-01-01T00:00:00.000Z' }));
  const manifest = await previewRoundGap({ target, gapRound: 2, admittingRound: 3, attempt: 2, runId: run, reportSha256: sha, incompleteSha256: 'b'.repeat(64) }, gitCommonDir);
  expect(manifest.stateSha256).toBe((await loadConvergeRunStateEvidence(gitCommonDir, target))?.sha256);
  expect(await applyRoundGap(manifest, gitCommonDir)).toBe('applied');
  expect(await applyRoundGap(manifest, gitCommonDir)).toBe('resumed');
  const state = await loadConvergeRunState(gitCommonDir, target);
  expect(state?.rounds.map(value => value.round)).toEqual([1]);
  await expect(processRoundReport({ gitCommonDir, target, round: 3, findings: [], runId: run, reportSha256: sha })).resolves.toMatchObject({ counts: { new: 0 } });
});

it('refuses an unbound higher report and changed CAS evidence', async () => {
  const gitCommonDir = await dir(), target = 'gap-refusal';
  await processRoundReport({ gitCommonDir, target, round: 1, findings: [] });
  await mkdir(join(gitCommonDir, 'rcl-converge-attempts')); await writeFile(convergeAttemptStatePath(gitCommonDir, target), JSON.stringify({ version: 2, target, cap: 20, migratedAttempts: 0, attemptsUsed: 3, attempts: [], updatedAt: '2026-01-01T00:00:00.000Z' }));
  await expect(processRoundReport({ gitCommonDir, target, round: 3, findings: [], runId: run, reportSha256: sha })).rejects.toThrow('out of order');
  const manifest = await previewRoundGap({ target, gapRound: 2, admittingRound: 3, attempt: 2, runId: run, reportSha256: sha, incompleteSha256: 'b'.repeat(64) }, gitCommonDir);
  await writeFile(convergeAttemptStatePath(gitCommonDir, target), JSON.stringify({ version: 2, target, cap: 20, migratedAttempts: 0, attemptsUsed: 4, attempts: [], updatedAt: '2026-01-01T00:00:00.000Z' }));
  await expect(applyRoundGap(manifest, gitCommonDir)).rejects.toThrow('round_gap_attempt_changed');
});

it('refuses a changed manifest reusing an already applied operation id', async () => {
  const gitCommonDir = await dir(), target = 'gap-resume';
  await processRoundReport({ gitCommonDir, target, round: 1, findings: [] });
  await mkdir(join(gitCommonDir, 'rcl-converge-attempts')); await writeFile(convergeAttemptStatePath(gitCommonDir, target), JSON.stringify({ version: 2, target, cap: 20, migratedAttempts: 0, attemptsUsed: 3, attempts: [], updatedAt: '2026-01-01T00:00:00.000Z' }));
  const manifest = await previewRoundGap({ target, gapRound: 2, admittingRound: 3, attempt: 2, runId: run, reportSha256: sha, incompleteSha256: 'b'.repeat(64) }, gitCommonDir);
  await expect(applyRoundGap(manifest, gitCommonDir)).resolves.toBe('applied');
  await expect(applyRoundGap({ ...manifest, incompleteSha256: 'c'.repeat(64) }, gitCommonDir)).rejects.toThrow('round_gap_operation_conflict');
});
