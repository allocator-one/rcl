import type { ModelReview } from '../consensus/types.js';

/**
 * A large diff is reviewed as multiple chunks, so each (model, role)
 * reviewer produces one ModelReview per chunk. Merge them back into one
 * review per reviewer before consensus, or a single reviewer would be
 * counted once per chunk — inflating `total`, diversity, and vote counts.
 *
 * A reviewer counts as successful if it succeeded on at least one chunk;
 * findings from every successful chunk are concatenated. When no chunk
 * succeeded, the first non-success status and error are preserved.
 */
export function mergeChunkReviews(reviews: ModelReview[]): ModelReview[] {
  const byReviewer = new Map<string, ModelReview[]>();
  const order: string[] = [];
  for (const review of reviews) {
    const key = `${review.model}::${review.role}`;
    const existing = byReviewer.get(key);
    if (existing) {
      existing.push(review);
    } else {
      byReviewer.set(key, [review]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const parts = byReviewer.get(key)!;
    if (parts.length === 1) return parts[0]!;

    const first = parts[0]!;
    const successes = parts.filter((p) => p.status === 'success');
    const durationMs = parts.reduce((sum, p) => sum + p.durationMs, 0);

    if (successes.length > 0) {
      return {
        model: first.model,
        role: first.role,
        provider: first.provider,
        findings: successes.flatMap((p) => p.findings),
        durationMs,
        status: 'success',
      };
    }

    const failed = parts.find((p) => p.error) ?? first;
    return {
      model: first.model,
      role: first.role,
      provider: first.provider,
      findings: [],
      durationMs,
      status: failed.status,
      error: failed.error,
    };
  });
}
