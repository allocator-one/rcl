import { describe, expect, it } from 'vitest';
import { authenticatedReceiptContent, verifyAuthenticatedSelectedReceipts, type AuthenticatedReceiptSelection } from '../../src/evidence/claim-recovery/authenticated-receipts.js';
import type { StoredEventReceipt } from '../../src/evidence/event-receipts.js';
import { HarnessSink } from '../../src/telemetry/sink.js';

const uuid = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const selection = { scope: { base_url: 'https://synthetic.example.test', org_id: uuid(1), run_id: uuid(2), repo: 'synthetic/recovery', pr_number: 7 },
  target: 'same-target', round: 2, reportSha256: 'a'.repeat(64), headSha: 'b'.repeat(40) };
const receipt = (n: number): StoredEventReceipt => ({ id: uuid(100 + n), org_id: selection.scope.org_id, run_id: selection.scope.run_id,
  repo: selection.scope.repo, pr_number: selection.scope.pr_number, actor_user_id: uuid(3), kind: 'finding_identity_corrected',
  converge_target: selection.target, round: 2, attempt: 3, occurred_at: '2026-09-23T10:20:30.123456Z',
  received_at: `2026-09-23T10:20:31.${String(100000 + n).slice(-6)}Z`, sequence: n + 1, payload: { from_identity: 'old', to_identity: `new-${n}` } });
const context = (sequence = 9, actor = uuid(3)) => ({ data: { id: selection.scope.run_id, target: { kind: 'pr', repo: selection.scope.repo,
  pr_number: selection.scope.pr_number, head_sha: selection.headSha }, converge: { target: selection.target, round: selection.round },
  artifacts: [{ kind: 'report_json', declared_sha256: selection.reportSha256, stored: true }] },
  meta: { org_id: selection.scope.org_id, actor_user_id: actor, evidence_protocol_version: 2, claim_recovery_version: 1,
    recovery: { event_sequence: sequence, truncated: false } } });
function input(rows: StoredEventReceipt[]): AuthenticatedReceiptSelection {
  return { selection: structuredClone(selection), expectedReceipts: rows, readRequirements: Array.from({ length: Math.ceil(rows.length / 50) }, (_, index) => ({
    kind: 'selected-event-receipts' as const, scope: selection.scope, eventIds: rows.slice(index * 50, index * 50 + 50).map(row => row.id) })) };
}
function sink(responses: unknown[]) {
  const calls: Array<{ method: string; url: string }> = [];
  const client = new HarnessSink({ credential: { url: selection.scope.base_url, token: 'ordinary', source: 'login' }, rclVersion: 'test',
    fetchImpl: async (url, init) => { calls.push({ method: init?.method ?? 'GET', url: String(url) }); return Response.json(responses.shift(), { status: 200 }); } });
  return { client, calls };
}

