import { describe, expect, it } from 'vitest';
import type { ModelReview, ReviewResult } from '../../src/consensus/types.js';
import { mergeChunkReviews } from '../../src/dispatch/merge.js';
import {
  assertAdmissibleReportHealth, deriveBlockingHealth, describeBlockingHealth, ReportHealthError, summarizeBlockingHealth,
} from '../../src/report/blocking-health.js';
import type { RosterEntry, RosterLane } from '../../src/report/run-header.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { sampleResult } from '../telemetry/fixtures.js';

type Outcome = ModelReview['status'];

/**
 * Harness `Status.conclusive?/1` (lib/allocator_one/harness/reviews/status.ex),
 * unchanged: blocking-lane call rows only, n >= 2 and successes >= max(2, ⌈2n/3⌉).
 */
function harnessConclusive(calls: ReadonlyArray<{ lane: string; status: string }>): boolean {
  const blocking = calls.filter((call) => call.lane === 'blocking');
  const n = blocking.length;
  const successful = blocking.filter((call) => call.status === 'success').length;
  return n >= 2 && successful >= Math.max(2, Math.floor((2 * n + 2) / 3));
}

/** The skill's pre-RCL-136 aggregate rule over report stats. */
function aggregateConclusive(stats: ReviewResult['stats']): boolean {
  return stats.successfulReviews >= Math.max(2, Math.ceil(2 * stats.totalReviews / 3));
}

function part(model: string, role: string, status: Outcome, extra: Partial<ModelReview> = {}): ModelReview {
  return {
    model, role, provider: 'fake', durationMs: 1, status,
    findings: status === 'success' ? [{ file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness',
      title: `${model} ${role}`, description: 'd', confidence: 0.9 }] : [],
    ...(status === 'success' ? {} : { error: status === 'canceled' ? 'Canceled at quorum round closure while in flight' : status }),
    ...extra,
  };
}

interface SeatSpec { model: string; role: string; lane: RosterLane; chunks: Outcome[] }

/** A report whose rows are merged from per-chunk results, as the CLI writes them. */
function report(seats: SeatSpec[], fraction?: number): ReviewResult & { run: NonNullable<ReviewResult['run']> } {
  const base = sampleResult();
  const roster: RosterEntry[] = [];
  for (const seat of seats) {
    if (!roster.some((entry) => entry.model === seat.model && entry.role === seat.role)) {
      roster.push({ model: seat.model, role: seat.role, provider: 'fake', lane: seat.lane });
    }
  }
  const parts = seats.flatMap((seat) => seat.chunks.map((status) =>
    part(seat.model, seat.role, status, seat.lane === 'async' ? { async: true } : {})));
  const reviews = mergeChunkReviews(parts);
  const health = deriveBlockingHealth({ roster, reviews, ...(fraction !== undefined ? { fraction } : {}) });
  return {
    ...base,
    run: { ...base.run!, roster },
    reviews,
    stats: {
      ...base.stats,
      totalReviews: reviews.length,
      successfulReviews: reviews.filter((review) => review.status === 'success').length,
      blockingHealth: summarizeBlockingHealth(health),
    },
  };
}

function seats(count: number, lane: RosterLane, chunks: Outcome[], prefix = lane): SeatSpec[] {
  return Array.from({ length: count }, (_, index) => ({ model: `${prefix}-${index + 1}`, role: 'bug-hunter', lane, chunks }));
}

const COMPLETE: Outcome[] = ['success', 'success', 'success', 'success'];
const TIMED_OUT: Outcome[] = ['success', 'success', 'timeout', 'timeout'];

function serverAgrees(value: ReturnType<typeof report>): boolean {
  const envelope = buildRunEnvelope(value, { report_json: '{}', report_md: '' }, { level: 'full', delivery: { mode: 'direct' } });
  return harnessConclusive(envelope.calls);
}

