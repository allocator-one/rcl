import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONVERGE_ROUND_CAP,
  HARD_CONVERGE_ROUND_CAP,
  validateRoundCap,
  processRoundReport,
  recordVerdicts,
  loadConvergeRunState,
  ConvergeRoundCapError,
} from '../../src/converge/run-state.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rcl-runstate-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function finding(over: Partial<ConsensusFinding> & { models?: string[] } = {}): ConsensusFinding {
  const { models = ['m1'], ...rest } = over;
  return {
    id: 'x',
    file: 'src/a.ts',
    startLine: 10,
    endLine: 14,
    severity: 'important',
    category: 'correctness',
    title: 'possible bug',
    description: 'desc',
    consensus: {
      score: models.length,
      total: 3,
      models,
      roles: ['general'],
      crossRole: false,
      crossModel: models.length >= 2,
      elevated: false,
      elevation: 'none',
      confidence: 0.5,
      confidenceLabel: 'Medium',
      tier: models.length >= 2 ? 'majority' : 'single',
    },
    gating: { reason: models.length >= 2 ? 'consensus' : 'verified' },
    ...rest,
  };
}

describe('round cap policy (RCL-24)', () => {
  it('defaults to 3 rounds with a hard cap of 5', () => {
    expect(DEFAULT_CONVERGE_ROUND_CAP).toBe(3);
    expect(HARD_CONVERGE_ROUND_CAP).toBe(5);
  });

  it('accepts caps between 2 and 5 and rejects everything else', () => {
    expect(validateRoundCap(2)).toBe(2);
    expect(validateRoundCap(5)).toBe(5);
    expect(() => validateRoundCap(1)).toThrow(/2/);
    expect(() => validateRoundCap(6)).toThrow(/5/);
    expect(() => validateRoundCap(0)).toThrow();
  });

  it('refuses to process a round beyond the cap — and beyond 5 under any cap', async () => {
    for (let round = 1; round <= 3; round++) {
      await processRoundReport({
        gitCommonDir: dir,
        target: 't1',
        round,
        findings: [finding()],
      });
    }
    await expect(
      processRoundReport({ gitCommonDir: dir, target: 't1', round: 4, findings: [] })
    ).rejects.toThrow(ConvergeRoundCapError);

    // Explicit override extends to 5…
    await processRoundReport({
      gitCommonDir: dir,
      target: 't1',
      round: 4,
      maxRounds: 5,
      findings: [],
    });
    await processRoundReport({ gitCommonDir: dir, target: 't1', round: 5, findings: [] });
    // …but never past it.
    await expect(
      processRoundReport({ gitCommonDir: dir, target: 't1', round: 6, maxRounds: 5, findings: [] })
    ).rejects.toThrow(ConvergeRoundCapError);
  });
});

describe('cross-round identity and suppression (RCL-24)', () => {
  it('classifies first sightings as new and later sightings as repeat', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't2',
      round: 1,
      findings: [finding()],
    });
    expect(r1.counts).toMatchObject({ new: 1, repeat: 0, suppressed: 0 });

    const r2 = await processRoundReport({
      gitCommonDir: dir,
      target: 't2',
      round: 2,
      findings: [finding({ title: 'entirely different phrasing of the same thing' })],
    });
    expect(r2.counts).toMatchObject({ new: 0, repeat: 1, suppressed: 0 });
    expect(r2.findings[0]!.identity).toBe(r1.findings[0]!.identity);
  });

  it('suppresses re-findings of dismissed findings without new corroboration', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't3',
      round: 1,
      findings: [finding({ models: ['m1'] })],
    });
    await recordVerdicts({
      gitCommonDir: dir,
      target: 't3',
      round: 1,
      verdicts: [{ key: r1.findings[0]!.identity, verdict: 'dismissed', reason: 'guard exists' }],
    });

    const r2 = await processRoundReport({
      gitCommonDir: dir,
      target: 't3',
      round: 2,
      findings: [finding({ models: ['m2'] })],
    });
    expect(r2.counts.suppressed).toBe(1);
    expect(r2.findings[0]!.status).toBe('suppressed');
    expect(r2.findings[0]!.suppressReason).toMatch(/dismissed/i);
  });

  it('lets a dismissed finding re-gate with new corroboration (>=2 models or critical)', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4',
      round: 1,
      findings: [finding({ models: ['m1'] })],
    });
    await recordVerdicts({
      gitCommonDir: dir,
      target: 't4',
      round: 1,
      verdicts: [{ key: r1.findings[0]!.identity, verdict: 'dismissed', reason: 'not applicable' }],
    });

    const r2 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4',
      round: 2,
      findings: [finding({ models: ['m1', 'm2'], gating: { reason: 'consensus' } })],
    });
    expect(r2.findings[0]!.status).toBe('regating');
    expect(r2.counts.suppressed).toBe(0);

    const r3 = await processRoundReport({
      gitCommonDir: dir,
      target: 't4',
      round: 3,
      findings: [
        finding({ models: ['m3'], severity: 'critical', gating: { reason: 'critical' } }),
      ],
    });
    expect(r3.findings[0]!.status).toBe('regating');
  });

  it('persists per-round counts and verdicts in the state file', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 't5',
      round: 1,
      findings: [finding()],
    });
    await recordVerdicts({
      gitCommonDir: dir,
      target: 't5',
      round: 1,
      verdicts: [{ key: r1.findings[0]!.identity, verdict: 'fixed' }],
    });
    const state = await loadConvergeRunState(dir, 't5');
    expect(state!.rounds).toHaveLength(1);
    expect(state!.rounds[0]!.counts).toMatchObject({ new: 1 });
    const entry = Object.values(state!.findings)[0]!;
    expect(entry.verdict).toBe('fixed');
    expect(entry.verdictRound).toBe(1);
  });
});