describe('authenticated selected receipt verification', () => {
  it('binds exact receipt bytes to stable authenticated source context in bounded selected batches', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => receipt(index + 1));
    const { client, calls } = sink([context(100), { data: rows.slice(0, 50), meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } },
      { data: rows.slice(50), meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } }, context(100)]);
    const result = await verifyAuthenticatedSelectedReceipts(client, uuid(3), [input(rows)]);
    expect(result.kind).toBe('verified');
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET', 'GET']);
    expect(calls.filter(call => new URL(call.url).pathname.endsWith('/events')).every(call =>
      new URL(call.url).searchParams.get('ids')!.split(',').length <= 50)).toBe(true);
  });

  it.each([
    ['missing selected receipt', [context(), { data: [], meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } }], 'conflict', 'selected_receipt_missing'],
    ['changed stored receipt', [context(), { data: [{ ...receipt(1), payload: { from_identity: 'changed' } }], meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } }], 'conflict', 'selected_receipt_mismatch'],
    ['partial selected response', [context(), { data: [receipt(1)], meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 }, partial: true }], 'unknown', 'selected_receipt_read_unavailable'],
  ] as const)('keeps %s unknown or conflicting rather than authenticating it', async (_name, responses, kind, reason) => {
    const result = await verifyAuthenticatedSelectedReceipts(sink([...responses]).client, uuid(3), [input([receipt(1)])]);
    expect(result).toMatchObject({ kind, reason });
  });

  it.each([
    ['actor', context(9, uuid(4)), 'authenticated_actor_changed'],
    ['event sequence', context(10), 'source_event_sequence_changed'],
  ] as const)('refuses a changed %s after selected reads', async (_name, later, reason) => {
    const row = receipt(1); const result = await verifyAuthenticatedSelectedReceipts(sink([context(),
      { data: [row], meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } }, later]).client, uuid(3), [input([row])]);
    expect(result).toMatchObject({ kind: 'conflict', reason });
  });

  it('pins the explicit ordinary actor before material reads', async () => {
    const { client, calls } = sink([context(9, uuid(4))]);
    expect(await verifyAuthenticatedSelectedReceipts(client, uuid(3), [input([receipt(1)])]))
      .toMatchObject({ kind: 'conflict', reason: 'authenticated_actor_changed' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a cross-operation source set before any read', async () => {
    const { client, calls } = sink([]); const second = input([receipt(1)]); second.selection.target = 'other-target';
    await expect(verifyAuthenticatedSelectedReceipts(client, uuid(3), [input([receipt(1)]), second]))
      .rejects.toThrow('authenticated_receipt_operation_conflict');
    expect(calls).toEqual([]);
  });

  it('pins mutable caller selections before the first context read', async () => {
    const row = receipt(1); const candidate = input([row]); const calls: string[] = [];
    const client = new HarnessSink({ credential: { url: selection.scope.base_url, token: 'ordinary', source: 'login' }, rclVersion: 'test',
      fetchImpl: async url => {
        calls.push(String(url));
        if (calls.length === 1) candidate.selection.scope.run_id = uuid(99);
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/events')) return Response.json({ data: [row], meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } });
        return Response.json(context());
      } });
    expect((await verifyAuthenticatedSelectedReceipts(client, uuid(3), [candidate])).kind).toBe('verified');
    expect(calls.every(url => !url.includes(uuid(99)))).toBe(true);
  });

  it('reads every initial source context before any material read and pins one operation actor', async () => {
    const second = structuredClone(selection); second.scope.run_id = uuid(20); const row = { ...receipt(2), id: uuid(201), run_id: second.scope.run_id };
    const secondInput: AuthenticatedReceiptSelection = { selection: second, expectedReceipts: [row], readRequirements: [{ kind: 'selected-event-receipts', scope: second.scope, eventIds: [row.id] }] };
    const paths: string[] = []; const client = new HarnessSink({ credential: { url: selection.scope.base_url, token: 'ordinary', source: 'login' }, rclVersion: 'test',
      fetchImpl: async url => { const parsed = new URL(String(url)); paths.push(parsed.pathname); const run = parsed.pathname.split('/')[5];
        if (parsed.pathname.endsWith('/events')) return Response.json({ data: run === second.scope.run_id ? [row] : [receipt(1)], meta: { org_id: selection.scope.org_id, run_id: run, claim_recovery_version: 1 } });
        const selected = run === second.scope.run_id ? second : selection;
        return Response.json({ ...context(), data: { ...context().data, id: selected.scope.run_id, target: { ...context().data.target }, converge: { ...context().data.converge }, artifacts: [{ kind: 'report_json', declared_sha256: selected.reportSha256, stored: true }] } });
      } });
    expect((await verifyAuthenticatedSelectedReceipts(client, uuid(3), [input([receipt(1)]), secondInput])).kind).toBe('verified');
    expect(paths.slice(0, 2).every(path => !path.endsWith('/events'))).toBe(true);
  });

  it('rejects receipt sequences beyond the initial source sequence before event reads', async () => {
    const row = { ...receipt(1), sequence: 10 }; const { client, calls } = sink([context(9)]);
    expect(await verifyAuthenticatedSelectedReceipts(client, uuid(3), [input([row])]))
      .toMatchObject({ kind: 'conflict', reason: 'selected_receipt_sequence_conflict' });
    expect(calls).toHaveLength(1);
  });

  it('accepts one arbitrary-length native requirement by batching only at the network boundary', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => receipt(index + 1)); const candidate = input(rows);
    candidate.readRequirements = [{ kind: 'selected-event-receipts', scope: selection.scope, eventIds: rows.map(row => row.id) }];
    const result = await verifyAuthenticatedSelectedReceipts(sink([context(100), { data: rows.slice(0, 50), meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } },
      { data: rows.slice(50), meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } }, context(100)]).client, uuid(3), [candidate]);
    expect(result.kind).toBe('verified');
  });

  it('rejects forged or serialized verification values and protects returned content', async () => {
    const row = receipt(1); const result = await verifyAuthenticatedSelectedReceipts(sink([context(),
      { data: [row], meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } }, context()]).client, uuid(3), [input([row])]);
    if (result.kind !== 'verified') throw new Error(JSON.stringify(result));
    expect(() => authenticatedReceiptContent(JSON.parse(JSON.stringify(result.value)))).toThrow('unverified_authenticated_receipts');
    const content = authenticatedReceiptContent(result.value); content.selections[0]!.eventIds.length = 0;
    expect(authenticatedReceiptContent(result.value).selections[0]!.eventIds).toEqual([row.id]);
  });

  it('retains exact original selections and receipt payloads after caller mutation', async () => {
    const row = receipt(1); const candidate = input([row]); const result = await verifyAuthenticatedSelectedReceipts(sink([context(),
      { data: [row], meta: { org_id: selection.scope.org_id, run_id: selection.scope.run_id, claim_recovery_version: 1 } }, context()]).client, uuid(3), [candidate]);
    if (result.kind !== 'verified') throw new Error(JSON.stringify(result));
    candidate.selection.target = 'other-target'; candidate.expectedReceipts[0]!.payload.from_identity = 'mutated';
    const retained = authenticatedReceiptContent(result.value).selections[0]!;
    expect(retained.selection.target).toBe(selection.target);
    expect(retained.receipts[0]!.payload).toEqual({ from_identity: 'old', to_identity: 'new-1' });
  });

  it('rejects mismatched requirement scope before any read', async () => {
    const { client, calls } = sink([]); const row = receipt(1); const invalid = input([row]);
    invalid.readRequirements = [{ ...invalid.readRequirements[0]!, scope: { ...selection.scope, run_id: uuid(8) } }];
    await expect(verifyAuthenticatedSelectedReceipts(client, uuid(3), [invalid])).rejects.toThrow('invalid_authenticated_receipt_selection');
    expect(calls).toEqual([]);
  });
});

