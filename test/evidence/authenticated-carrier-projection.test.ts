import { describe, expect, it } from 'vitest';
import { readCarrierInventory } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { verifyAuthenticatedSelectedReceipts } from '../../src/evidence/claim-recovery/authenticated-receipts.js';
import { authenticatedCarrierProjectionContent, projectAuthenticatedCarrier } from '../../src/evidence/claim-recovery/authenticated-carrier-projection.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { accepted, inventory, projectionFixture, roundInput } from './recovery-validation/carrier-fixtures.js';
import { uuid } from './recovery-validation/fixtures.js';

function fixture(legacy = true, actor = uuid(900), eventSequence = 5) {
  const { input, projection } = projectionFixture(legacy); const scope = projection.carrier.scope;
  const sources = structuredClone(projection.sources); const extras: any[] = [];
  const calls: string[] = []; const counts = new Map<string, number>();
  let mutate: (body: any, url: URL, visit: number) => unknown = body => body;
  let status: (url: URL) => number = () => 200;
  const sink = new HarnessSink({ credential: { url: scope.base_url, token: 'synthetic-only', source: 'login' },
    rclVersion: 'test', fetchImpl: async (input, request) => {
      expect(request?.method ?? 'GET').toBe('GET');
      const url = new URL(String(input)); calls.push(url.pathname + url.search);
      const visit = (counts.get(url.pathname) ?? 0) + 1; counts.set(url.pathname, visit);
      const parts = url.pathname.split('/'); const source = sources.find(s => s.selector.scope.run_id === parts[5]);
      if (url.pathname.endsWith('/artifacts/report_json')) {
        const report = source!.reportJson!;
        return new Response(report, { status: status(url), headers: { 'x-artifact-sha256': source!.selector.reportSha256 } });
      }
      let body: any;
      if (url.pathname === '/api/v1/reviews/runs') {
        const rows = sources.map(s => ({ id: s.selector.scope.run_id, target: structuredClone(s.storedRun!.target),
          converge: structuredClone(s.storedRun!.converge) }));
        const page = Number(url.searchParams.get('page'));
        body = { data: rows.slice((page - 1) * 100, page * 100), meta: { org_id: scope.org_id, evidence_protocol_version: 2, page, page_size: 100,
          total: rows.length, total_pages: Math.ceil(rows.length / 100) } };
      } else if (url.pathname.endsWith('/events')) {
        const ids = url.searchParams.get('ids')!.split(',');
        body = { data: [...source!.classifications!, ...source!.corrections!, ...extras].filter(r => ids.includes(r.id)),
          meta: { org_id: scope.org_id, run_id: source!.selector.scope.run_id, claim_recovery_version: 1 } };
      } else {
        const classification = source!.classifications![0];
        body = { data: structuredClone(source!.storedRun), meta: { org_id: scope.org_id, evidence_protocol_version: 2,
          claim_recovery_version: 1, actor_user_id: actor, recovery: { event_sequence: eventSequence, truncated: false,
            classification_event: classification ? { id: classification.id, round: classification.round,
              sequence: classification.sequence, identities: classification.payload.identities } : null,
            native_corrections: source!.corrections!.map(r => ({ id: r.id, sequence: r.sequence })) } } };
      }
      return Response.json(mutate(structuredClone(body), url, visit), { status: status(url) });
    } });
  return { input, projection, sources, extras, sink, actor, calls, change: (fn: typeof mutate) => { mutate = fn; },
    status: (fn: typeof status) => { status = fn; } };
}


