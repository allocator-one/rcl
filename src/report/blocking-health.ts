import { isDeepStrictEqual } from 'node:util';
import type { ModelReview, ReviewResult } from '../consensus/types.js';
import { DEFAULT_QUORUM_FRACTION } from '../config/defaults.js';
import { hasSuccessfulQuorum, resolveQuorumPolicy, type QuorumPolicy } from '../dispatch/quorum.js';
import type { RosterEntry, RosterLane } from './run-header.js';

/**
 * The lane Harness assigns a report review row: the first roster entry with
 * the same model and role, else async when flagged, else blocking. Evidence
 * envelopes use this same function, so client health reads the rows exactly
 * as the server's `Status.conclusive?/1` does.
 */
export function reviewLane(review: Pick<ModelReview, 'model' | 'role' | 'async'>, roster: readonly RosterEntry[]): RosterLane {
  const seat = roster.find((entry) => entry.model === review.model && entry.role === review.role);
  if (seat) return seat.lane;
  return review.async ? 'async' : 'blocking';
}

export interface BlockingSeat {
  model: string;
  role: string;
  /** `missing`: the roster names the seat but no blocking row covers it. */
  status: ModelReview['status'] | 'missing';
}

/** Report-level blocking reviewer health; aggregate `stats` stay informational. */
export interface BlockingHealth {
  policy: QuorumPolicy;
  successfulSeats: BlockingSeat[];
  unsuccessfulSeats: BlockingSeat[];
  conclusive: boolean;
  /** Successful rows outside the blocking lane: retained, never counted. */
  excludedSuccesses: Record<Exclude<RosterLane, 'blocking'>, number>;
}

/** The count-only projection written to `stats.blockingHealth`. */
export interface BlockingHealthSummary {
  version: 1;
  fraction: number;
  seats: number;
  required: number;
  successful: number;
  conclusive: boolean;
  excludedSuccesses: Record<Exclude<RosterLane, 'blocking'>, number>;
}

const seatKey = (model: string, role: string): string => JSON.stringify([model, role]);
const STATUSES = new Set<unknown>(['success', 'timeout', 'error', 'parse_failed', 'canceled']);
const LANES = new Set<unknown>(['blocking', 'secondary', 'async', 'verification']);
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * Blocking health over merged report rows. A blocking seat counts only when
 * its merged review succeeded, which chunk merging grants only when every
 * required chunk succeeded. Secondary, async and verification successes are
 * counted separately and never reach the quorum. Duplicate model/role
 * assignments are one seat, as in the merged report and on the server.
 * A synchronous row outside a non-empty roster is refused rather than
 * counted, so an added row can never create a seat.
 * A stricter supported fraction raises the requirement; 2/3 is the floor.
 */
export function deriveBlockingHealth(input: {
  roster: readonly RosterEntry[];
  reviews: readonly ModelReview[];
  fraction?: number;
}): BlockingHealth {
  const seats = new Map<string, { model: string; role: string }>();
  if (!Array.isArray(input.roster) || !Array.isArray(input.reviews)) throw new Error('Invalid roster or reviewer rows');
  for (const entry of input.roster) {
    // An unknown lane must never silently drop a seat from the requirement.
    if (!entry || !nonblank(entry.model) || !nonblank(entry.role) || !LANES.has(entry.lane)) {
      throw new Error('Invalid roster entry identity or lane');
    }
    if (entry.lane === 'blocking') seats.set(seatKey(entry.model, entry.role), { model: entry.model, role: entry.role });
  }
  const rows = new Map<string, ModelReview>();
  const excludedSuccesses = { secondary: 0, async: 0, verification: 0 };
  for (const review of input.reviews) {
    if (!review || !nonblank(review.model) || !nonblank(review.role) || !STATUSES.has(review.status)) {
      throw new Error('Invalid reviewer row identity or status');
    }
    const lane = reviewLane(review, input.roster);
    if (lane !== 'blocking') {
      if (review.status === 'success') excludedSuccesses[lane]++;
      continue;
    }
    const key = seatKey(review.model, review.role);
    // An async-only row on a blocking seat cannot supply that seat's coverage.
    if (review.async === true) {
      if (review.status === 'success') excludedSuccesses.async++;
      if (!seats.has(key)) continue;
      if (rows.has(key)) throw new Error(`Duplicate blocking reviewer row for ${review.model}/${review.role}`);
      rows.set(key, review);
      continue;
    }
    if (rows.has(key)) throw new Error(`Duplicate blocking reviewer row for ${review.model}/${review.role}`);
    rows.set(key, review);
    if (!seats.has(key)) {
      // Every row RCL writes is rostered; only a legacy report without a
      // roster falls back to treating its synchronous rows as blocking.
      if (input.roster.length > 0) throw new Error(`Unrostered reviewer row for ${review.model}/${review.role}`);
      seats.set(key, { model: review.model, role: review.role });
    }
  }
  const policy = resolveQuorumPolicy(seats.size, input.fraction ?? DEFAULT_QUORUM_FRACTION);
  const successfulSeats: BlockingSeat[] = [];
  const unsuccessfulSeats: BlockingSeat[] = [];
  for (const [key, seat] of seats) {
    const review = rows.get(key);
    const status = review === undefined || review.async === true ? 'missing' : review.status;
    (status === 'success' ? successfulSeats : unsuccessfulSeats).push({ ...seat, status });
  }
  return {
    policy,
    successfulSeats,
    unsuccessfulSeats,
    conclusive: hasSuccessfulQuorum(policy, successfulSeats.length),
    excludedSuccesses,
  };
}

