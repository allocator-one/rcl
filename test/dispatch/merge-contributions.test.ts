import { describe, expect, it } from 'vitest';
import { mergeChunkReviews, mergeChunkReviewsWithContributions } from '../../src/dispatch/merge.js';
import type { Finding, ModelReview } from '../../src/consensus/types.js';

function finding(id: string): Finding { return { id, file: 'a.ts', startLine: 1, endLine: 1, severity: 'minor', category: 'tests', title: id, description: id }; }
function review(overrides: Partial<ModelReview> = {}): ModelReview {
  return { model: 'm', role: 'general', provider: 'p', findings: [finding('one')], durationMs: 1, status: 'success', ...overrides };
}

describe('mergeChunkReviewsWithContributions', () => {
  it('aligns every merged blocking finding to its raw positional origin and keeps default output unchanged', () => {
    const raw = [review({ findings: [finding('a'), finding('b')] }), review({ findings: [finding('c')] })];
    const withOrigins = mergeChunkReviewsWithContributions(raw);
    expect(withOrigins.reviews).toEqual(mergeChunkReviews(raw));
    expect(withOrigins.contributions).toEqual([[
      [{ reviewIndex: 0, findingIndex: 0 }],
      [{ reviewIndex: 0, findingIndex: 1 }],
      [{ reviewIndex: 1, findingIndex: 0 }],
    ]]);
  });

  it('preserves blocking precedence, incomplete exclusion, and raw failed singleton behavior', () => {
    const blocking = review({ findings: [finding('blocking')] });
    const async = review({ async: true, findings: [finding('async')] });
    const incomplete = review({ status: 'error', findings: [finding('failed')], error: 'down' });
    const singletonFailed = review({ model: 'other', status: 'error', findings: [finding('single-failed')], error: 'down' });
    const merged = mergeChunkReviewsWithContributions([blocking, async, incomplete, singletonFailed]);
    expect(merged.reviews[0]!.status).toBe('error');
    expect(merged.reviews[0]!.findings).toEqual([]);
    expect(merged.contributions[0]).toEqual([]);
    expect(merged.reviews[1]!.findings).toEqual([finding('single-failed')]);
    expect(merged.contributions[1]).toEqual([[{ reviewIndex: 3, findingIndex: 0 }]]);
  });

  it('keeps async-only successes and contribution positions without IDs or text joins', () => {
    const first = review({ async: true, findings: [finding('same'), finding('same')] });
    const second = review({ async: true, findings: [finding('same')] });
    const result = mergeChunkReviewsWithContributions([first, second]);
    expect(result.reviews[0]!.async).toBe(true);
    expect(result.contributions[0]).toEqual([
      [{ reviewIndex: 0, findingIndex: 0 }],
      [{ reviewIndex: 0, findingIndex: 1 }],
      [{ reviewIndex: 1, findingIndex: 0 }],
    ]);
  });
});