async function liveTokens(f: ReturnType<typeof fixture>, extra: any[] = []) {
  const inventory = await readCarrierInventory(f.sink, f.projection.carrier, f.actor);
  if (inventory.kind !== 'ok') throw new Error(JSON.stringify(inventory));
  const selections = f.sources.map(source => {
    const rows = [...source.classifications!, ...source.corrections!, ...f.extras, ...extra]
      .filter(receipt => receipt.run_id === source.selector.scope.run_id);
    return { selection: source.selector, expectedReceipts: rows,
      readRequirements: [{ kind: 'selected-event-receipts' as const, scope: source.selector.scope,
        eventIds: rows.map(receipt => receipt.id) }] };
  });
  const receipts = await verifyAuthenticatedSelectedReceipts(f.sink, f.actor, selections);
  if (receipts.kind !== 'verified') throw new Error(JSON.stringify(receipts));
  return { inventory: inventory.value, receipts: receipts.value };
}

function retainTransferEvidence(f: ReturnType<typeof fixture>, transfer: ReturnType<typeof accepted>) {
  const evidence = [transfer.receipt, transfer.preparation.split.receipt,
    transfer.preparation.split.source.classification, ...transfer.preparation.split.source.corrections,
    transfer.preparation.carrier.classification, ...transfer.preparation.carrier.corrections];
  const existing = new Set(f.sources.flatMap(source => source.classifications!.concat(source.corrections!).map(receipt => receipt.id)));
  f.extras.push(...evidence.filter(receipt => !existing.has(receipt.id)));
}

