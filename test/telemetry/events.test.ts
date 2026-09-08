import { describe, expect, it } from 'vitest';
import { buildEvent, deliverable } from '../../src/telemetry/events.js';

describe('buildEvent', () => {
  it('mints a UUIDv7 id and an ISO timestamp, and scrubs the payload', () => {
    const now = new Date('2026-09-07T09:00:00.000Z');
    const event = buildEvent({
      kind: 'round_processed',
      convergeTarget: 'allocator-one-8492',
      round: 3,
      runId: '019921a0-0000-7000-8000-000000000001',
      payload: { note: 'token sk-ant-abcdefghijklmnopqrstuvwxyz here', counts: { new: 2 } },
      now,
    });
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(event.occurred_at).toBe('2026-09-07T09:00:00.000Z');
    expect(event).toMatchObject({ kind: 'round_processed', converge_target: 'allocator-one-8492', round: 3, run_id: '019921a0-0000-7000-8000-000000000001' });
    expect(event.payload).toEqual({ note: 'token [redacted] here', counts: { new: 2 } });
  });

  it('keeps ids stable: the same event object re-sent carries the same id', () => {
    const event = buildEvent({ kind: 'attempt_claimed', attempt: 1 });
    const copy = JSON.parse(JSON.stringify(event));
    expect(copy.id).toBe(event.id);
    expect(buildEvent({ kind: 'attempt_claimed', attempt: 1 }).id).not.toBe(event.id);
  });
});

describe('buildEvent scrubbing', () => {
  it('passes the converge target through the key scrubber', () => {
    const event = buildEvent({ kind: 'attempt_claimed', convergeTarget: `repo-ghp_${'A'.repeat(30)}`, attempt: 1 });
    expect(event.converge_target).toBe('repo-[redacted]');
    expect(buildEvent({ kind: 'attempt_claimed', convergeTarget: 'allocator-one-8503', attempt: 1 }).converge_target).toBe('allocator-one-8503');
  });
});

describe('deliverable', () => {
  it('refuses a run id that is not a UUID', () => {
    const bad = buildEvent({ kind: 'round_processed', convergeTarget: 't', round: 1, runId: 'not-a-uuid', payload: {} });
    expect(deliverable(bad)).toBe(false);
    const good = buildEvent({ kind: 'round_processed', convergeTarget: 't', round: 1, runId: '019921a0-0000-7000-8000-000000000001', payload: {} });
    expect(deliverable(good)).toBe(true);
  });

  it('requires run_id and round for round-bound kinds, attempt for a claim, nothing for loss', () => {
    expect(deliverable(buildEvent({ kind: 'verdicts_recorded', round: 1, runId: '019921a0-0000-7000-8000-000000000001' }))).toBe(true);
    expect(deliverable(buildEvent({ kind: 'verdicts_recorded', round: 1 }))).toBe(false);
    expect(deliverable(buildEvent({ kind: 'resolution', runId: '019921a0-0000-7000-8000-000000000001' }))).toBe(false);
    expect(deliverable(buildEvent({ kind: 'attempt_claimed', attempt: 2 }))).toBe(true);
    expect(deliverable(buildEvent({ kind: 'attempt_claimed' }))).toBe(false);
    expect(deliverable(buildEvent({ kind: 'cap_changed' }))).toBe(true);
    expect(deliverable(buildEvent({ kind: 'loss' }))).toBe(true);
  });

  it('refuses counters that are not positive integers', () => {
    expect(deliverable(buildEvent({ kind: 'attempt_claimed', attempt: Number.NaN }))).toBe(false);
    expect(deliverable(buildEvent({ kind: 'attempt_claimed', attempt: 0 }))).toBe(false);
    expect(deliverable(buildEvent({ kind: 'round_processed', round: 1.5, runId: '019921a0-0000-7000-8000-000000000001' }))).toBe(false);
    expect(deliverable(buildEvent({ kind: 'round_processed', round: 0, runId: '019921a0-0000-7000-8000-000000000001' }))).toBe(false);
    expect(deliverable(buildEvent({ kind: 'round_processed', round: 2, runId: '019921a0-0000-7000-8000-000000000001' }))).toBe(true);
    expect(deliverable(buildEvent({ kind: 'round_processed', round: 2, runId: '' }))).toBe(false);
  });
});
