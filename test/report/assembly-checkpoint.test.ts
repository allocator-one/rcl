import { describe, expect, it, vi } from 'vitest';
import { assembleCompletedReview } from '../../src/report/assembly.js';
import { deriveReviewerHealth } from '../../src/report/reviewer-health.js';
import type { ModelReview } from '../../src/consensus/types.js';
import type { Diff } from '../../src/resolver/types.js';

const review = (model: string): ModelReview => ({ model, role: 'general', provider: 'fake', status: 'success', durationMs: 1, findings: [] });
const reviews = [review('m0'), review('m1'), review('m2')];
const plan = { version: 1 as const,
  roster: reviews.map((r, index) => ({ seat: `s${index}`, model: r.model, role: r.role, route: r.provider })),
  chunks: [{ index: 0, total: 1, digest: 'a'.repeat(64) }],
  cells: reviews.map((r, index) => ({ id: `s${index}:0`, seat: `s${index}`, chunk: 0, model: r.model, role: r.role, route: r.provider, chunkDigest: 'a'.repeat(64) })),
};
const role = { name: 'general', systemPrompt: '', focus: [], description: '', isSpecialized: false };
const diff: Diff = { source: 'local', files: [] };
function fixture() {
  return { chunkReviews: structuredClone(reviews), arrivedAsync: [], asyncLaunched: 0, startTime: Date.now(),
    roleMap: new Map([['general', role]]), config: { thresholds: { minConfidence: 0, minConsensusScore: 0 } }, diff,
    gatingConfig: { mode: 'verified-consensus' as const, minModels: 2, verificationModel: 'fake/verifier', verificationTimeoutMs: 1000, verificationPassTimeoutMs: 1000 },
    run: { id: '01a0daa6-b575-759b-942c-e879460be5bf', rclVersion: '4.1.3', command: 'review' as const,
      target: { kind: 'patch' as const }, roster: plan.roster.map(seat => ({ model: seat.model, role: seat.role, provider: seat.route, lane: 'blocking' as const })),
      runner: { kind: 'agent' as const }, startedAt: new Date() } };
}

describe('checkpoint health and contributions through shared assembly', () => {
  it('fails closed below original-seat quorum and buys no verifier calls', async () => {
    const input = fixture();
    input.chunkReviews[0]!.findings.push({ id: 'f', file: 'x.ts', startLine: 1, endLine: 1,
      severity: 'important', category: 'correctness', title: 'Missing guard', description: 'Guard is absent.' });
    const health = deriveReviewerHealth(plan, [{ cell: 's0:0', review: input.chunkReviews[0]! }], { version: 1, fraction: 2 / 3 });
    const ask = vi.fn();
    const result = await assembleCompletedReview({ ...input, reviewerHealth: health }, { ask });
    expect(result.run.ci_exit_code).toBe(1);
    expect(ask).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(1);
    await expect(assembleCompletedReview({ ...input, reviewerHealth: JSON.parse(JSON.stringify(health)) }, { ask })).rejects.toThrow();
  });

  it('retains every successful finding reference through dedupe and keeps actionables blocking', async () => {
    const input = fixture();
    const finding = { id: 'first', file: 'x.ts', startLine: 1, endLine: 1,
      severity: 'critical' as const, category: 'security' as const, title: 'Missing tenant check', description: 'Any tenant can read records.' };
    input.chunkReviews[0]!.findings.push(finding, { ...finding, id: 'repeated' });
    input.chunkReviews[1]!.findings.push({ ...finding, id: 'other-model' });
    const health = deriveReviewerHealth(plan, input.chunkReviews.slice(0, 2).map((r, index) => ({ cell: `s${index}:0`, review: r })), { version: 1, fraction: 2 / 3 });
    const contributions = vi.fn();
    const result = await assembleCompletedReview({ ...input, reviewerHealth: health }, { onFindingContributions: contributions });
    expect(result.run.ci_exit_code).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(contributions).toHaveBeenCalledOnce();
    expect(contributions.mock.calls[0]![0]).toEqual([{ reportIdentity: result.findings[0]!.identity,
      disposition: 'kept', contributions: [{ reviewIndex: 0, findingIndex: 0 }, { reviewIndex: 0, findingIndex: 1 }, { reviewIndex: 1, findingIndex: 0 }] }]);
  });
});
