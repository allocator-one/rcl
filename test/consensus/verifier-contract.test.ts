import { describe, expect, it, vi } from 'vitest';
import { applyGating, planGating, replayGating, resolveGatingConfig } from '../../src/consensus/gating.js';
import { ConfigSchema } from '../../src/config/schema.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';

const finding: ConsensusFinding = {
  id: 'f1', file: 'account.ts', startLine: 1, endLine: 1,
  severity: 'important', category: 'security', title: 'Cross-account deletion',
  description: 'The request can select an account owned by somebody else.',
  consensus: { score: 1, total: 2, models: ['reviewer'], roles: ['general'], crossRole: false,
    crossModel: false, elevated: false, elevation: 'none', confidence: 0.8, confidenceLabel: 'High', tier: 'single' },
};
const opts = {
  minModels: 2, verificationModel: 'openai/gpt-6-astra', verificationTimeoutMs: 1000,
  verificationReasoningEffort: 'high' as const,
  diffFiles: [{ filename: 'account.ts', status: 'modified' as const, language: 'ts', additions: 1, deletions: 0,
    patch: '@@ -0,0 +1 @@\n+await accounts.delete(request.params.accountId);' }],
};
const confirmed = { id: 'F1', verdict: 'confirmed', reason: 'Deletion is not scoped to the caller.',
  failureMechanism: 'An authenticated caller supplies another account ID; the unscoped delete removes that account.',
  evidence: [{ file: 'account.ts', quote: 'await accounts.delete(request.params.accountId);' }] };
function answer(entries: unknown[]) {
  return { model: opts.verificationModel, provider: 'openai', status: 'success' as const,
    durationMs: 1, text: JSON.stringify(entries) };
}

