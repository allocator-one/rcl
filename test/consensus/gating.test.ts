import { describe, it, expect, vi } from 'vitest';
import { applyGating, resolveGatingConfig } from '../../src/consensus/gating.js';
import type { ConsensusFinding, ConsensusInfo } from '../../src/consensus/types.js';
import type { ModelAnswer } from '../../src/dispatch/adapter.js';

function makeConsensus(models: string[]): ConsensusInfo {
  return {
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
  };
}

function makeFinding(
  overrides: Partial<ConsensusFinding> & { models?: string[] } = {}
): ConsensusFinding {
  const { models = ['m1'], ...rest } = overrides;
  return {
    id: 'f1',
    file: 'src/a.ts',
    startLine: 1,
    endLine: 3,
    severity: 'important',
    category: 'correctness',
    title: 'possible bug',
    description: 'desc',
    consensus: makeConsensus(models),
    ...rest,
  };
}

function answering(text: string): (calls: unknown[][]) => typeof ask {
  const ask = vi.fn(
    async (): Promise<ModelAnswer> => ({
      model: 'google/gemini-3.6-flash',
      provider: 'google',
      text,
      durationMs: 10,
      status: 'success',
    })
  );
  return () => ask;
}

const baseOpts = {
  minModels: 2,
  verificationModel: 'google/gemini-3.6-flash',
  verificationTimeoutMs: 60_000,
};

describe('applyGating (RCL-23)', () => {
  it('marks critical findings as gating regardless of model count', async () => {
    const ask = vi.fn();
    const { findings } = await applyGating(
      [makeFinding({ severity: 'critical', models: ['m1'] })],
      { ...baseOpts, ask }
    );
    expect(findings[0]!.gating).toEqual({ reason: 'critical' });
    expect(ask).not.toHaveBeenCalled();
  });

  it('marks multi-model blocking findings as consensus without verification', async () => {
    const ask = vi.fn();
    const { findings } = await applyGating(
      [makeFinding({ severity: 'important', models: ['m1', 'm2'] })],
      { ...baseOpts, ask }
    );
    expect(findings[0]!.gating!.reason).toBe('consensus');
    expect(ask).not.toHaveBeenCalled();
  });

  it('marks minor and nitpick findings as none', async () => {
    const ask = vi.fn();
    const { findings } = await applyGating(
      [
        makeFinding({ severity: 'minor', models: ['m1', 'm2', 'm3'] }),
        makeFinding({ severity: 'nitpick' }),
      ],
      { ...baseOpts, ask }
    );
    expect(findings.map((f) => f.gating!.reason)).toEqual(['none', 'none']);
    expect(ask).not.toHaveBeenCalled();
  });

  it('verifies single-model important findings in ONE batched call', async () => {
    const ask = vi.fn(
      async (): Promise<ModelAnswer> => ({
        model: 'google/gemini-3.6-flash',
        provider: 'google',
        text: '[{"id":"F1","verdict":"refuted","reason":"guard exists"},{"id":"F2","verdict":"confirmed","reason":"real"}]',
        durationMs: 10,
        status: 'success',
      })
    );
    const { findings, verification } = await applyGating(
      [
        makeFinding({ id: 'a', title: 'first', models: ['m1'] }),
        makeFinding({ id: 'b', title: 'second', models: ['m2'] }),
      ],
      { ...baseOpts, ask }
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(findings[0]!.gating).toMatchObject({
      reason: 'none',
      verification: { verdict: 'refuted' },
    });
    expect(findings[1]!.gating).toMatchObject({
      reason: 'verified',
      verification: { verdict: 'unrefuted' },
    });
    expect(verification).toMatchObject({ candidates: 2, refuted: 1, unrefuted: 1 });
  });

  it('honors a higher minModels threshold', async () => {
    const ask = vi.fn(
      async (): Promise<ModelAnswer> => ({
        model: 'google/gemini-3.6-flash',
        provider: 'google',
        text: '[{"id":"F1","verdict":"confirmed"}]',
        durationMs: 5,
        status: 'success',
      })
    );
    const { findings } = await applyGating(
      [makeFinding({ severity: 'important', models: ['m1', 'm2'] })],
      { ...baseOpts, minModels: 3, ask }
    );
    // Two models no longer count as consensus — the finding goes to verification.
    expect(findings[0]!.gating!.reason).toBe('verified');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('fails safe when the verifier call fails: candidates keep gating, marked unavailable', async () => {
    const ask = vi.fn(
      async (): Promise<ModelAnswer> => ({
        model: 'google/gemini-3.6-flash',
        provider: 'google',
        text: '',
        durationMs: 5,
        status: 'error',
        error: 'boom',
      })
    );
    const { findings } = await applyGating([makeFinding({ models: ['m1'] })], {
      ...baseOpts,
      ask,
    });
    expect(findings[0]!.gating).toMatchObject({
      reason: 'verified',
      verification: { verdict: 'unavailable' },
    });
  });

  it('treats findings missing from a malformed verifier response as unavailable', async () => {
    const ask = vi.fn(
      async (): Promise<ModelAnswer> => ({
        model: 'google/gemini-3.6-flash',
        provider: 'google',
        text: 'not json at all',
        durationMs: 5,
        status: 'success',
      })
    );
    const { findings } = await applyGating([makeFinding({ models: ['m1'] })], {
      ...baseOpts,
      ask,
    });
    expect(findings[0]!.gating).toMatchObject({
      reason: 'verified',
      verification: { verdict: 'unavailable' },
    });
  });
});

describe('resolveGatingConfig', () => {
  it('defaults to verified-consensus with a direct-API verifier', () => {
    const cfg = resolveGatingConfig(undefined);
    expect(cfg.mode).toBe('verified-consensus');
    expect(cfg.minModels).toBe(2);
    expect(cfg.verificationModel).not.toMatch(/^openrouter\//);
    expect(cfg.verificationTimeoutMs).toBeLessThanOrEqual(60_000);
  });

  it('rejects an openrouter-routed verification model', () => {
    expect(() =>
      resolveGatingConfig({ verificationModel: 'openrouter/x/y' })
    ).toThrow(/direct/i);
  });

  it('supports the all-findings fallback mode', () => {
    const cfg = resolveGatingConfig({ mode: 'all-findings' });
    expect(cfg.mode).toBe('all-findings');
  });
});
