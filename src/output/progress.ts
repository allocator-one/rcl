import type { ModelReview } from '../consensus/types.js';

export interface CouncilRunPlan {
  totalCalls: number;
  reviewers: number;
  chunks: number;
  concurrency: number;
  waves: number;
  timeoutMs: number;
  timeoutBoundMs: number;
}

export function buildCouncilRunPlan(options: {
  totalCalls: number;
  reviewers: number;
  chunks: number;
  concurrency: number;
  timeoutMs: number;
}): CouncilRunPlan {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const waves = options.totalCalls === 0 ? 0 : Math.ceil(options.totalCalls / concurrency);
  return {
    ...options,
    concurrency,
    waves,
    timeoutBoundMs: waves * options.timeoutMs,
  };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function formatCouncilRunPlan(plan: CouncilRunPlan): string {
  return (
    `Review plan: ${plan.totalCalls} calls ` +
    `(${plan.reviewers} reviewers × ${plan.chunks} chunk(s)), ` +
    `concurrency ${plan.concurrency} → ${plan.waves} wave(s); ` +
    `${formatDuration(plan.timeoutMs)} per-call timeout, ` +
    `${formatDuration(plan.timeoutBoundMs)} timeout-bound queue estimate`
  );
}

type ReviewStatus = ModelReview['status'];

interface ProgressCounters {
  success: number;
  timeout: number;
  error: number;
  parse_failed: number;
}

interface ProgressReporterOptions {
  totalCalls: number;
  interactive: boolean;
  updateInteractive: (text: string) => void;
  writeLine: (text: string) => void;
  now?: () => number;
  heartbeatMs?: number;
  maxCompletionLines?: number;
}

const STATUS_ICONS: Record<ReviewStatus, string> = {
  success: '✓',
  timeout: '⏱',
  error: '✗',
  parse_failed: '⚠',
};

const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_MAX_COMPLETION_LINES = 20;

/**
 * Keeps the interactive spinner compact while making redirected runs
 * observable. Non-TTY output is bounded to periodic heartbeats plus roughly
 * `maxCompletionLines` completion checkpoints, even for very large councils.
 */
export class CouncilProgressReporter {
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly completionStride: number;
  private readonly startedAt: number;
  private lastLineAt: number;
  private completed = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly counters: ProgressCounters = {
    success: 0,
    timeout: 0,
    error: 0,
    parse_failed: 0,
  };

  constructor(private readonly options: ProgressReporterOptions) {
    this.now = options.now ?? Date.now;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const maxLines = Math.max(1, options.maxCompletionLines ?? DEFAULT_MAX_COMPLETION_LINES);
    this.completionStride = Math.max(1, Math.ceil(options.totalCalls / maxLines));
    this.startedAt = this.now();
    this.lastLineAt = this.startedAt;
  }

  start(): void {
    if (this.options.interactive || this.heartbeat !== undefined) return;
    this.heartbeat = setInterval(() => {
      const current = this.now();
      if (current - this.lastLineAt >= this.heartbeatMs) {
        this.writeNonInteractive(current);
      }
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  complete(review: ModelReview): void {
    this.completed++;
    this.counters[review.status]++;
    const current = this.now();

    if (this.options.interactive) {
      this.options.updateInteractive(
        `${this.summary(current)} [${STATUS_ICONS[review.status]} ${review.model}/${review.role}]`
      );
      return;
    }

    if (
      this.completed === 1 ||
      this.completed === this.options.totalCalls ||
      this.completed % this.completionStride === 0
    ) {
      this.writeNonInteractive(current);
    }
  }

  stop(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private summary(current: number): string {
    return (
      `Reviews ${this.completed}/${this.options.totalCalls} ` +
      `(success ${this.counters.success}, timeout ${this.counters.timeout}, ` +
      `error ${this.counters.error}, parse_failed ${this.counters.parse_failed}) · ` +
      `elapsed ${formatDuration(current - this.startedAt)}`
    );
  }

  private writeNonInteractive(current: number): void {
    this.options.writeLine(this.summary(current));
    this.lastLineAt = current;
  }
}
