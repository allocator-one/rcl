import { lstat } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { HarnessSink } from '../../telemetry/sink.js';
import { readStable,sha256 } from '../../telemetry/recovery/files.js';
import { inspectRecoveryDirectory } from '../original-run/lock-path.js';
import { decodeRecoveryDocument } from '../original-run/decode.js';
import { MAX_RECOVERY_DOCUMENT_BYTES } from '../original-run/journal.js';
import { readEventReceipts,matchesPreparedEventReceipt,type StoredEventReceipt } from '../event-receipts.js';
import { readClaimProof } from './proof-storage.js';
import { claimCarriers,assertUnusedClaimIdentity,assertOwnedSplitSourceExtension } from './public-model.js';
import type { PublicClaimSelection } from './public-model.js';
import type { ClaimHistoryContent } from './carrier-inventory.js';
import type { Manifest,Material,Preparation,ClaimAdoption,AdoptedStage } from './public-manifest.js';
import { prepareClaimSplit,type ClaimSplitInput } from '../claim-split.js';
import { prepareClaimDisposition,prepareObligationTransfer } from './validation/occurrence.js';
import type { AcceptedSplitEvidence,ClaimDispositionInput,ObligationTransferInput } from './validation/occurrence-types.js';
const MAX=64*1024*1024;
async function pin(path:string):Promise<{path:string;sha256:string|null}> {
  try { await lstat(path); } catch(e) {
    if((e as NodeJS.ErrnoException).code==='ENOENT') return {path,sha256:null};
    throw e;
  }
  return {path,sha256:(await readStable(path,MAX)).sha256};
}
/** Old packet and proof paths remain immutable, including previously absent
 * packet paths. All referenced material bytes are physically revalidated. */
export async function verifyAdoptionFiles(proof:ClaimAdoption):Promise<void> {
  if(proof.version!==1||!Number.isSafeInteger(proof.depth)||proof.depth<1||proof.depth>8||proof.pins.length>40000||proof.proofRoots.length>20000)
    throw new Error('claim_adoption_bounds');
  for(const directory of new Set(proof.pins.map(p=>dirname(p.path)))) await inspectRecoveryDirectory(directory,true);
  for(const item of proof.pins) if(!isDeepStrictEqual(await pin(item.path),item)) throw new Error('claim_adoption_source_changed');
}
/** Absence is rechecked before each remaining write. A late old receipt is
 * never ignored or replaced by a second assertion. Re-preview may adopt it. */
export async function verifyReplacedAbsence(proof:ClaimAdoption,sink:HarnessSink):Promise<void> {
  for(const item of proof.replacements) {
    const answer=await readEventReceipts(sink,item.scope,[item.oldId]);
    if(answer.kind!=='ok') throw new Error('claim_adoption_receipt_unanswered');
    if(answer.value.receipts.length) throw new Error('claim_superseded_receipt_arrived');
  }
}
interface Options {
  path:string;manifest:Manifest;manifestSha:string;current:ClaimHistoryContent;stages:Manifest['stages'];sink:HarnessSink;
  validate:(manifest:Manifest,material:Material,item:Manifest['stages'][number],preparation:Preparation,history:ClaimHistoryContent,split:AcceptedSplitEvidence|undefined,createdAt?:string)=>void;
  splitEvidence:(material:Material,selection:PublicClaimSelection,input:ClaimSplitInput,receipt:StoredEventReceipt)=>AcceptedSplitEvidence;
}
/** Explicit adoption can extend the old history only additively. It never
 * edits the old manifest, reallocates an accepted UUID, or asserts absence
 * from a failed/partial read. Current CAS is used only by new event UUIDs. */
