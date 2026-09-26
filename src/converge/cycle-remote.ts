import { z } from 'zod';
import type { HarnessSink } from '../telemetry/sink.js';
import { reviewCycleReceiptSchema, type ReviewCycleRemote } from './review-cycle.js';

/** A server-confirmed noncommit can restore local barriers; uncertain replies cannot. */
export class ReviewCycleRejected extends Error {}

export function createReviewCycleRemote(sink: HarnessSink, repo: string, prNumber: number, headSha: string): ReviewCycleRemote {
  if (sink.credentialSource === 'attest') throw new Error('fresh_review_requires_actor_credential');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(segment => segment === '.' || segment === '..') || !Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('fresh_review_requires_pr');
  repo = repo.toLowerCase();
  const path = `/api/v1/reviews/prs/${repo.split('/').map(encodeURIComponent).join('/')}/${prNumber}`;
  return {
    repo, prNumber, url: sink.baseUrl,
    async current() {
      const result = await sink.getJson(path, data => {
        const parsed = z.object({ repo: z.string(), pr_number: z.number(), cycle_protocol: z.literal(1),
          active_cycle: reviewCycleReceiptSchema.nullable(), head: z.object({ sha: z.string(), merged: z.boolean() }).nullable() }).safeParse(data);
        if (!parsed.success || parsed.data.repo.toLowerCase() !== repo || parsed.data.pr_number !== prNumber) return null;
        return parsed.data;
      });
      if (result.kind !== 'ok') throw new Error(`fresh_review_capability_unavailable: ${result.kind}; Harness must support review cycles`);
      if (result.value.head ? result.value.head.merged || result.value.head.sha !== headSha : result.value.active_cycle !== null) {
        throw new Error('fresh_review_head_changed');
      }
      return result.value.active_cycle;
    },
    async start(request) {
      const result = await sink.startReviewCycle(repo, prNumber, request);
      if (result.kind === 'ok') return result.value;
      if (result.kind === 'conflict' && /^Fresh review refused: (cycle_conflict|review_in_progress|merged|head_changed)$/.test(result.message)) {
        throw new ReviewCycleRejected(result.message);
      }
      throw new Error(`fresh_review_receipt_unavailable: ${result.kind}; resume with --start-over to reuse this operation`);
    },
  };
}
