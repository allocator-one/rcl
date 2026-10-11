import { z } from 'zod';
import type { HarnessSink, SinkOutcome } from '../telemetry/sink.js';
import { scrubText } from '../telemetry/scrub.js';
import { reviewCycleReceiptSchema, type ReviewCycleRemote } from './review-cycle.js';

/** A server-confirmed noncommit can restore local barriers; uncertain replies cannot. */
export class ReviewCycleRejected extends Error {}

export type LivePullRequestReader = () => Promise<{ headSha: string; merged: boolean; state: string }>;

/** Keep the server's own status and reason in every refusal (RCL-193). */
function describeOutcome(result: Exclude<SinkOutcome<unknown>, { kind: 'ok' }>): string {
  const detail = (text: string) => text ? `: ${scrubText(text, 300)}` : '';
  switch (result.kind) {
    case 'rejected': return `rejected HTTP ${result.httpStatus} ${scrubText(result.error, 100)}${detail(result.message)}`;
    case 'disabled': return `disabled ${result.reason}${detail(result.message)}`;
    case 'conflict': return `conflict${detail(result.message)}`;
    case 'unavailable': return `unavailable ${scrubText(result.reason, 300)}`;
  }
}

export function createReviewCycleRemote(sink: HarnessSink, repo: string, prNumber: number, headSha: string,
  readLivePr: LivePullRequestReader): ReviewCycleRemote {
  if (sink.credentialSource === 'attest') throw new Error('fresh_review_requires_actor_credential');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(segment => segment === '.' || segment === '..') || !Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('fresh_review_requires_pr');
  repo = repo.toLowerCase();
  const path = `/api/v1/reviews/prs/${repo.split('/').map(encodeURIComponent).join('/')}/${prNumber}`;
  const activeCycle = async () => {
    const result = await sink.getJson(path, data => {
      const parsed = z.object({ repo: z.string(), pr_number: z.number(), cycle_protocol: z.literal(1),
        active_cycle: reviewCycleReceiptSchema.nullable() }).safeParse(data);
      if (!parsed.success || parsed.data.repo.toLowerCase() !== repo || parsed.data.pr_number !== prNumber) return null;
      return parsed.data;
    });
    if (result.kind !== 'ok') throw new Error(`fresh_review_capability_unavailable: ${describeOutcome(result)}; Harness must support review cycles`);
    return result.value.active_cycle;
  };
  return {
    repo, prNumber, url: sink.baseUrl,
    async current() {
      const active = await activeCycle();
      let livePr: Awaited<ReturnType<LivePullRequestReader>>;
      try {
        livePr = await readLivePr();
      } catch {
        throw new Error('fresh_review_github_unavailable');
      }
      if (!livePr || typeof livePr.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(livePr.headSha) ||
        typeof livePr.merged !== 'boolean' || typeof livePr.state !== 'string') throw new Error('fresh_review_github_unavailable');
      if (livePr.merged || livePr.state !== 'open' || livePr.headSha !== headSha) {
        throw new Error('fresh_review_head_changed');
      }
      return active;
    },
    async start(request) {
      const result = await sink.startReviewCycle(repo, prNumber, request);
      if (result.kind === 'ok') return result.value;
      if (result.kind === 'conflict' && /^Fresh review refused: (cycle_conflict|review_in_progress|merged|head_changed)$/.test(result.message)) {
        throw new ReviewCycleRejected(result.message);
      }
      const reason = describeOutcome(result);
      // Harness refuses a cycle with a 4xx (or a disabled organization) before
      // committing it. A lost acknowledgement could still hide this operation's
      // own earlier commit, so the refusal is final only once the read-back
      // active cycle is not this operation's (RCL-193).
      if ((result.kind === 'rejected' && result.httpStatus >= 400 && result.httpStatus < 500) || result.kind === 'disabled') {
        const active = await activeCycle().catch(() => undefined);
        if (active !== undefined && active?.operation_id !== request.operation_id) {
          throw new ReviewCycleRejected(`Fresh review refused: ${reason}. The target was restored; fix the cause, then request --start-over again.`);
        }
      }
      throw new Error(`fresh_review_receipt_unavailable: ${reason}; resume with --start-over to reuse this operation`);
    },
  };
}