export async function prepareClaimAdoption(o:Options):Promise<{proof:ClaimAdoption;stages:Manifest['stages']}> {
  const {manifest:old,current}=o,selection=old.selection;
  await inspectRecoveryDirectory(dirname(o.path),true);
  if(selection.action!=='split') throw new Error('claim_adoption_requires_split_operation');
  const materialPin=await pin(o.path+'.material');
  if(materialPin.sha256!==old.materialSha256) throw new Error('claim_material_changed');
  const material=await readClaimProof(o.path+'.material',o.path+'.proofs') as Material;
  if(sha256(material.nativeJson)!==old.nativeSha256) throw new Error('native_source_conflict');
  if(Boolean(material.adoption)!==(old.version===3)) throw new Error('claim_adoption_version_conflict');
  if(material.adoption) {await verifyAdoptionFiles(material.adoption);await verifyReplacedAbsence(material.adoption,o.sink);}
  if(material.history.actorUserId!==old.actorUserId||old.actorUserId!==current.actorUserId) throw new Error('claim_adoption_actor_changed');
  for(const history of material.history.histories) {
    const now=current.histories.find(h=>h.runId===history.runId);
    if(!now||now.eventSequence<history.eventSequence||history.receipts.some(r=>!isDeepStrictEqual(r,now.receipts.find(n=>n.id===r.id)))) throw new Error('claim_adoption_history_changed');
  }
  const oldCarriers=claimCarriers(material.history,selection),carriers=claimCarriers(current,selection);
  const kinds=['split',...oldCarriers.map(()=> 'transfer'),...(selection.disposition?['disposition']:[])];
  if(!isDeepStrictEqual(old.stages.map(s=>s.kind),kinds)||new Set(old.stages.map(s=>s.id)).size!==old.stages.length||oldCarriers.some((_,i)=>old.stages[i+1]?.carrierIndex!==i)) throw new Error('claim_manifest_stage_conflict');
  const pins=[...(material.adoption?.pins??[]),await pin(o.path),materialPin];
  if(pins.at(-2)!.sha256!==o.manifestSha) throw new Error('manifest_digest_mismatch');
  const proofRoots=[...(material.adoption?.proofRoots??[]),{path:o.path+'.material',pool:o.path+'.proofs'}];
  const rows:Array<{stage:Manifest['stages'][number];scope:import('../event-receipts.js').EventReceiptScope;receipt:StoredEventReceipt|undefined;preparation:Preparation|undefined;eventJson:string|undefined;inherited:AdoptedStage|undefined}>=[];
  // Query every allocated stage, even if no packet was published. The index
  // and selected read must agree about presence and the complete receipt.
  for(const stage of old.stages) {
    const scope=stage.kind==='transfer'?oldCarriers[stage.carrierIndex!]!.scope:selection.source.scope;
    const answer=await readEventReceipts(o.sink,scope,[stage.id]);
    if(answer.kind!=='ok') throw new Error('claim_adoption_receipt_unanswered');
    const receipt=answer.value.receipts[0];
    const indexed=current.histories.flatMap(h=>h.receipts).find(r=>r.id===stage.id);
    if(!isDeepStrictEqual(receipt,indexed)) throw new Error('claim_adoption_receipt_conflict');
    const inputPath=`${o.path}.${stage.id}.input`,packetPath=`${o.path}.${stage.id}.packet`;
    const inputPin=await pin(inputPath),packetPin=await pin(packetPath);
    pins.push(inputPin,packetPin);
    if(inputPin.sha256) proofRoots.push({path:inputPath,pool:o.path+'.proofs'});
    const inherited=material.adoption?.accepted.find(a=>a.id===stage.id);
    const preparation=inputPin.sha256?await readClaimProof(inputPath,o.path+'.proofs') as Preparation:inherited?.preparation;
    let eventJson:string|undefined;
    if(preparation) {
      if(preparation.eventId!==stage.id) throw new Error('claim_preparation_conflict');
      const event=stage.kind==='split'?prepareClaimSplit(preparation as ClaimSplitInput).event:stage.kind==='transfer'?prepareObligationTransfer(preparation as ObligationTransferInput).event:prepareClaimDisposition(preparation as ClaimDispositionInput).event;
      eventJson=JSON.stringify(event);
    }
    if(packetPin.sha256) {
      const packet=decodeRecoveryDocument((await readStable(packetPath,MAX_RECOVERY_DOCUMENT_BYTES)).text) as Record<string,unknown>;
      const expected={kind:'rcl-prepared-claim-event',version:1,operation_id:old.operationId,manifest_sha256:o.manifestSha,destination:scope,actor_user_id:old.actorUserId,target:selection.source.target,event_json:eventJson,event_sha256:eventJson? sha256(eventJson):undefined};
      if(!isDeepStrictEqual(packet,expected)) throw new Error('claim_event_packet_conflict');
    }
    if(receipt&&(!preparation||!eventJson||(!packetPin.sha256&&!inherited)||!matchesPreparedEventReceipt(receipt,eventJson!,scope,old.actorUserId))) throw new Error('claim_adoption_receipt_conflict');
    if(inherited&&(!receipt||!isDeepStrictEqual(inherited.receipt,receipt)||inherited.eventJson!==eventJson)) throw new Error('claim_adopted_receipt_unavailable');
    rows.push({stage,scope,receipt,preparation,eventJson,inherited});
  }
  const owned=new Map(rows.flatMap(row=>row.eventJson?[[row.stage.id,row.eventJson] as const]:[]));
  const acceptedReceipts=rows.flatMap(row=>row.receipt?[row.receipt]:[]);
  const sources=material.history.sources.map(source=>{
    const currentSource=current.sources.find(s=>s.selector.scope.run_id===source.selector.scope.run_id);
    assertOwnedSplitSourceExtension(source,currentSource,acceptedReceipts,owned,old.actorUserId);
    return currentSource!;
  });
  const priorHistory={...material.history,sources,histories:material.history.histories.map(h=>{
    const receipts=[...h.receipts,...rows.flatMap(r=>r.receipt&&r.receipt.run_id===h.runId&&!h.receipts.some(x=>x.id===r.receipt!.id)?[r.receipt]:[])].sort((a,b)=>a.sequence-b.sequence);
    return {...h,receipts,eventSequence:Math.max(h.eventSequence,...receipts.map(r=>r.sequence))};
  })};
  const accepted:AdoptedStage[]=[],replacements=[...(material.adoption?.replacements??[])];
  const reserved=new Set([...old.stages.map(s=>s.id),...(material.adoption?.replacements.flatMap(r=>[r.oldId,r.newId])??[])]);
  if(o.stages.some(s=>reserved.has(s.id))) throw new Error('claim_adoption_uuid_conflict');
  const stages=o.stages.map(s=>({...s}));
  let split:AcceptedSplitEvidence|undefined;
  for(const row of rows) {
    const {stage,receipt,preparation,inherited}=row;
    const index=stage.kind==='transfer'?carriers.findIndex(c=>isDeepStrictEqual(c,oldCarriers[stage.carrierIndex!]))+1:stage.kind==='split'?0:stages.length-1;
    if(index<0||!stages[index]||stages[index]!.kind!==stage.kind) throw new Error('claim_adoption_carrier_changed');
    if(receipt) {
      const history=inherited?.history??priorHistory,createdAt=inherited?.createdAt??old.createdAt;
      const validationStage=inherited?.validationStage??stage;
      o.validate(old,material,validationStage,preparation!,history,split,createdAt);
      accepted.push({id:stage.id,preparation:preparation!,eventJson:row.eventJson!,receipt,history,createdAt,validationStage});
      stages[index]!.id=stage.id;
      if(stage.kind==='split') split=o.splitEvidence({...material,history:priorHistory},selection,preparation as ClaimSplitInput,receipt);
    } else replacements.push({oldId:stage.id,newId:stages[index]!.id,scope:row.scope});
  }
  if(!split) assertUnusedClaimIdentity(current,selection.identity);
  // readClaimProof already validated these root inventories. Retain every
  // physical blob digest so fresh checks hash bytes without repeatedly
  // reparsing the entire immutable proof graph.
  for(const root of proofRoots) {
    const inventory=decodeRecoveryDocument((await readStable(root.path,MAX_RECOVERY_DOCUMENT_BYTES)).text) as {sha256s:string[]};
    for(const digest of inventory.sha256s) pins.push({path:join(root.pool,digest),sha256:digest});
  }
  const uniquePins=new Map<string,typeof pins[number]>();
  for(const value of pins) {const previous=uniquePins.get(value.path); if(previous&&!isDeepStrictEqual(previous,value)) throw new Error('claim_adoption_source_changed');uniquePins.set(value.path,value);}
  const proof:ClaimAdoption={version:1,depth:(material.adoption?.depth??0)+1,previousManifest:o.path,previousManifestSha256:o.manifestSha,pins:[...uniquePins.values()],proofRoots:[...new Map(proofRoots.map(r=>[r.path,r])).values()],accepted,replacements};
  await verifyAdoptionFiles(proof);
  return {proof,stages};
}
