import { describe, it, expect } from 'vitest';
import { mergeChunkReviews } from '../../src/dispatch/merge.js';
import type { ModelReview } from '../../src/consensus/types.js';

function review(over: Partial<ModelReview>): ModelReview {
  return {
    model: 'm1',
    role: 'general',
    provider: 'test',
    findings: [],
    durationMs: 10,
    status: 'success',
    ...over,
  };
}

function finding(id: string) {
  return {
    id,
    file: 'src/a.ts',
    startLine: 1,
    endLine: 1,
    severity: 'minor' as const,
    category: 'security' as const,
    title: id,
    description: id,
  };
}

describe('mergeChunkReviews', () => {
  it('merges findings from the same reviewer across chunks into one review', () => {
    const merged = mergeChunkReviews([
      review({ findings: [finding('a')] }),
      review({ findings: [finding('b')] }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.findings.map((f) => f.id)).toEqual(['a', 'b']);
    expect(merged[0]!.durationMs).toBe(20);
  });

  it('keeps distinct reviewers separate', () => {
    const merged = mergeChunkReviews([
      review({ model: 'm1', role: 'general', findings: [finding('a')] }),
      review({ model: 'm2', role: 'security-auditor', findings: [finding('b')] }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('counts a reviewer successful if any chunk succeeded, keeping its findings', () => {
    const merged = mergeChunkReviews([
      review({ findings: [finding('a')], status: 'success' }),
      review({ findings: [], status: 'timeout', error: 'timed out' }),
    ]);
    expect(merged[0]!.status).toBe('success');
    expect(merged[0]!.findings.map((f) => f.id)).toEqual(['a']);
  });

  it('preserves the failure when no chunk succeeded', () => {
    const merged = mergeChunkReviews([
      review({ findings: [], status: 'error', error: 'boom' }),
      review({ findings: [], status: 'timeout', error: 'slow' }),
    ]);
    expect(merged[0]!.status).toBe('error');
    expect(merged[0]!.error).toBe('boom');
  });

  it('is a no-op for a single chunk', () => {
    const one = [review({ findings: [finding('a')] })];
    expect(mergeChunkReviews(one)).toEqual(one);
  });
});
