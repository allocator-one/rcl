import { describe, expect, it } from 'vitest';
import {
  MAX_SELECTED_EVENT_RECEIPTS, isStoredEventReceipt, matchesPreparedEventReceipt, readEventReceipts,
  type EventReceipt, type EventReceiptScope, type StoredEventReceipt,
} from '../../src/evidence/event-receipts.js';
import { instant } from '../../src/evidence/original-run/remote.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { fakeFetch } from '../telemetry/fixtures.js';

const ORG = '01a08032-0838-76db-ade3-1990f6e54070';
const RUN = '01a08032-0838-76db-ade3-1990f6e54071';
const ACTOR = '01a08032-0838-76db-ade3-1990f6e54072';
const EVENT = '01a08032-0838-76db-ade3-1990f6e54073';
const OTHER = '01a08032-0838-76db-ade3-1990f6e54074';
const scope: EventReceiptScope = {
  base_url: 'https://harness.example.test', org_id: ORG, run_id: RUN, repo: 'synthetic/recovery', pr_number: 7,
};
const event = {
  id: EVENT, kind: 'finding_identity_corrected', run_id: RUN, converge_target: 'same-target', round: 2, attempt: 3,
  occurred_at: '2026-09-22T10:20:30.123456Z',
  payload: { from_identity: 'old', to_identity: 'new', evidence: ['first', 'second'], retained: null },
};
const prepared = JSON.stringify(event, null, 2) + '\n';
const receipt = (): EventReceipt => ({
  ...structuredClone(event), org_id: ORG, repo: scope.repo, pr_number: scope.pr_number, actor_user_id: ACTOR,
});
const storedReceipt = (): StoredEventReceipt => ({ ...receipt(), sequence: 9, received_at: '2026-09-22T10:20:31.654321Z' });
const body = (rows: unknown[] = [storedReceipt()]) => ({
  data: rows,
  meta: { org_id: ORG, run_id: RUN, claim_recovery_version: 1 },
});
function client(response: unknown, source: 'login' | 'attest' = 'login', status = 200) {
  const { fetch, requests } = fakeFetch(() => ({ status, body: response }));
  const sink = new HarnessSink({
    credential: { url: 'https://harness.example.test', token: 'synthetic-only-token', source },
    rclVersion: '3.8.0', fetchImpl: fetch,
  });
  return { sink, requests };
}

