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
 * A blocking reviewer counts as successful only when every returned chunk
 * succeeded. One failed or canceled part makes its coverage incomplete, so
 * findings from its successful parts must not vote in consensus. Async-only
 * results remain opportunistic: any arrived success may contribute, while an
 * async result can neither rescue nor poison a same-key blocking reviewer.
 *
 * Accounting and diagnostics cover ALL returned parts, including failed and
 * async ones: those calls still consumed time and tokens even when they do
 * not affect the blocking reviewer's status or findings.
 */
export interface RawFindingOrigin { reviewIndex: number; findingIndex: number }
export interface MergedChunkReviewsWithContributions {
  reviews: ModelReview[];
  /** [merged review][merged finding][raw source finding], positional only. */
  contributions: RawFindingOrigin[][][];
}

interface IndexedReview { review: ModelReview; reviewIndex: number }
interface MergedReviewEntry { review: ModelReview; contributions: RawFindingOrigin[][] }

function origins(parts: readonly IndexedReview[]): RawFindingOrigin[][] {
  return parts.flatMap(({ review, reviewIndex }) => review.findings.map((_, findingIndex) => [{ reviewIndex, findingIndex }]));
}

/** Existing merge semantics with positional source lineage retained alongside each returned finding. */
function mergeChunkReviewEntries(reviews: ModelReview[], collectContributions: boolean): MergedReviewEntry[] {
  const byReviewer = new Map<string, IndexedReview[]>();
  const order: string[] = [];
  for (const [reviewIndex, review] of reviews.entries()) {
    const key = `${review.model}::${review.role}`;
    const existing = byReviewer.get(key);
    if (existing) existing.push({ review, reviewIndex });
    else { byReviewer.set(key, [{ review, reviewIndex }]); order.push(key); }
  }

  return order.map((key) => {
    const indexedParts = byReviewer.get(key)!;
    const parts = indexedParts.map(({ review }) => review);
    if (parts.length === 1) return { review: parts[0]!, contributions: collectContributions ? origins(indexedParts) : [] };

    const first = parts[0]!;
    const blockingParts = indexedParts.filter(({ review }) => review.async !== true);
    const outcomeParts = blockingParts.length > 0 ? blockingParts : indexedParts;
    const successes = outcomeParts.filter(({ review }) => review.status === 'success');
    const requireComplete = blockingParts.length > 0;
    const successful = requireComplete
      ? successes.length === outcomeParts.length
      : successes.length > 0;
    const durationMs = parts.reduce((sum, part) => sum + part.durationMs, 0);
    const dropped = parts.reduce((sum, part) => sum + (part.droppedFindings ?? 0), 0);
    const warnings = parts.flatMap((part) => part.warnings ?? []);
    const usage = sumUsage(parts);
    const attempts = parts.map(part => part.adapterAttempts);
    const totalAttempts = attempts.every((count): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
      ? attempts.reduce((sum, count) => sum + count, 0) : undefined;
    const degraded = {
      ...(totalAttempts !== undefined && Number.isSafeInteger(totalAttempts) ? { adapterAttempts: totalAttempts } : {}),
      ...(usage ? { usage } : {}),
      ...(dropped > 0 ? { droppedFindings: dropped } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(blockingParts.length === 0 ? { async: true } : {}),
    };

    if (successful) {
      return {
        review: {
          model: first.model,
          role: first.role,
          provider: first.provider,
          findings: successes.flatMap(({ review }) => review.findings),
          durationMs,
          status: 'success',
          ...degraded,
        },
        contributions: collectContributions ? origins(successes) : [],
      };
    }

    const failed = outcomeParts.find(({ review }) => review.status !== 'success' && review.error)?.review ??
      outcomeParts.find(({ review }) => review.status !== 'success')?.review ?? first;
    const incompleteError =
      requireComplete && successes.length > 0
        ? `Incomplete chunk coverage: ${successes.length}/${outcomeParts.length} parts succeeded; ` +
          `${failed.status}${failed.error ? `: ${failed.error}` : ''}`
        : failed.error;
    return {
      review: {
        model: first.model,
        role: first.role,
        provider: first.provider,
        findings: [],
        durationMs,
        status: failed.status,
        ...(incompleteError ? { error: incompleteError } : {}),
        ...degraded,
      },
      contributions: [],
    };
  });
}

/** Original merge API; this is intentionally the same internal merge path as the provenance API. */
export function mergeChunkReviews(reviews: ModelReview[]): ModelReview[] {
  return mergeChunkReviewEntries(reviews, false).map((entry) => entry.review);
}

export function mergeChunkReviewsWithContributions(reviews: ModelReview[]): MergedChunkReviewsWithContributions {
  const merged = mergeChunkReviewEntries(reviews, true);
  return { reviews: merged.map((entry) => entry.review), contributions: merged.map((entry) => entry.contributions) };
}
