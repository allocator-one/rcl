import { describe, expect, it } from 'vitest';
import { evaluateCiGate } from '../../src/ci.js';
import { VerificationPassTimeoutError } from '../../src/consensus/gating.js';
import { applyStrictFallback, strictFallbackCause, strictFallbackProblem } from '../../src/consensus/strict-fallback.js';
import type { ConsensusFinding, ReviewResult } from '../../src/consensus/types.js';
import { sampleFinding, sampleResult, sampleRunHeader } from '../telemetry/fixtures.js';

const SINGLE = {
  score: 1, total: 8, models: ['openai/reviewer'], roles: ['general'], crossRole: false, crossModel: false,
  elevated: false, elevation: 'none' as const, confidence: 0.28, confidenceLabel: 'Low' as const, tier: 'single' as const,
};

function unlabeled(overrides: Partial<ConsensusFinding>): ConsensusFinding {
  const finding = sampleFinding(overrides);
  delete finding.gating;
  return finding;
}

/** A failed pass's report, labelled as assembly labels it. */
function fallbackReport(): ReviewResult {
  const kept = [
    unlabeled({ id: 'single', identity: 'a'.repeat(16), severity: 'important', consensus: SINGLE }),
    unlabeled({ id: 'agreed', identity: 'b'.repeat(16), severity: 'important' }),
    unlabeled({ id: 'minor', identity: 'c'.repeat(16), severity: 'minor', consensus: SINGLE }),
  ];
  const appendix = [unlabeled({ id: 'dropped', identity: 'd'.repeat(16), severity: 'important', consensus: SINGLE })];
  const { findings, appendix: gatedAppendix, marker } = applyStrictFallback(kept, appendix, 'verification_pass_timeout', 'openai/verifier');
  const header = sampleRunHeader({ ci_exit_code: 1 });
  return sampleResult({
    run: { ...header, gating: { ...header.gating, strict_fallback: marker } },
    findings, belowThresholdFindings: gatedAppendix,
  });
}

describe('strict fallback (RCL-160)', () => {
  it('names a whole-pass deadline a timeout and any other failed pass a failure', () => {
    expect(strictFallbackCause(new VerificationPassTimeoutError(100))).toBe('verification_pass_timeout');
    expect(strictFallbackCause(new Error('adapter construction failed'))).toBe('verification_pass_failed');
    expect(strictFallbackCause('thrown string')).toBe('verification_pass_failed');
  });

  it('blocks every kept critical or important finding unverified and labels every other finding none', () => {
    const kept = [
      unlabeled({ id: 'single', severity: 'important', consensus: SINGLE }),
      unlabeled({ id: 'agreed', severity: 'important' }),
      unlabeled({ id: 'critical', severity: 'critical', consensus: SINGLE }),
      unlabeled({ id: 'minor', severity: 'minor', consensus: SINGLE }),
      unlabeled({ id: 'nitpick', severity: 'nitpick' }),
    ];
    const appendix = [unlabeled({ id: 'dropped-important', severity: 'important' }), unlabeled({ id: 'dropped-minor', severity: 'minor' })];
    const before = structuredClone([kept, appendix]);

    const fallback = applyStrictFallback(kept, appendix, 'verification_pass_timeout', 'openai/verifier');

    const blocker = {
      reason: 'strict_fallback',
      verification: { model: 'openai/verifier', verdict: 'unavailable', note: expect.stringContaining('timed out') },
    };
    expect(fallback.marker).toEqual({ version: 1, cause: 'verification_pass_timeout' });
    expect(fallback.findings.map((f) => f.gating)).toEqual([blocker, blocker, blocker, { reason: 'none' }, { reason: 'none' }]);
    expect(fallback.appendix.map((f) => f.gating)).toEqual([{ reason: 'none' }, { reason: 'none' }]);
    expect([kept, appendix]).toEqual(before);
  });

  it('records no verifier model when none was configured', () => {
    const { findings } = applyStrictFallback([unlabeled({ severity: 'critical' })], [], 'verification_pass_failed', undefined);
    expect(findings[0]!.gating).toEqual({
      reason: 'strict_fallback', verification: { verdict: 'unavailable', note: expect.stringContaining('failed') },
    });
  });

  it('declares no fallback when no kept finding blocks, since no verdict could have changed the result', () => {
    const fallback = applyStrictFallback([unlabeled({ severity: 'minor' })], [unlabeled({ severity: 'important' })],
      'verification_pass_failed', 'openai/verifier');
    expect(fallback.marker).toBeUndefined();
    expect([...fallback.findings, ...fallback.appendix].map((f) => f.gating)).toEqual([{ reason: 'none' }, { reason: 'none' }]);
  });

  it('keeps the conservative CI verdict: the fallback blockers fail the gate', () => {
    const report = fallbackReport();
    expect(evaluateCiGate(report).exitCode).toBe(1);
    expect(strictFallbackProblem(report)).toBeUndefined();
  });

  describe('contract check', () => {
    it('has nothing to say about a report that neither declares nor claims the fallback', () => {
      expect(strictFallbackProblem(sampleResult())).toBeUndefined();
    });

    it.each<[string, (report: ReviewResult) => void, RegExp]>([
      ['a strict_fallback label without the marker', (r) => { delete r.run!.gating.strict_fallback; }, /without run\.gating\.strict_fallback/],
      ['an unknown cause', (r) => { r.run!.gating.strict_fallback = { version: 1, cause: 'other' as never }; }, /must be \{version: 1, cause/],
      ['an extra marker key', (r) => { r.run!.gating.strict_fallback = { version: 1, cause: 'verification_pass_timeout', extra: 1 } as never; }, /must be \{version: 1, cause/],
      ['another gating mode', (r) => { r.run!.gating.mode = 'all-findings'; }, /verified-consensus/],
      ['a zero CI exit code', (r) => { r.run!.ci_exit_code = 0; }, /positive run\.ci_exit_code/],
      ['verification statistics', (r) => {
        r.stats.verification = { model: 'openai/verifier', candidates: 1, refuted: 0, unrefuted: 0, unavailable: 1, durationMs: 1 };
      }, /no stats\.verification/],
      ['a kept important finding labelled none', (r) => { r.findings[1]!.gating = { reason: 'none' }; }, /findings\.1 .*strict_fallback blocker/],
      ['a blocker whose verification is not unavailable', (r) => {
        r.findings[0]!.gating = { reason: 'strict_fallback', verification: { verdict: 'confirmed' } };
      }, /findings\.0 .*strict_fallback blocker/],
      ['a kept important finding with an ordinary label', (r) => { r.findings[1]!.gating = { reason: 'consensus' }; }, /findings\.1 .*strict_fallback blocker/],
      ['a minor finding labelled strict_fallback', (r) => {
        r.findings[2]!.gating = { reason: 'strict_fallback', verification: { verdict: 'unavailable' } };
      }, /findings\.2 .*none without verification/],
      ['an appendix finding labelled strict_fallback', (r) => {
        r.belowThresholdFindings![0]!.gating = { reason: 'strict_fallback', verification: { verdict: 'unavailable' } };
      }, /belowThresholdFindings\.0 .*none without verification/],
      ['an unlabelled finding', (r) => { delete r.findings[2]!.gating; }, /findings\.2 .*none without verification/],
      ['no blocker at all', (r) => { r.findings = r.findings.filter((f) => f.severity === 'minor'); }, /at least one critical or important blocker/],
    ])('refuses %s', (_case, mutate, problem) => {
      const report = fallbackReport();
      mutate(report);
      expect(strictFallbackProblem(report)).toMatch(problem);
    });
  });
});
