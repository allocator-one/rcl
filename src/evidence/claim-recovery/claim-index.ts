import type { HarnessSink,SinkOutcome } from '../../telemetry/sink.js';
import type { EventReceiptScope } from '../event-receipts.js';
import { object,uuidSchema } from './validation/primitives.js';
import { isEventReceiptScope } from './validation/receipts.js';
export const CLAIM_EVENT_KINDS=['round_processed','verdicts_recorded','finding_identity_corrected',
  'finding_claim_split','finding_obligation_transferred','finding_claim_disposition'] as const;
export interface ClaimEventSelector {
  id: string;
  sequence: number;
  kind: string;
}
export const MAX_CLAIM_EVENTS=20000;
const integer=(x: unknown): x is number => typeof x==='number'&&Number.isSafeInteger(x)&&x>=0;
export function claimEventSelector(value: unknown): value is ClaimEventSelector {
  return object(value)&&Object.keys(value).sort().join(',')==='id,kind,sequence'&&
    uuidSchema.safeParse(value.id).success&&integer(value.sequence)&&value.sequence>0&&
    CLAIM_EVENT_KINDS.includes(value.kind as typeof CLAIM_EVENT_KINDS[number]);
}
/** A bounded, pinned selector index. Payloads are read separately by exact UUID. */
export async function readClaimEventIndex(sink: HarnessSink,scope: EventReceiptScope,through: number): Promise<SinkOutcome<ClaimEventSelector[]>> {
  scope=structuredClone(scope);
  if(!object(scope)||!isEventReceiptScope(scope)||!integer(through)||sink.baseUrl!==scope.base_url||sink.credentialSource==='attest') {
    throw new Error('invalid_claim_index_selection');
  }
  const all: ClaimEventSelector[]=[];
  const ids=new Set<string>();
  let after=0;
  for(;;) {
    const query=new URLSearchParams({
      index: 'claim_recovery',after_sequence: String(after),
      through_sequence: String(through),limit: '50'
    });
    const result=await sink.getJson(`/api/v1/reviews/runs/${scope.run_id}/events?${query}`,(data,meta) => {
      if(!object(meta)||Object.keys(meta).sort().join(',')!==
        'claim_recovery_version,complete,next_after_sequence,org_id,run_id,through_sequence'||
        meta.org_id!==scope.org_id||meta.run_id!==scope.run_id||meta.claim_recovery_version!==1||
        meta.through_sequence!==through||typeof meta.complete!=='boolean'||
        !Array.isArray(data)||data.length>50)
        return null;
      let previous=after;
      for(const row of data) {
        if(!claimEventSelector(row)||row.sequence<=previous||row.sequence>through||ids.has(row.id)||
          data.filter(other => object(other)&&other.id===row.id).length!==1)
          return null;
        previous=row.sequence;
      }
      if(meta.complete? meta.next_after_sequence!==null:
        data.length!==50||meta.next_after_sequence!==previous||previous<=after||previous>=through)
        return null;
      return { rows: data as ClaimEventSelector[],next: meta.next_after_sequence as number|null };
    },{ requireCompleteRead: true });
    if(result.kind!=='ok')
      return result;
    all.push(...result.value.rows);
    result.value.rows.forEach(row => ids.add(row.id));
    if(all.length>MAX_CLAIM_EVENTS)
      return { kind: 'conflict',message: 'claim_event_index_limit' };
    if(result.value.next===null)
      return { kind: 'ok',httpStatus: 200,value: all };
    after=result.value.next;
  }
}
