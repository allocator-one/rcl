import { describe, expect, it } from 'vitest';
import { readCarrierInventory, carrierInventoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { projectionFixture } from './recovery-validation/carrier-fixtures.js';
import { sha, uuid } from './recovery-validation/fixtures.js';
import { projectOccurrenceCarrier } from '../../src/evidence/claim-recovery/validation/carrier-projection.js';

function fixture(legacy = true) {
  const { projection } = projectionFixture(legacy);
  const actor = uuid(900); const scope = projection.carrier.scope;
  const sources = structuredClone(projection.sources);
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
        body = { data: [...source!.classifications!, ...source!.corrections!].filter(r => ids.includes(r.id)),
          meta: { org_id: scope.org_id, run_id: source!.selector.scope.run_id, claim_recovery_version: 1 } };
      } else {
        const classification = source!.classifications![0];
        body = { data: structuredClone(source!.storedRun), meta: { org_id: scope.org_id, evidence_protocol_version: 2,
          claim_recovery_version: 1, actor_user_id: actor, recovery: { event_sequence: 5, truncated: false,
            classification_event: classification ? { id: classification.id, round: classification.round,
              sequence: classification.sequence, identities: classification.payload.identities } : null,
            native_corrections: source!.corrections!.map(r => ({ id: r.id, sequence: r.sequence })) } } };
      }
      return Response.json(mutate(structuredClone(body), url, visit), { status: status(url) });
    } });
  return { projection, sources, sink, actor, calls, change: (fn: typeof mutate) => { mutate = fn; },
    status: (fn: typeof status) => { status = fn; } };
}

async function read(f: ReturnType<typeof fixture>) { return readCarrierInventory(f.sink, f.projection.carrier, f.actor); }