describe('authenticated receipt operation consistency', () => {
  it('accepts mixed repository spelling across distinct source runs in one operation', async () => {
    const second = structuredClone(selection); second.scope.run_id = uuid(20); second.scope.repo = 'SYNTHETIC/RECOVERY';
    const row = { ...receipt(2), id: uuid(202), run_id: second.scope.run_id, repo: second.scope.repo };
    const secondInput: AuthenticatedReceiptSelection = { selection: second, expectedReceipts: [row], readRequirements: [{ kind: 'selected-event-receipts', scope: second.scope, eventIds: [row.id] }] };
    const paths: string[] = [];
    const client = new HarnessSink({ credential: { url: selection.scope.base_url, token: 'ordinary', source: 'login' }, rclVersion: 'test',
      fetchImpl: async url => { const parsed = new URL(String(url)); paths.push(parsed.pathname); const run = parsed.pathname.split('/')[5];
        if (parsed.pathname.endsWith('/events')) return Response.json({ data: run === second.scope.run_id ? [row] : [receipt(1)], meta: { org_id: selection.scope.org_id, run_id: run, claim_recovery_version: 1 } });
        const selected = run === second.scope.run_id ? second : selection;
        return Response.json({ ...context(), data: { ...context().data, id: selected.scope.run_id, target: { ...context().data.target, repo: selected.scope.repo }, converge: { ...context().data.converge }, artifacts: [{ kind: 'report_json', declared_sha256: selected.reportSha256, stored: true }] } });
      } });
    expect((await verifyAuthenticatedSelectedReceipts(client, uuid(3), [input([receipt(1)]), secondInput])).kind).toBe('verified');
    expect(paths).toHaveLength(6);
  });

  it('rejects one event UUID across different source runs before reads', async () => {
    const second = structuredClone(selection); second.scope.run_id = uuid(20);
    const conflicting = { ...receipt(1), run_id: second.scope.run_id };
    const other: AuthenticatedReceiptSelection = { selection: second, expectedReceipts: [conflicting], readRequirements: [{ kind: 'selected-event-receipts', scope: second.scope, eventIds: [conflicting.id] }] };
    const { client, calls } = sink([]);
    await expect(verifyAuthenticatedSelectedReceipts(client, uuid(3), [input([receipt(1)]), other])).rejects.toThrow('authenticated_receipt_event_scope_conflict');
    expect(calls).toEqual([]);
  });

  it('rejects different selected IDs at one source sequence before reads', async () => {
    const first = receipt(1); const second = { ...receipt(2), sequence: first.sequence };
    const { client, calls } = sink([]);
    await expect(verifyAuthenticatedSelectedReceipts(client, uuid(3), [input([first, second])])).rejects.toThrow('authenticated_receipt_sequence_conflict');
    expect(calls).toEqual([]);
  });

  it('rejects repeated source runs with conflicting original bindings before reads', async () => {
    const other = input([receipt(1)]); other.selection.reportSha256 = 'c'.repeat(64);
    const { client, calls } = sink([]);
    await expect(verifyAuthenticatedSelectedReceipts(client, uuid(3), [input([receipt(1)]), other])).rejects.toThrow('duplicate_authenticated_receipt_selection');
    expect(calls).toEqual([]);
  });
});
