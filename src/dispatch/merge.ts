import type { ModelReview } from '../consensus/types.js';

/**
 * A large diff is reviewed as multiple chunks, so each (model, role)
 * reviewer produces one ModelReview per chunk. Merge them back into one
 * review per reviewer before consensus, or a single reviewer would be
 * counted once per chunk — inflating `total`, diversity, and vote counts.
 *
 * A blocking reviewer counts as successful only when every returned chunk
 * succeeded. One failed or canceled part makes its coverage incomplete, so
 * findings from its successful parts must not vote in consensus. Async-only
 * results remain opportunistic: any arrived success may contribute, while an
 * async result can neither rescue nor poison a same-key blocking reviewer.
 *
 * Accounting and diagnostics cover ALL returned parts, including failed and
 * async ones: those calls still consumed time and produced diagnostics even
 * when they do not affect the blocking reviewer's status or findings.
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
    const blockingParts = parts.filter((part) => part.async !== true);
    const outcomeParts = blockingParts.length > 0 ? blockingParts : parts;
    const successes = outcomeParts.filter((part) => part.status === 'success');
    const requireComplete = blockingParts.length > 0;
    const successful = requireComplete
      ? successes.length === outcomeParts.length
      : successes.length > 0;
    const durationMs = parts.reduce((sum, part) => sum + part.durationMs, 0);
    const dropped = parts.reduce((sum, part) => sum + (part.droppedFindings ?? 0), 0);
    const warnings = parts.flatMap((part) => part.warnings ?? []);
    const degraded = {
      ...(dropped > 0 ? { droppedFindings: dropped } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(blockingParts.length === 0 ? { async: true } : {}),
    };

    if (successful) {
      return {
        model: first.model,
        role: first.role,
        provider: first.provider,
        findings: successes.flatMap((p) => p.findings),
        durationMs,
        status: 'success',
        ...degraded,
      };
    }

    const failed =
      outcomeParts.find((part) => part.status !== 'success' && part.error) ??
      outcomeParts.find((part) => part.status !== 'success') ??
      first;
    const incompleteError =
      requireComplete && successes.length > 0
        ? `Incomplete chunk coverage: ${successes.length}/${outcomeParts.length} parts succeeded; ` +
          `${failed.status}${failed.error ? `: ${failed.error}` : ''}`
        : failed.error;
    return {
      model: first.model,
      role: first.role,
      provider: first.provider,
      findings: [],
      durationMs,
      status: failed.status,
      ...(incompleteError ? { error: incompleteError } : {}),
      ...degraded,
    };
  });
}