describe('evidence-based verifier contract', () => {
  it('resolves Astra high and passes an explicit configured effort to the request', async () => {
    const config = resolveGatingConfig(undefined, ['openai/gpt-6-sol', 'google/gemini-3.8-flash']);
    expect(config).toMatchObject({ verificationModel: 'openai/gpt-6-astra', verificationReasoningEffort: 'high' });
    const parsed = ConfigSchema.parse({ gating: { verificationReasoningEffort: 'medium' } });
    const override = resolveGatingConfig(parsed.gating);
    const ask = vi.fn(async () => answer([confirmed]));
    await applyGating([finding], { ...opts, ...override, ask });
    expect(ask.mock.calls[0]![3]).toMatchObject({ reasoningEffort: 'medium' });
  });

  it('promotes a concrete failure supported by the supplied source and retains its explanation', async () => {
    const result = await applyGating([finding], { ...opts, ask: async () => answer([confirmed]) });
    expect(result.findings[0]!.gating).toMatchObject({ reason: 'verified', verification: { verdict: 'confirmed' } });
    expect(result.findings[0]!.gating!.verification!.note).toContain(confirmed.failureMechanism);
    expect(result.findings[0]!.gating!.verification!.note).toContain(confirmed.evidence[0]!.quote);
    expect(result.verification).toMatchObject({ confirmed: 1, insufficientEvidence: 0 });
  });

  it('preserves custom verifier defaults and rejects effort for a provider that cannot receive it', () => {
    expect(resolveGatingConfig({ verificationModel: 'openai/gpt-4o' })).not.toHaveProperty('verificationReasoningEffort');
    expect(resolveGatingConfig(undefined, ['anthropic/claude-fable-5-1'])).not.toHaveProperty('verificationReasoningEffort');
    expect(() => resolveGatingConfig({ verificationModel: 'google/gemini-3.8-flash', verificationReasoningEffort: 'high' })).toThrow(/OpenAI/);
  });

  it.each([
    { id: 'F1', verdict: 'insufficient_evidence', reason: 'The authorization middleware was not supplied.' },
    { id: 'F1', verdict: 'confirmed', reason: 'Could not refute it.' },
    { ...confirmed, evidence: [{ file: 'account.ts', quote: 'invented code' }] },
    { ...confirmed, evidence: [{ file: 'another.ts', quote: confirmed.evidence[0]!.quote }] },
  ])('does not promote uncertainty or unsupported confirmation: %j', async entry => {
    const result = await applyGating([finding], { ...opts, ask: async () => answer([entry]) });
    expect(result.findings[0]!.gating).toMatchObject({ reason: 'none', verification: { verdict: 'insufficient_evidence' } });
    expect(result.verification).toMatchObject({ confirmed: 0, insufficientEvidence: 1 });
  });

  it('retains a removed guard as provenance for a confirmed regression', async () => {
    const removedGuard = {
      id: 'F1', verdict: 'confirmed',
      reason: 'The account authorization guard was removed before deletion.',
      failureMechanism: 'An authenticated caller supplies another account ID, the removed guard no longer rejects it, and deletion proceeds.',
      evidence: [{ file: 'account.ts', quote: 'await authorize(request.user, accountId);' }],
    };
    const result = await applyGating([finding], {
      ...opts,
      diffFiles: [{ ...opts.diffFiles[0], patch: '@@ -1,2 +1 @@\n-await authorize(request.user, accountId);\n await accounts.delete(request.params.accountId);' }],
      ask: async () => answer([removedGuard]),
    });
    expect(result.findings[0]!.gating).toMatchObject({
      reason: 'verified', verification: { verdict: 'confirmed' },
    });
  });

  it.each([
    ['an added line beginning with ++', '@@ -0,0 +1 @@\n+++i;', '++i;'],
    ['a removed line beginning with --', '@@ -1 +0,0 @@\n--- retained source comment', '-- retained source comment'],
  ])('retains provenance for %s', async (_label, patch, quote) => {
    const result = await applyGating([finding], {
      ...opts,
      diffFiles: [{ ...opts.diffFiles[0], patch }],
      ask: async () => answer([{
        id: 'F1', verdict: 'confirmed', reason: 'The supplied source establishes the regression.',
        failureMechanism: 'The changed source reaches the reported outcome.',
        evidence: [{ file: 'account.ts', quote }],
      }]),
    });
    expect(result.findings[0]!.gating).toMatchObject({
      reason: 'verified', verification: { verdict: 'confirmed' },
    });
  });

  it.each([
    ['normalizes CRLF source', '@@ -0,0 +1,2 @@\r\n+const account = load();\r\n+remove(account);', 'const account = load();\nremove(account);', 'verified'],
    ['does not join separate hunks', '@@ -1 +1 @@\n first line\n@@ -10 +10 @@\n second line', 'first line\nsecond line', 'none'],
  ])('%s', async (_label, patch, quote, reason) => {
    const result = await applyGating([{ ...finding, endLine: 2 }], {
      ...opts,
      diffFiles: [{ ...opts.diffFiles[0], patch }],
      ask: async () => answer([{
        ...confirmed,
        evidence: [{ file: 'account.ts', quote }],
      }]),
    });
    expect(result.findings[0]!.gating!.reason).toBe(reason);
  });

  it('replays version-two confirmations only when their evidence remains valid', () => {
    const plan = planGating([finding], opts);
    const confirmedResult = replayGating(plan, [{ batchIndex: 0, kind: 'answer', answer: answer([confirmed]) }], 1);
    expect(confirmedResult.findings[0]!.gating).toMatchObject({ reason: 'verified', verification: { verdict: 'confirmed' } });

    const invalidPlan = planGating([finding], opts);
    const invalidResult = replayGating(invalidPlan, [{ batchIndex: 0, kind: 'answer', answer: answer([{
      ...confirmed, evidence: [{ file: 'account.ts', quote: 'not supplied' }],
    }]) }], 1);
    expect(invalidResult.findings[0]!.gating).toMatchObject({
      reason: 'none', verification: { verdict: 'insufficient_evidence' },
    });
  });

  it('keeps legacy unrefuted semantics when replaying a retained version-one plan', () => {
    const plan = planGating([finding], opts);
    plan.version = 1;
    delete plan.verificationReasoningEffort;
    for (const batch of plan.batches) delete batch.sourcePatches;
    const result = replayGating(plan, [{ batchIndex: 0, kind: 'answer', answer: answer([
      { id: 'F1', verdict: 'confirmed', reason: 'Legacy uncertainty was blocking.' },
    ]) }], 1);
    expect(result.findings[0]!.gating).toMatchObject({ reason: 'verified', verification: { verdict: 'unrefuted' } });
  });
});