describe('authenticated carrier projection', () => {
  it('projects one live authenticated carrier and preserves residuals without standing', async () => {
    const f = fixture(false); const tokens = await liveTokens(f);
    const result = projectAuthenticatedCarrier(tokens.inventory, tokens.receipts);
    expect(result.kind).toBe('authenticated');
    if (result.kind !== 'authenticated') throw new Error(result.reason);
    const content = authenticatedCarrierProjectionContent(result.value);
    expect(content.projection.qualification).toBe('supplied-inventory-content-only');
    expect(content.projection.residuals.some(row => row.reason === 'untransferred-occurrence')).toBe(true);
    expect(content.projection).not.toHaveProperty('approved');
  });

  it('rejects forged or actor-mismatched opaque tokens', async () => {
    const f = fixture(false); const tokens = await liveTokens(f);
    expect(projectAuthenticatedCarrier({ qualification: 'authenticated-carrier-inventory-read' } as any, tokens.receipts))
      .toMatchObject({ kind: 'conflict' });
    expect(projectAuthenticatedCarrier(tokens.inventory, JSON.parse(JSON.stringify(tokens.receipts))))
      .toMatchObject({ kind: 'conflict' });
    const f2 = fixture(false, uuid(901)); const other = await liveTokens(f2);
    expect(projectAuthenticatedCarrier(tokens.inventory, other.receipts)).toMatchObject({ kind: 'conflict' });
  });

  it('projects an authenticated unavailable artifact as a residual without requiring an empty selected-read token', async () => {
    const f = fixture(false); f.change((body, url) => {
      if (body.meta.recovery) body.data.artifacts[0].stored = false;
      if (url.pathname.endsWith('/events')) body.data = [];
      return body;
    });
    const inventory = await readCarrierInventory(f.sink, f.projection.carrier, f.actor);
    if (inventory.kind !== 'ok') throw new Error(JSON.stringify(inventory));
    const result = projectAuthenticatedCarrier(inventory.value, undefined);
    expect(result.kind).toBe('authenticated');
    if (result.kind !== 'authenticated') throw new Error(result.reason);
    expect(authenticatedCarrierProjectionContent(result.value).projection.residuals)
      .toContainEqual(expect.objectContaining({ reason: 'artifact-unavailable' }));
  });

  it('returns a defensive projection clone', async () => {
    const f = fixture(false); const tokens = await liveTokens(f);
    const result = projectAuthenticatedCarrier(tokens.inventory, tokens.receipts);
    if (result.kind !== 'authenticated') throw new Error(result.reason);
    const copy = authenticatedCarrierProjectionContent(result.value); copy.projection.residuals.length = 0;
    expect(authenticatedCarrierProjectionContent(result.value).projection.residuals.length).toBeGreaterThan(0);
  });

  it('retains a legitimate transfer only when its exact selected receipts authenticate it', async () => {
    const f = fixture(true, uuid(900), 30); const transfer = accepted(f.input);
    retainTransferEvidence(f, transfer);
    // `extras` is the server's additional event store. Passing `evidence` here
    // as well would ask the selected-read boundary for duplicate UUIDs.
    const tokens = await liveTokens(f);
    const result = projectAuthenticatedCarrier(tokens.inventory, tokens.receipts, { transfers: [transfer] });
    if (result.kind !== 'authenticated') throw new Error(JSON.stringify(result));
    expect(authenticatedCarrierProjectionContent(result.value).projection.transfers).toHaveLength(1);
    const tampered = structuredClone(transfer); tampered.receipt.payload = { changed: true };
    expect(projectAuthenticatedCarrier(tokens.inventory, tokens.receipts, { transfers: [tampered] }))
      .toMatchObject({ kind: 'conflict', reason: 'receipt_not_authenticated' });
    const crossSource = structuredClone(transfer);
    crossSource.preparation.split.source.scope.run_id = uuid(777);
    expect(projectAuthenticatedCarrier(tokens.inventory, tokens.receipts, { transfers: [crossSource] }))
      .toMatchObject({ kind: 'conflict' });
  });

  it('reopens a residual for an authenticated earlier source while retaining its prior authenticated transfer', async () => {
    const first = fixture(true, uuid(900), 30); const transfer = accepted(first.input); retainTransferEvidence(first, transfer);
    const firstTokens = await liveTokens(first);
    const initial = projectAuthenticatedCarrier(firstTokens.inventory, firstTokens.receipts, { transfers: [transfer] });
    if (initial.kind !== 'authenticated') throw new Error(JSON.stringify(initial));
    expect(authenticatedCarrierProjectionContent(initial.value).projection.transfers).toHaveLength(1);

    const later = fixture(true, uuid(900), 30); const repeatedTransfer = accepted(later.input); retainTransferEvidence(later, repeatedTransfer);
    later.sources.push(inventory(roundInput(2).split.source));
    const laterTokens = await liveTokens(later);
    const reopened = projectAuthenticatedCarrier(laterTokens.inventory, laterTokens.receipts, { transfers: [repeatedTransfer] });
    if (reopened.kind !== 'authenticated') throw new Error(JSON.stringify(reopened));
    const projection = authenticatedCarrierProjectionContent(reopened.value).projection;
    expect(projection.transfers).toHaveLength(1);
    expect(projection.transfers[0]!.eventId).toBe(repeatedTransfer.receipt.id);
    expect(projection.residuals).toContainEqual(expect.objectContaining({
      reason: 'untransferred-occurrence', occurrence: expect.objectContaining({ source: later.sources.at(-1)!.selector }),
    }));
  });

  it('rejects independently authenticated tokens when their source event sequences differ', async () => {
    const inventoryReader = fixture(false, uuid(900), 5); const receiptReader = fixture(false, uuid(900), 6);
    const inventory = await readCarrierInventory(inventoryReader.sink, inventoryReader.projection.carrier, inventoryReader.actor);
    if (inventory.kind !== 'ok') throw new Error(JSON.stringify(inventory));
    const receipts = (await liveTokens(receiptReader)).receipts;
    expect(projectAuthenticatedCarrier(inventory.value, receipts)).toMatchObject({ kind: 'conflict', reason: 'stale_token_sequence' });
  });

  it('refuses a transfer receipt not included in the exact live receipt token', async () => {
    const f = fixture(false); const tokens = await liveTokens(f);
    const fake = { preparation: { split: { receipt: { id: uuid(999) }, source: { classification: { id: uuid(998) }, corrections: [] } }, carrier: { classification: { id: uuid(997) }, corrections: [] } }, receipt: { id: uuid(996) } } as any;
    expect(projectAuthenticatedCarrier(tokens.inventory, tokens.receipts, { transfers: [fake] })).toMatchObject({ kind: 'conflict', reason: 'receipt_not_authenticated' });
  });
});
