import type { ModelReview, TokenUsage } from '../consensus/types.js';

/**
 * Total usage across chunks, complete per counter: a counter is summed only
 * when EVERY chunk reported it. A chunk that timed out or errored consumed
 * tokens nobody counted, and a provider that omitted a counter on one chunk
 * leaves that counter unknown for the reviewer — a silent lower bound would
 * read as the total in the evidence ledger. Absent (never `{}`) when no
 * counter is complete.
 */
function sumUsage(parts: readonly ModelReview[]): TokenUsage | undefined {
  const reported = parts.map((p) => p.usage);
  if (reported.length === 0 || reported.some((u) => u === undefined)) return undefined;
  const usages = reported as TokenUsage[];
  const total: TokenUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens'] as const) {
    const values = usages.map((u) => u[key]);
    if (values.every((v): v is number => typeof v === 'number')) {
      total[key] = values.reduce((sum, v) => sum + v, 0);
    }
  }
  return Object.keys(total).length > 0 ? total : undefined;
}

/**
 * A large diff is reviewed as multiple chunks, so each (model, role)
 * reviewer produces one ModelReview per chunk. Merge them back into one
 * review per reviewer before consensus, or a single reviewer would be
 * counted once per chunk — inflating `total`, diversity, and vote counts.
 *
 * A reviewer counts as successful if it succeeded on at least one chunk;
 * findings from every successful chunk are concatenated. When no chunk
 * succeeded, the first non-success status and error are preserved.
 *
 * Dropped-finding counts and parser warnings are summed across ALL chunks,
 * including the ones that failed: a reviewer that parsed cleanly on chunk 1
 * and lost everything on chunk 2 is only partially covered, and the merged
 * review is the last place that can still say so.
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
    const dropped = parts.reduce((sum, p) => sum + (p.droppedFindings ?? 0), 0);
    const warnings = parts.flatMap((p) => p.warnings ?? []);
    const usage = sumUsage(parts);
    const degraded = {
      ...(usage ? { usage } : {}),
      ...(dropped > 0 ? { droppedFindings: dropped } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      // A reviewer is homogeneous across chunks, so any async part means the
      // whole merged review came from the async lane.
      ...(parts.some((p) => p.async) ? { async: true } : {}),
    };

    if (successes.length > 0) {
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

    const failed = parts.find((p) => p.error) ?? first;
    return {
      model: first.model,
      role: first.role,
      provider: first.provider,
      findings: [],
      durationMs,
      status: failed.status,
      error: failed.error,
      ...degraded,
    };
  });
}