describe('selected recovery event receipts', () => {
  it('reads only selected IDs and reports an absent receipt without writing or claiming its acceptance', async () => {
    const { sink, requests } = client(body());
    expect(await readEventReceipts(sink, scope, [OTHER, EVENT])).toMatchObject({
      kind: 'ok', value: { receipts: [storedReceipt()], missing: [OTHER] },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('GET');
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe(`/api/v1/reviews/runs/${RUN}/events`);
    expect(url.searchParams.get('ids')).toBe(`${OTHER},${EVENT}`);
    expect(requests[0]!.body).toBeUndefined();
  });

  it.each([
    ['missing sequence', { sequence: undefined }], ['null sequence', { sequence: null }],
    ['zero sequence', { sequence: 0 }], ['negative sequence', { sequence: -1 }],
    ['fractional sequence', { sequence: 1.5 }], ['string sequence', { sequence: '9' }],
    ['unsafe sequence', { sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing received_at', { received_at: undefined }], ['null received_at', { received_at: null }],
    ['numeric received_at', { received_at: 1_790_069_631 }],
    ['impossible received_at date', { received_at: '2026-02-30T10:20:31.654321Z' }],
    ['received_at without timezone', { received_at: '2026-09-22T10:20:31.654321' }],
    ['received_at beyond supported precision', { received_at: '2026-09-22T10:20:31.6543217Z' }],
  ])('refuses stored receipt with %s', async (_name, changed) => {
    const { sink, requests } = client(body([{ ...storedReceipt(), ...changed }]));
    expect(await readEventReceipts(sink, scope, [EVENT]))
      .toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    expect(requests.map(request => request.method)).toEqual(['GET']);
  });

  it('preserves server ordering and acceptance microseconds separately from the original event time', async () => {
    const first = { ...storedReceipt(), sequence: Number.MAX_SAFE_INTEGER,
      received_at: '2026-09-22T12:20:31.654321+02:00' };
    const second = { ...storedReceipt(), id: OTHER, sequence: 8, received_at: '2026-09-22T10:20:31.654320Z' };
    const response = body([first, second]); const before = JSON.stringify(response);
    const outcome = await readEventReceipts(client(response).sink, scope, [OTHER, EVENT]);
    expect(outcome).toMatchObject({ kind: 'ok', value: { receipts: [first, second], missing: [] } });
    if (outcome.kind !== 'ok') throw new Error('expected complete stored receipts');
    expect(outcome.value.receipts[0]!.sequence).toBe(Number.MAX_SAFE_INTEGER);
    expect(outcome.value.receipts[0]!.received_at).toBe(first.received_at);
    expect(outcome.value.receipts[0]!.occurred_at).toBe(event.occurred_at);
    expect(instant(first.received_at)).not.toBe(instant(second.received_at));
    expect(JSON.stringify(response)).toBe(before);
  });

  it('requires explicit Mode B capability rather than existing evidence and Mode A signals', async () => {
    const response = body();
    const { sink } = client({ ...response, meta: {
      org_id: ORG, run_id: RUN, evidence_protocol_version: 2,
      bound_classification_protocol: 1, original_report_recovery_version: 1,
    } });
    expect(await readEventReceipts(sink, scope, [EVENT])).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it.each([
    ['wrong organization', () => ({ ...body(), meta: { ...body().meta, org_id: OTHER } })],
    ['wrong run metadata', () => ({ ...body(), meta: { ...body().meta, run_id: OTHER } })],
    ['partial response metadata', () => ({ ...body([]), meta: { ...body().meta, partial: true } })],
    ['paginated response metadata', () => ({ ...body([]), meta: { ...body().meta, next_cursor: 'remaining' } })],
    ['wrong run row', () => body([{ ...storedReceipt(), run_id: OTHER }])],
    ['wrong repository', () => body([{ ...storedReceipt(), repo: 'synthetic/other' }])],
    ['wrong pull request', () => body([{ ...storedReceipt(), pr_number: 8 }])],
    ['duplicate receipt', () => body([storedReceipt(), storedReceipt()])],
    ['unselected receipt', () => body([{ ...storedReceipt(), id: OTHER }])],
    ['incomplete receipt', () => body([{ id: EVENT, payload: event.payload }])],
    ['counter-only acknowledgment', () => ({ ...body(), data: { inserted: 0, duplicates: 1 } })],
  ] as const)('refuses %s', async (_name, response) => {
    expect(await readEventReceipts(client(response()).sink, scope, [EVENT]))
      .toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it.each([
    ['duplicate payload keys', JSON.stringify(body()).replace('"from_identity":"old"', '"from_identity":"conflicting","from_identity":"old"')],
    ['a rounded decimal payload', JSON.stringify(body([{ ...storedReceipt(), payload: { weight: 0.1 } }])).replace('"weight":0.1', '"weight":0.10000000000000001')],
    ['a rounded integer binding', JSON.stringify(body()).replace('"round":2', '"round":2.0000000000000001')],
  ])('refuses raw JSON with %s before accepting receipts', async (_name, raw) => {
    const sink = new HarnessSink({ credential: { url: scope.base_url, token: 'synthetic', source: 'login' },
      rclVersion: '3.8.0', fetchImpl: async () => new Response(raw, { status: 200 }) });
    expect(await readEventReceipts(sink, scope, [EVENT])).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
  });

  it('refuses invalid or oversized selection and run-bound recovery credentials before HTTP', async () => {
    const ordinary = client(body());
    for (const ids of [[], [EVENT, EVENT], ['../other'], Array.from({ length: MAX_SELECTED_EVENT_RECEIPTS + 1 }, (_, i) =>
      `01a08032-0838-76db-ade3-${String(i).padStart(12, '0')}`)]) {
      await expect(readEventReceipts(ordinary.sink, scope, ids)).rejects.toThrow('invalid_event_receipt_selection');
    }
    await expect(readEventReceipts(ordinary.sink, { ...scope, run_id: '../other' }, [EVENT]))
      .rejects.toThrow('invalid_event_receipt_selection');
    expect(ordinary.requests).toHaveLength(0);
    const attested = client(body(), 'attest');
    await expect(readEventReceipts(attested.sink, scope, [EVENT])).rejects.toThrow('unsupported_attested_recovery');
    expect(attested.requests).toHaveLength(0);
  });

  it('does not treat a missing run or an HTTP failure as a list of missing event IDs', async () => {
    expect(await readEventReceipts(client({ error: 'not_found' }, 'login', 404).sink, scope, [EVENT]))
      .toMatchObject({ kind: 'rejected', httpStatus: 404 });
    expect(await readEventReceipts(client({ error: 'server_error' }, 'login', 503).sink, scope, [EVENT]))
      .toMatchObject({ kind: 'unavailable' });
  });

  it.each([
    ['partial content with a matching row', 206, body()],
    ['partial content missing a selected row', 206, body([])],
    ['successful response carrying an error', 200, { ...body(), error: 'query_incomplete' }],
    ['successful response carrying an error list', 200, { ...body([]), errors: ['query_incomplete'] }],
  ] as const)('refuses %s instead of acknowledging or reporting absence', async (_name, status, response) => {
    const { sink, requests } = client(response, 'login', status);
    expect(await readEventReceipts(sink, scope, [EVENT])).toMatchObject({ kind: 'rejected', error: 'malformed_response' });
    expect(requests.map(request => request.method)).toEqual(['GET']);
  });

  it('refuses a changed credential destination before querying its event IDs', async () => {
    const { sink, requests } = client(body());
    await expect(readEventReceipts(sink, { ...scope, base_url: 'https://other.example.test' }, [EVENT]))
      .rejects.toThrow('event_receipt_destination_conflict');
    expect(requests).toHaveLength(0);
  });

  it('rejects a null scope before HTTP', async () => {
    const { sink, requests } = client(body());
    await expect(readEventReceipts(sink, null as unknown as EventReceiptScope, [EVENT]))
      .rejects.toThrow('invalid_event_receipt_selection');
    expect(requests).toHaveLength(0);
  });

  it('pins selected scope and IDs while the receipt read is pending', async () => {
    const selectedScope = structuredClone(scope);
    const ids = [EVENT];
    const requests: string[] = [];
    let resolveResponse!: (response: Response) => void;
    const sink = new HarnessSink({
      credential: { url: scope.base_url, token: 'synthetic-only-token', source: 'login' },
      rclVersion: '3.8.0',
      fetchImpl: async input => {
        requests.push(String(input));
        return new Promise<Response>(resolve => { resolveResponse = resolve; });
      },
    });

    const pending = readEventReceipts(sink, selectedScope, ids);
    await Promise.resolve();
    selectedScope.run_id = OTHER;
    selectedScope.org_id = OTHER;
    ids[0] = OTHER;
    resolveResponse(Response.json(body()));

    await expect(pending).resolves.toMatchObject({ kind: 'ok', value: { receipts: [storedReceipt()], missing: [] } });
    expect(new URL(requests[0]!).pathname).toBe(`/api/v1/reviews/runs/${RUN}/events`);
    expect(new URL(requests[0]!).searchParams.get('ids')).toBe(EVENT);
  });
});

describe('prepared event receipt equality', () => {
  it('matches the prepared assertion without inventing server acceptance metadata', () => {
    const actual = receipt(); const before = structuredClone(actual);
    expect(matchesPreparedEventReceipt(actual, prepared, scope, ACTOR)).toBe(true);
    expect(isStoredEventReceipt(actual, scope)).toBe(false);
    expect(isStoredEventReceipt(storedReceipt(), scope)).toBe(true);
    expect(actual).toEqual(before);
    expect(actual).not.toHaveProperty('sequence');
    expect(actual).not.toHaveProperty('received_at');
  });

  it('accepts normalized object ordering and equivalent microsecond instants without changing prepared bytes', () => {
    const actual = receipt();
    actual.occurred_at = '2026-09-22T12:20:30.123456+02:00';
    actual.payload = { retained: null, evidence: ['first', 'second'], to_identity: 'new', from_identity: 'old' };
    const before = JSON.stringify(actual);
    expect(matchesPreparedEventReceipt(actual, prepared, scope, ACTOR)).toBe(true);
    expect(JSON.stringify(actual)).toBe(before);
    expect(prepared).toBe(JSON.stringify(event, null, 2) + '\n');
  });

  it.each([
    ['event identity', { id: OTHER }], ['actor', { actor_user_id: OTHER }],
    ['organization', { org_id: OTHER }], ['run', { run_id: OTHER }],
    ['repository', { repo: 'synthetic/other' }], ['pull request', { pr_number: 8 }],
    ['target', { converge_target: 'other-target' }], ['round', { round: 3 }],
    ['attempt', { attempt: 4 }], ['kind', { kind: 'resolution' }],
    ['one microsecond', { occurred_at: '2026-09-22T10:20:30.123457Z' }],
    ['unknown original actor', { actor_user_id: null }],
  ] as const)('does not acknowledge changed %s', (_name, changed) => {
    expect(matchesPreparedEventReceipt({ ...receipt(), ...changed }, prepared, scope, ACTOR)).toBe(false);
  });

  it('distinguishes absent payload fields, explicit nulls and array ordering', () => {
    const absent = receipt(); delete absent.payload.retained;
    expect(matchesPreparedEventReceipt(absent, prepared, scope, ACTOR)).toBe(false);
    const reordered = receipt(); reordered.payload.evidence = ['second', 'first'];
    expect(matchesPreparedEventReceipt(reordered, prepared, scope, ACTOR)).toBe(false);
    const extra = receipt(); extra.payload.additional = null;
    expect(matchesPreparedEventReceipt(extra, prepared, scope, ACTOR)).toBe(false);
  });

  it('compares absent optional wire fields only to explicit server nulls and never invents actor identity', () => {
    const { attempt: _attempt, ...withoutAttempt } = event;
    const actual = { ...receipt(), attempt: null };
    expect(matchesPreparedEventReceipt(actual, JSON.stringify(withoutAttempt), scope, ACTOR)).toBe(true);
    const missingField = { ...actual } as Partial<EventReceipt>; delete missingField.attempt;
    expect(matchesPreparedEventReceipt(missingField, JSON.stringify(withoutAttempt), scope, ACTOR)).toBe(false);
    expect(matchesPreparedEventReceipt(actual, JSON.stringify(withoutAttempt), scope, '')).toBe(false);
  });

  it('rejects ambiguous prepared JSON and invalid calendar timestamps rather than normalizing them into agreement', () => {
    const duplicate = prepared.replace('"id":', `"id": "${OTHER}", "id":`);
    expect(matchesPreparedEventReceipt(receipt(), duplicate, scope, ACTOR)).toBe(false);
    const unknown = JSON.stringify({ ...event, unsupported: true });
    expect(matchesPreparedEventReceipt(receipt(), unknown, scope, ACTOR)).toBe(false);
    const invalidDate = { ...event, occurred_at: '2026-02-30T10:20:30.123456Z' };
    const normalized = { ...receipt(), occurred_at: '2026-03-02T10:20:30.123456Z' };
    expect(matchesPreparedEventReceipt(normalized, JSON.stringify(invalidDate), scope, ACTOR)).toBe(false);
    expect(() => instant(invalidDate.occurred_at)).toThrow('invalid_receipt_timestamp');
  });

  it('refuses prepared numeric values whose exact decimal meaning would be rounded away', () => {
    expect(matchesPreparedEventReceipt(receipt(), prepared.replace('"round": 2', '"round": 2.0000000000000001'), scope, ACTOR)).toBe(false);
    const actual = { ...receipt(), payload: { weight: 0.1 } };
    const raw = JSON.stringify({ ...event, payload: actual.payload });
    expect(matchesPreparedEventReceipt(actual, raw.replace('"weight":0.1', '"weight":0.10000000000000001'), scope, ACTOR)).toBe(false);
    expect(matchesPreparedEventReceipt(actual, raw.replace('"weight":0.1', '"weight":1.00e-1'), scope, ACTOR)).toBe(true);
  });
});