describe('authenticated carrier inventory', () => {
  it('reads the complete original prefix including empty and unmarked rounds through GET only', async () => {
    const f = fixture(); const result = await read(f); expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    const content = carrierInventoryContent(result.value);
    expect(content.inventory.sources).toEqual([...f.sources].sort((a, b) => a.selector.scope.run_id.localeCompare(b.selector.scope.run_id)));
    expect(content.actorUserId).toBe(f.actor);
    expect(content.inventory.inventoryStatus).toBe('complete');
    expect(f.calls.filter(p => p.startsWith('/api/v1/reviews/runs?'))).toHaveLength(2);
    expect(f.calls.filter(p => p.endsWith('/artifacts/report_json'))).toHaveLength(3);
    expect(projectOccurrenceCarrier({ ...f.projection, ...content.inventory }).residuals.some(r => r.reason === 'untransferred-occurrence')).toBe(true);
  });

  it('does not authenticate a serialized or forged result and protects accepted content from caller mutation', async () => {
    const f = fixture(false); const result = await read(f); if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    expect(() => carrierInventoryContent(JSON.parse(JSON.stringify(result.value)))).toThrow('unverified_carrier_inventory');
    const content = carrierInventoryContent(result.value); content.inventory.sources.length = 0;
    expect(carrierInventoryContent(result.value).inventory.sources).toHaveLength(1);
  });

  it('retains missing rounds as explicit residuals rather than inferring an empty round', async () => {
    const f = fixture(); f.sources.splice(1, 1);
    const result = await read(f); if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    expect(projectOccurrenceCarrier({ ...f.projection, ...carrierInventoryContent(result.value).inventory }).residuals)
      .toContainEqual({ reason: 'round-missing', round: 2, runIds: [] });
  });

  it('keeps conflicting same-round runs in the inventory', async () => {
    const f = fixture(); const extra = structuredClone(f.sources[0]!); extra.selector.scope.run_id = uuid(950);
    extra.storedRun!.id = uuid(950);
    const report = JSON.parse(extra.reportJson!); report.run.id = uuid(950); extra.reportJson = JSON.stringify(report);
    extra.selector.reportSha256 = sha(extra.reportJson);
    (extra.storedRun!.artifacts as any[])[0].declared_sha256 = extra.selector.reportSha256;
    (extra.storedRun!.artifacts as any[])[0].declared_bytes = Buffer.byteLength(extra.reportJson);
    extra.classifications![0]!.run_id = uuid(950); extra.classifications![0]!.id = uuid(951);
    f.sources.push(extra);
    const result = await read(f); if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    expect(carrierInventoryContent(result.value).inventory.sources).toHaveLength(4);
    expect(projectOccurrenceCarrier({ ...f.projection, ...carrierInventoryContent(result.value).inventory }).residuals)
      .toContainEqual({ reason: 'round-conflict', round: 1, runIds: [f.sources[0]!.selector.scope.run_id, uuid(950)].sort() });
  });

  it.each(['actor', 'sequence', 'classification', 'run-set'])('refuses %s drift across the read window', async kind => {
    const f = fixture(); f.change((body, url, visit) => {
      if (visit > 1 && url.pathname === '/api/v1/reviews/runs' && kind === 'run-set') body.data[0].id = uuid(999);
      if (visit > 1 && body.meta.recovery) {
        if (kind === 'actor') body.meta.actor_user_id = uuid(901);
        if (kind === 'sequence') body.meta.recovery.event_sequence++;
        if (kind === 'classification') body.meta.recovery.classification_event.id = uuid(902);
      }
      return body;
    });
    expect((await read(f)).kind).not.toBe('ok');
  });

  it.each(['scope', 'duplicate', 'partial', 'pagination', 'over-limit', 'ambiguous-target'])('refuses %s inventory answers', async kind => {
    const f = fixture();
    if (kind === 'partial') f.status(url => url.pathname === '/api/v1/reviews/runs' ? 206 : 200);
    f.change((body, url) => {
      if (url.pathname === '/api/v1/reviews/runs') {
        if (kind === 'scope') body.data[0].target.repo = 'different/repository';
        if (kind === 'ambiguous-target') body.data[0].converge = {};
        if (kind === 'duplicate') body.data[1].id = body.data[0].id;
        if (kind === 'pagination') body.meta.total_pages = 2;
        if (kind === 'over-limit') { body.meta.total = 2001; body.meta.total_pages = 21; }
      }
      return body;
    });
    expect((await read(f)).kind).not.toBe('ok');
  });

  it('bounds aggregate original source material before downloading any artifact', async () => {
    const f = fixture(); f.change(body => {
      if (body.meta.recovery) body.data.artifacts[0].declared_bytes = 25_000_000;
      return body;
    });
    expect(await read(f)).toMatchObject({ kind: 'conflict', message: 'carrier_inventory_read_limit' });
    expect(f.calls.some(p => p.endsWith('/artifacts/report_json'))).toBe(false);
  });

  it('retains unavailable original artifacts and selected receipts as unresolved source evidence', async () => {
    const f = fixture(false); f.change((body, url) => {
      if (body.meta.recovery) body.data.artifacts[0].stored = false;
      if (url.pathname.endsWith('/events')) body.data = [];
      return body;
    });
    const result = await read(f); if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    const content = carrierInventoryContent(result.value);
    expect(content.inventory.sources[0]!.reportJson).toBeNull();
    expect(content.inventory.sources[0]!.classifications).toEqual([]);
    const reasons = projectOccurrenceCarrier({ ...f.projection, ...content.inventory }).residuals.map(r => r.reason);
    expect(reasons).toContain('artifact-unavailable'); expect(reasons).toContain('classification-unavailable');
  });

  it('uses every stable list page and excludes explicit other targets without losing the selected source', async () => {
    const f = fixture(false);
    for (let i = 0; i < 100; i++) {
      const other = structuredClone(f.sources[0]!); other.selector.scope.run_id = uuid(5000 + i);
      other.storedRun!.id = uuid(5000 + i); (other.storedRun!.converge as any).target = 'other-target';
      f.sources.push(other);
    }
    const result = await read(f); if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    expect(carrierInventoryContent(result.value).inventory.sources).toHaveLength(1);
    expect(f.calls.filter(p => p.startsWith('/api/v1/reviews/runs?'))).toHaveLength(4);
  });

  it.each(['sequence', 'kind'])('refuses a selected classification whose %s contradicts the exact source selector', async kind => {
    const f = fixture(false); f.change((body, url) => {
      if (url.pathname.endsWith('/events')) {
        if (kind === 'sequence') body.data[0].sequence = 2;
        else body.data[0].kind = 'verdicts_recorded';
      }
      return body;
    }); expect((await read(f)).kind).not.toBe('ok');
  });

  it('refuses a selected receipt newer than the source sequence', async () => {
    const f = fixture(false); f.change((body, url) => {
      if (url.pathname.endsWith('/events')) body.data[0].sequence = 6;
      return body;
    }); expect((await read(f)).kind).not.toBe('ok');
  });

  it('refuses truncated correction inventories and a backend without the full capability', async () => {
    for (const kind of ['truncated', 'capability']) {
      const f = fixture(false); f.change(body => {
        if (body.meta.recovery) { if (kind === 'truncated') body.meta.recovery.truncated = true; else delete body.meta.claim_recovery_version; }
        return body;
      }); expect((await read(f)).kind).not.toBe('ok');
    }
  });

  it('rejects destination and operator mismatches before reading any endpoint', async () => {
    const f = fixture(false); const carrier = structuredClone(f.projection.carrier); carrier.scope.base_url = 'https://other.example.test';
    await expect(readCarrierInventory(f.sink, carrier, f.actor)).rejects.toThrow('carrier_inventory_destination_conflict');
    await expect(readCarrierInventory(f.sink, f.projection.carrier, 'invalid-actor')).rejects.toThrow('invalid_carrier_inventory_selection');
    expect(f.calls).toEqual([]);
  });
});
