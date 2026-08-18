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
  ConvergeRunStateError,
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
  it('defaults to 15 rounds with a hard cap of 99', () => {
    expect(DEFAULT_CONVERGE_ROUND_CAP).toBe(15);
    expect(HARD_CONVERGE_ROUND_CAP).toBe(99);
  });

  it('accepts caps between 2 and 99 and rejects everything else', () => {
    expect(validateRoundCap(2)).toBe(2);
    expect(validateRoundCap(99)).toBe(99);
    expect(() => validateRoundCap(1)).toThrow(/2/);
    expect(() => validateRoundCap(100)).toThrow(/99/);
    expect(() => validateRoundCap(0)).toThrow();
  });

  it('refuses to process a round beyond the default consent boundary', async () => {
    for (let round = 1; round <= DEFAULT_CONVERGE_ROUND_CAP; round++) {
      await processRoundReport({
        gitCommonDir: dir,
        target: 't1',
        round,
        findings: [finding()],
      });
    }
    await expect(
      processRoundReport({
        gitCommonDir: dir,
        target: 't1',
        round: DEFAULT_CONVERGE_ROUND_CAP + 1,
        findings: [],
      })
    ).rejects.toThrow(ConvergeRoundCapError);

    // Explicit override extends past the boundary…
    await processRoundReport({
      gitCommonDir: dir,
      target: 't1',
      round: DEFAULT_CONVERGE_ROUND_CAP + 1,
      maxRounds: DEFAULT_CONVERGE_ROUND_CAP + 2,
      findings: [],
    });
    await processRoundReport({
      gitCommonDir: dir,
      target: 't1',
      round: DEFAULT_CONVERGE_ROUND_CAP + 2,
      findings: [],
    });
    // …but never past the configured cap.
    await expect(
      processRoundReport({
        gitCommonDir: dir,
        target: 't1',
        round: DEFAULT_CONVERGE_ROUND_CAP + 3,
        maxRounds: DEFAULT_CONVERGE_ROUND_CAP + 2,
        findings: [],
      })
    ).rejects.toThrow(ConvergeRoundCapError);
  });
});

describe('round ordering and re-runs (RCL-24)', () => {
  it('re-running the current round keeps its findings classified as new', async () => {
    const r1 = await processRoundReport({
      gitCommonDir: dir,
      target: 'rr1',
      round: 1,
      findings: [finding()],
    });
    expect(r1.counts.new).toBe(1);
    const rerun = await processRoundReport({
      gitCommonDir: dir,
      target: 'rr1',
      round: 1,
      findings: [finding()],
    });
    expect(rerun.counts).toMatchObject({ new: 1, repeat: 0, suppressed: 0 });
    expect(rerun.findings[0]!.status).toBe('new');
  });

  it('rejects backfilling an earlier round or skipping ahead', async () => {
    await processRoundReport({ gitCommonDir: dir, target: 'rr2', round: 1, findings: [] });
    await processRoundReport({ gitCommonDir: dir, target: 'rr2', round: 2, findings: [] });
    await expect(
      processRoundReport({ gitCommonDir: dir, target: 'rr2', round: 1, findings: [] })
    ).rejects.toThrow(ConvergeRunStateError);
    // Round 3 would be next; there is no recorded round 3 yet, so 4 skips.
    await expect(
      processRoundReport({ gitCommonDir: dir, target: 'rr2', round: 4, maxRounds: 5, findings: [] })
    ).rejects.toThrow(ConvergeRunStateError);
  });

  it('a fresh state adopts a mid-run round from a resumed pre-upgrade ledger', async () => {
    const r = await processRoundReport({
      gitCommonDir: dir,
      target: 'rr3',
      round: 3,
      findings: [finding()],
    });
    expect(r.counts.new).toBe(1);
  });

  it('updates the stored span to the latest sighting so drift does not decay matching', async () => {
    await processRoundReport({
      gitCommonDir: dir,
      target: 'rr4',
      round: 1,
      findings: [finding({ startLine: 10, endLine: 14 })],
    });
    await processRoundReport({
      gitCommonDir: dir,
      target: 'rr4',
      round: 2,
      findings: [finding({ startLine: 13, endLine: 17 })],
    });
    const state = await loadConvergeRunState(dir, 'rr4');
    const entry = Object.values(state!.findings)[0]!;
    expect(entry.startLine).toBe(13);
    expect(entry.endLine).toBe(17);
  });
});

describe('intra-round identity (RCL-24)', () => {
  it('near-duplicates within one report share one identity even across bucket boundaries', async () => {
    const r = await processRoundReport({
      gitCommonDir: dir,
      target: 'ir1',
      round: 1,
      findings: [
        finding({ startLine: 9, endLine: 10 }),
        finding({ startLine: 11, endLine: 12, title: 'other phrasing' }),
      ],
    });
    expect(r.findings[0]!.identity).toBe(r.findings[1]!.identity);
  });

  it('non-overlapping findings sharing a line bucket keep separate identities', async () => {
    const r = await processRoundReport({
      gitCommonDir: dir,
      target: 'ir2',
      round: 1,
      findings: [
        finding({ startLine: 40, endLine: 41 }),
        finding({ startLine: 49, endLine: 49, title: 'unrelated thing nearby' }),
      ],
    });
    expect(r.findings[0]!.identity).not.toBe(r.findings[1]!.identity);
    expect(r.counts.new).toBe(2);
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
