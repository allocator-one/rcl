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

describe('R8 actual authenticated inventory to full carrier projection', () => {
  it.each(['classification', 'correction'] as const)('retains a missing %s receipt as explicit residual despite complete run inventory', async missing => {
    const f = fixture(false);
    const source = f.sources[0]!;
    const classification = source.classifications![0]!;
    const correctionId = uuid(998);
    if (missing === 'correction') {
      source.corrections = [{ ...structuredClone(classification), id: correctionId, sequence: 2,
        kind: 'finding_identity_corrected', payload: { report_json_sha256: source.selector.reportSha256,
          finding_ref: 'f001', identity_key: 'retained-original', matched_identity: f.projection.carrier.identity } }];
      source.correctionIds = [correctionId];
    }
    const missingId = missing === 'classification' ? classification.id : correctionId;
    const original = JSON.stringify(f.sources);
    f.change((body, url) => {
      if (url.pathname.endsWith('/events')) body.data = body.data.filter((receipt: { id: string }) => receipt.id !== missingId);
      return body;
    });
    const result = await read(f);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error(JSON.stringify(result));
    const content = carrierInventoryContent(result.value);
    expect(content.inventory.inventoryStatus).toBe('complete');
    expect(content.inventory.sources).toHaveLength(1);
    const readSource = content.inventory.sources[0]!;
    expect(readSource.reportJson).toBe(source.reportJson);
    expect(readSource.storedRun).toEqual(source.storedRun);
    if (missing === 'classification') expect(readSource.classifications).toEqual([]);
    else {
      expect(readSource.classifications).toEqual(source.classifications);
      expect(readSource.correctionIds).toEqual([correctionId]);
      expect(readSource.corrections).toEqual([]);
    }
    const projected = projectOccurrenceCarrier({ ...f.projection, ...content.inventory });
    expect(projected.coverage).toBe('residuals-present');
    expect(projected.residuals).toContainEqual(expect.objectContaining({ reason: `${missing}-unavailable`, source: source.selector }));
    expect(projected.transfers).toEqual([]);
    expect(f.calls.some(path => path.endsWith('/artifacts/report_json'))).toBe(true);
    expect(f.calls.some(path => path.includes('/events?') && path.includes(missingId))).toBe(true);
    expect(JSON.stringify(f.sources)).toBe(original);
  });
});
