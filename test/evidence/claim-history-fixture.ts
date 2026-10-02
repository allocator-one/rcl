import { expect } from 'vitest';
import type { ClaimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { projectionFixture } from './recovery-validation/carrier-fixtures.js';
import { uuid } from './recovery-validation/fixtures.js';
export function historyFixture(legacy=true,history?: ClaimHistoryContent) {
  const { projection }=projectionFixture(legacy);
  const actor=history?.actorUserId??uuid(900);
  const scope=history?.sources[0]!.selector.scope??projection.carrier.scope;
  const sources=structuredClone(history?.sources??projection.sources);
  const receipts=(source: typeof sources[number]) => history?.histories.find(h => h.runId===source.selector.scope.run_id)!.receipts??[...source.classifications!,...source.corrections!];
  const calls: string[]=[];
  const counts=new Map<string,number>();
  let mutate: (body: any,url: URL,visit: number) => unknown=body => body;
  let status: (url: URL) => number=() => 200;
  const sink=new HarnessSink({
    credential: { url: scope.base_url,token: 'synthetic-only',source: 'login' },
    rclVersion: 'test',fetchImpl: async (input,request) => {
      expect(request?.method??'GET').toBe('GET');
      const url=new URL(String(input));
      calls.push(url.pathname+url.search);
      const visit=(counts.get(url.pathname)??0)+1;
      counts.set(url.pathname,visit);
      const parts=url.pathname.split('/');
      const source=sources.find(s => s.selector.scope.run_id===parts[5]);
      if(url.pathname.endsWith('/artifacts/report_json')) {
        const report=source!.reportJson!;
        return new Response(report,{ status: status(url),headers: { 'x-artifact-sha256': source!.selector.reportSha256 } });
      }
      let body: any;
      if(url.pathname==='/api/v1/reviews/runs') {
        const rows=sources.map(s => ({
          id: s.selector.scope.run_id,target: structuredClone(s.storedRun!.target),
          converge: structuredClone(s.storedRun!.converge)
        }));
        const page=Number(url.searchParams.get('page'));
        body={
          data: rows.slice((page-1)*100,page*100),meta: {
            org_id: scope.org_id,evidence_protocol_version: 2,page,page_size: 100,
            total: rows.length,total_pages: Math.ceil(rows.length/100)
          }
        };
      }
      else if(url.pathname.endsWith('/events')) {
        const all=receipts(source!).slice().sort((a,b) => a.sequence-b.sequence);
        if(url.searchParams.get('index')==='claim_recovery') {
          const after=Number(url.searchParams.get('after_sequence'));
          const through=Number(url.searchParams.get('through_sequence'));
          const selected=all.filter(e => e.sequence>after&&e.sequence<=through).slice(0,50);
          const more=all.some(e => e.sequence>(selected.at(-1)?.sequence??after)&&e.sequence<=through);
          body={
            data: selected.map(({ id,sequence,kind }) => ({ id,sequence,kind })),meta: {
              org_id: scope.org_id,run_id: source!.selector.scope.run_id,
              claim_recovery_version: 1,through_sequence: through,next_after_sequence: more? selected.at(-1)!.sequence:null,complete: !more
            }
          };
          return Response.json(mutate(structuredClone(body),url,visit),{ status: status(url) });
        }
        const ids=url.searchParams.get('ids')!.split(',');
        body={
          data: receipts(source!).slice().filter(r => ids.includes(r.id)),
          meta: { org_id: scope.org_id,run_id: source!.selector.scope.run_id,claim_recovery_version: 1 }
        };
      }
      else {
        const classification=source!.classifications![0];
        body={
          data: structuredClone(source!.storedRun),meta: {
            org_id: scope.org_id,evidence_protocol_version: 2,
            claim_recovery_version: 1,actor_user_id: actor,recovery: {
              event_sequence: Math.max(5,...receipts(source!).map(e => e.sequence)),truncated: false,
              claim_events_complete: true,claim_events: receipts(source!).slice().sort((a,b) => a.sequence-b.sequence).map(({ id,sequence,kind }) => ({ id,sequence,kind })),
              classification_event: classification? {
                id: classification.id,round: classification.round,
                sequence: classification.sequence,identities: classification.payload.identities
              }:null,
              native_corrections: source!.corrections!.map(r => ({ id: r.id,sequence: r.sequence }))
            }
          }
        };
      }
      return Response.json(mutate(structuredClone(body),url,visit),{ status: status(url) });
    }
  });
  return {
    projection,sources,sink,actor,calls,change: (fn: typeof mutate) => { mutate=fn; },
    status: (fn: typeof status) => { status=fn; }
  };
}