describe('blocking reviewer health (RCL-136)', () => {
  it('17 blocking seats with 11 complete plus one async success is inconclusive and requires 12', () => {
    const value = report([
      ...seats(11, 'blocking', COMPLETE),
      ...seats(6, 'blocking', TIMED_OUT, 'fable'),
      ...seats(1, 'async', ['success']),
    ]);
    expect(aggregateConclusive(value.stats)).toBe(true); // 12/18 looked healthy before.
    const health = deriveBlockingHealth({ roster: value.run.roster, reviews: value.reviews });
    expect(health.policy).toMatchObject({ seatCount: 17, minimumSuccessful: 12 });
    expect(health.successfulSeats).toHaveLength(11);
    expect(health.unsuccessfulSeats.map((seat) => seat.status)).toEqual(Array(6).fill('timeout'));
    expect(health.excludedSuccesses).toEqual({ secondary: 0, async: 1, verification: 0 });
    expect(health.conclusive).toBe(false);
    expect(serverAgrees(value)).toBe(false);
    // Async findings stay in the report; they only do not count for health.
    expect(value.reviews.find((review) => review.async)?.findings).toHaveLength(1);
    expect(value.reviews.find((review) => review.model === 'fable-1')?.error).toMatch(/Incomplete chunk coverage: 2\/4/);
    expect(describeBlockingHealth(health)).toBe(
      'Blocking reviewer health inconclusive: 11/17 blocking seats complete; 12 required; ' +
      'excluded from quorum: 1 async successful; incomplete: ' +
      Array.from({ length: 6 }, (_, index) => `fable-${index + 1}/bug-hunter (timeout)`).join(', ') + '.');
    expect(() => assertAdmissibleReportHealth(value)).toThrow(expect.objectContaining({
      code: 'report_health_inconclusive', message: expect.stringMatching(/11\/17 blocking seats complete; 12 required/),
    }));
  });

  it('10 blocking seats with 6 complete plus four secondary and one async success is inconclusive and requires 7', () => {
    const value = report([
      ...seats(6, 'blocking', ['success', 'success']),
      ...seats(4, 'blocking', ['success', 'canceled'], 'claude'),
      ...seats(4, 'secondary', ['success', 'success']),
      ...seats(1, 'async', ['success']),
    ]);
    expect(aggregateConclusive(value.stats)).toBe(true); // 11/15 looked healthy before.
    const health = deriveBlockingHealth({ roster: value.run.roster, reviews: value.reviews });
    expect(health.policy).toMatchObject({ seatCount: 10, minimumSuccessful: 7 });
    expect(health.successfulSeats).toHaveLength(6);
    expect(health.unsuccessfulSeats.map((seat) => seat.status)).toEqual(Array(4).fill('canceled'));
    expect(health.excludedSuccesses).toEqual({ secondary: 4, async: 1, verification: 0 });
    expect(health.conclusive).toBe(false);
    expect(serverAgrees(value)).toBe(false);
    expect(value.reviews.filter((review) => review.model.startsWith('secondary')).every((review) => review.findings.length === 2)).toBe(true);
  });

  it.each([
    { total: 17, successful: 12 },
    { total: 10, successful: 7 },
    { total: 2, successful: 2 },
  ])('accepts the positive boundary $successful/$total and agrees with the server', ({ total, successful }) => {
    const value = report([
      ...seats(successful, 'blocking', COMPLETE),
      ...seats(total - successful, 'blocking', ['success', 'error', 'success', 'success'], 'failed'),
      ...seats(3, 'secondary', ['error']),
      ...seats(1, 'async', ['timeout']),
    ]);
    const health = assertAdmissibleReportHealth(value);
    expect(health.conclusive).toBe(true);
    expect(health.successfulSeats).toHaveLength(successful);
    expect(health.policy.minimumSuccessful).toBe(successful);
    expect(serverAgrees(value)).toBe(true);
  });

  it('never counts one successful chunk of an incomplete multichunk seat', () => {
    const value = report([
      ...seats(6, 'blocking', ['success', 'success', 'success']),
      ...seats(4, 'blocking', ['success', 'success', 'parse_failed'], 'partial'),
    ]);
    const health = deriveBlockingHealth({ roster: value.run.roster, reviews: value.reviews });
    expect(health.successfulSeats).toHaveLength(6);
    expect(health.unsuccessfulSeats.map((seat) => seat.status)).toEqual(Array(4).fill('parse_failed'));
    expect(health.conclusive).toBe(false);
    expect(serverAgrees(value)).toBe(false);
  });

  it('treats canceled, failed and missing blocking seats as unsuccessful', () => {
    const value = report([
      ...seats(2, 'blocking', ['success']),
      { model: 'canceled', role: 'general', lane: 'blocking', chunks: ['canceled'] },
      { model: 'errored', role: 'general', lane: 'blocking', chunks: ['error'] },
    ]);
    value.run.roster.push({ model: 'missing', role: 'general', provider: 'fake', lane: 'blocking' });
    const health = deriveBlockingHealth({ roster: value.run.roster, reviews: value.reviews });
    expect(health.unsuccessfulSeats).toEqual([
      { model: 'canceled', role: 'general', status: 'canceled' },
      { model: 'errored', role: 'general', status: 'error' },
      { model: 'missing', role: 'general', status: 'missing' },
    ]);
    expect(health.policy).toMatchObject({ seatCount: 5, minimumSuccessful: 4 });
    expect(health.conclusive).toBe(false);
  });

  it('counts a duplicated model/role assignment once and requires all of its calls', () => {
    const duplicate = { model: 'dup', role: 'general', lane: 'blocking' as const };
    const healthy = report([...seats(2, 'blocking', ['success']), { ...duplicate, chunks: ['success'] }, { ...duplicate, chunks: ['success'] }]);
    const broken = report([...seats(2, 'blocking', ['success']), { ...duplicate, chunks: ['success'] }, { ...duplicate, chunks: ['timeout'] }]);
    for (const [value, successful, conclusive] of [[healthy, 3, true], [broken, 2, true]] as const) {
      const health = deriveBlockingHealth({ roster: value.run.roster, reviews: value.reviews });
      expect(health.policy.seatCount).toBe(3);
      expect(health.successfulSeats).toHaveLength(successful);
      expect(health.conclusive).toBe(conclusive);
      expect(serverAgrees(value)).toBe(conclusive);
    }
    expect(deriveBlockingHealth({ roster: broken.run.roster, reviews: broken.reviews }).unsuccessfulSeats)
      .toEqual([{ model: 'dup', role: 'general', status: 'timeout' }]);
  });

  it('never lets an async-only row cover a blocking seat, and counts it as an async success', () => {
    const value = report(seats(3, 'blocking', ['success']));
    value.reviews[2] = { ...value.reviews[2]!, async: true };
    const health = deriveBlockingHealth({ roster: value.run.roster, reviews: value.reviews });
    expect(health.unsuccessfulSeats).toEqual([{ model: 'blocking-3', role: 'bug-hunter', status: 'missing' }]);
    expect(health.excludedSuccesses.async).toBe(1);
    expect(health.successfulSeats).toHaveLength(2);
  });

  it('refuses a synchronous row outside the roster instead of letting it create a seat', () => {
    const value = report([...seats(6, 'blocking', ['success']), ...seats(4, 'blocking', ['timeout'], 'slow')]);
    delete value.stats.blockingHealth;
    const inflated = { ...value, reviews: [...value.reviews, ...[1, 2, 3].map((n) => part(`extra-${n}`, 'general', 'success'))] };
    expect(() => deriveBlockingHealth({ roster: inflated.run.roster, reviews: inflated.reviews })).toThrow(/Unrostered reviewer row/);
    expect(() => assertAdmissibleReportHealth(inflated)).toThrow(expect.objectContaining({ code: 'report_health_unverifiable' }));
    // Unrostered async rows stay async opinions.
    const withAsync = { ...value, reviews: [...value.reviews, part('late-async', 'general', 'success', { async: true })] };
    expect(deriveBlockingHealth({ roster: withAsync.run.roster, reviews: withAsync.reviews }).excludedSuccesses.async).toBe(1);
  });

  it('refuses roster entries with an unknown lane or blank identity instead of dropping seats', () => {
    for (const change of [{ lane: 'blockng' }, { model: '' }, { role: ' ' }]) {
      const value = report([...seats(2, 'blocking', ['success']), ...seats(2, 'blocking', ['timeout'], 'slow')]);
      delete value.stats.blockingHealth;
      value.run.roster = value.run.roster.map((entry) => entry.model.startsWith('slow') ? { ...entry, ...change } as never : entry);
      expect(() => assertAdmissibleReportHealth(value)).toThrow(expect.objectContaining({ code: 'report_health_unverifiable' }));
    }
  });

  it('refuses rows without a model, role or known status', () => {
    for (const row of [{ role: 'general', status: 'success' }, { model: 'm', role: ' ', status: 'success' }, { model: 'm', role: 'r', status: 'done' }]) {
      const value = report(seats(3, 'blocking', ['success']));
      value.reviews.push({ findings: [], durationMs: 1, provider: 'fake', ...row } as never);
      expect(() => assertAdmissibleReportHealth(value)).toThrow(expect.objectContaining({ code: 'report_health_unverifiable' }));
    }
  });

  it('refuses ambiguous duplicate blocking rows instead of counting either one', () => {
    const value = report(seats(3, 'blocking', ['success']));
    value.reviews.push({ ...value.reviews[0]! });
    expect(() => deriveBlockingHealth({ roster: value.run.roster, reviews: value.reviews })).toThrow(/Duplicate blocking reviewer row/);
    expect(() => assertAdmissibleReportHealth(value)).toThrow(expect.objectContaining({ code: 'report_health_unverifiable' }));
  });

  it('preserves a stricter supported quorum while the server keeps its own 2/3 gate', () => {
    for (const [fraction, required] of [[0.8, 14], [1, 17]] as const) {
      const value = report([...seats(12, 'blocking', COMPLETE), ...seats(5, 'blocking', TIMED_OUT, 'slow')], fraction);
      const health = assertAdmissibleReportHealth.bind(null, value);
      expect(health).toThrow(expect.objectContaining({ code: 'report_health_inconclusive',
        message: expect.stringMatching(new RegExp(`12/17 blocking seats complete; ${required} required`)) }));
      expect(value.stats.blockingHealth).toMatchObject({ fraction, seats: 17, required, successful: 12, conclusive: false });
      expect(serverAgrees(value)).toBe(true); // client is stricter, never more lenient
    }
    expect(() => deriveBlockingHealth({ roster: [], reviews: [], fraction: 0.5 })).toThrow(/between 2\/3 and 1/);
  });

  it('never trusts a recorded summary that is more lenient than the rows', () => {
    const value = report([...seats(6, 'blocking', ['success']), ...seats(4, 'blocking', ['timeout'], 'slow')]);
    for (const tampered of [
      { ...value.stats.blockingHealth!, successful: 7, conclusive: true },
      { ...value.stats.blockingHealth!, fraction: 0.5 },
      { ...value.stats.blockingHealth!, fraction: '2/3' },
    ]) {
      expect(() => assertAdmissibleReportHealth({ ...value, stats: { ...value.stats, blockingHealth: tampered as never } }))
        .toThrow(expect.objectContaining({ code: 'report_health_unverifiable' }));
    }
  });

  it('derives the server rule for legacy reports without a summary or roster', () => {
    const legacy = report(seats(3, 'blocking', ['success']));
    delete legacy.stats.blockingHealth;
    const withoutHeader = { reviews: [...legacy.reviews, part('async-model', 'general', 'success', { async: true })], stats: legacy.stats };
    const health = assertAdmissibleReportHealth(withoutHeader as never);
    expect(health.policy).toMatchObject({ fraction: 2 / 3, seatCount: 3, minimumSuccessful: 2 });
    expect(health.excludedSuccesses.async).toBe(1);
    expect(() => assertAdmissibleReportHealth({ findings: [] } as never)).toThrow(ReportHealthError);
  });

  it('is never more lenient than the server across generated councils', () => {
    const statuses: Outcome[] = ['success', 'success', 'success', 'timeout', 'error', 'canceled', 'parse_failed'];
    let seed = 136;
    const next = (bound: number) => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed % bound; };
    for (let trial = 0; trial < 400; trial++) {
      const specs: SeatSpec[] = [];
      for (const lane of ['blocking', 'secondary', 'async'] as const) {
        for (let index = 0; index < next(lane === 'blocking' ? 20 : 6); index++) {
          const chunks = Array.from({ length: 1 + next(3) }, () => statuses[next(statuses.length)]!);
          specs.push({ model: `${lane}-${index}`, role: next(2) ? 'general' : 'bug-hunter', lane, chunks });
        }
      }
      const fraction = [2 / 3, 0.75, 1][next(3)]!;
      const value = report(specs, fraction);
      const health = deriveBlockingHealth({ roster: value.run.roster, reviews: value.reviews, fraction });
      const server = serverAgrees(value);
      if (health.conclusive) expect(server).toBe(true);
      if (fraction === 2 / 3) expect(health.conclusive).toBe(server);
    }
  });
});