export function summarizeBlockingHealth(health: BlockingHealth): BlockingHealthSummary {
  return {
    version: 1,
    fraction: health.policy.fraction,
    seats: health.policy.seatCount,
    required: health.policy.minimumSuccessful,
    successful: health.successfulSeats.length,
    conclusive: health.conclusive,
    excludedSuccesses: { ...health.excludedSuccesses },
  };
}

/** One line naming the counted seats, the requirement and every seat that fell short. */
export function describeBlockingHealth(health: BlockingHealth): string {
  const { policy } = health;
  const excluded = Object.entries(health.excludedSuccesses)
    .filter(([, count]) => count > 0).map(([lane, count]) => `${count} ${lane}`);
  const short = health.unsuccessfulSeats.map((seat) => `${seat.model}/${seat.role} (${seat.status})`);
  return `Blocking reviewer health ${health.conclusive ? 'conclusive' : 'inconclusive'}: ` +
    `${health.successfulSeats.length}/${policy.seatCount} blocking seats complete; ${policy.minimumSuccessful} required` +
    (excluded.length > 0 ? `; excluded from quorum: ${excluded.join(', ')} successful` : '') +
    (short.length > 0 ? `; incomplete: ${short.join(', ')}` : '') + '.';
}

export class ReportHealthError extends Error {
  constructor(readonly code: 'report_health_inconclusive' | 'report_health_unverifiable', message: string, readonly health?: BlockingHealth) {
    super(message);
    this.name = 'ReportHealthError';
  }
}

/**
 * Admission check for a serialized report. Health is derived again from the
 * report's roster and rows; a recorded summary may only confirm it, and its
 * fraction may only make the requirement stricter than the server's 2/3.
 */
export function assertAdmissibleReportHealth(report: Pick<ReviewResult, 'reviews' | 'run' | 'stats'>): BlockingHealth {
  const recorded = (report.stats as { blockingHealth?: unknown } | undefined)?.blockingHealth;
  let health: BlockingHealth;
  try {
    if (!Array.isArray(report.reviews)) throw new Error('report has no reviews array');
    const fraction = recorded === undefined ? DEFAULT_QUORUM_FRACTION : (recorded as { fraction?: unknown }).fraction;
    if (typeof fraction !== 'number') throw new Error('recorded blocking health has no fraction');
    health = deriveBlockingHealth({ roster: report.run?.roster ?? [], reviews: report.reviews, fraction });
    if (recorded !== undefined && !isDeepStrictEqual(recorded, summarizeBlockingHealth(health))) {
      throw new Error('recorded blocking health does not match the report rows');
    }
  } catch (error) {
    throw new ReportHealthError('report_health_unverifiable',
      `Reviewer health cannot be derived from this report (${error instanceof Error ? error.message : String(error)}); it is not admitted.`);
  }
  if (!health.conclusive) {
    throw new ReportHealthError('report_health_inconclusive',
      `${describeBlockingHealth(health)} The report is not admitted; its findings are not triaged.`, health);
  }
  return health;
}
