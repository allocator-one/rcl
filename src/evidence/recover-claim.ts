import { manifestSchema,type Manifest,type Material,type Preparation } from './claim-recovery/public-manifest.js';
import { prepareClaimAdoption,verifyAdoptionFiles,verifyReplacedAbsence } from './claim-recovery/public-adoption.js';
import { readClaimProof,writeClaimProof } from './claim-recovery/proof-storage.js';
import type { AuthenticatedClaimHistory } from './claim-recovery/carrier-inventory.js';
import { scrubDeep } from '../telemetry/scrub.js';
import { randomUUID } from 'node:crypto';
import { lstat,realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveGitCommonDir } from '../converge/attempt-budget.js';
import { loadConvergeRunStateEvidence,convergeRunStatePath } from '../converge/run-state.js';
import { withRecoveryTarget } from '../converge/target-ownership.js';
import { applyNativeRecovery,deriveNativeRecovery,readNativeRecoverySourceJsons,readNativeRecoveryMaterials,recoveryAnchors,type NativeRecoveryInput } from '../converge/recovery-state.js';
import { correctionAnchor } from '../converge/correction-anchors.js';
import { prepareClaimSplit,type ClaimSplitInput } from './claim-split.js';
import { prepareObligationTransfer,prepareClaimDisposition,validatePreservedDispositionSubject } from './claim-recovery/validation/occurrence.js';
import { validateOccurrenceSource } from './claim-recovery/validation/occurrence-source.js';
import type { AcceptedSplitEvidence,ObligationTransferInput,ClaimDispositionInput } from './claim-recovery/validation/occurrence-types.js';
import type { AcceptedOccurrenceTransfer } from './claim-recovery/validation/carrier-types.js';
import type { AcceptedClaimDisposition } from './claim-recovery/validation/native-occurrences.js';
import { projectOccurrenceCarrier } from './claim-recovery/validation/carrier-projection.js';
import { readClaimTargetHistory,claimHistoryContent,sameClaimHistoryEvidence,type ClaimHistoryContent } from './claim-recovery/carrier-inventory.js';
import { publicClaimSelectionSchema,historySource,historyContext,claimCarriers,assertHistoryExtension,assertUnusedClaimIdentity,type PublicClaimSelection } from './claim-recovery/public-model.js';
import { deliverPreparedClaimEvent } from './claim-recovery/delivery.js';
import { decodeRecoveryDocument,decodeOriginalReport } from './original-run/decode.js';
import { inspectRecoveryDirectory } from './original-run/lock-path.js';
import { openJournal,writeExclusive,MAX_RECOVERY_DOCUMENT_BYTES } from './original-run/journal.js';
import { platformPath,readStable,sha256 } from '../telemetry/recovery/files.js';
import { matchesPreparedEventReceipt } from './event-receipts.js';
import { openSink,type EvidenceDeps } from './status.js';
const MAX_MATERIAL=64*1024*1024;
export interface PublicClaimRecoveryOptions {
  preview?: boolean;
  apply?: boolean;
  resume?: boolean;
  json?: boolean;
  selection?: string;
  adoptManifest?: string;
  adoptManifestSha256?: string;
  manifest: string;
  manifestSha256?: string;
}
export interface PublicClaimRecoveryDeps extends EvidenceDeps {
  beforeCheckpoint?: (phase: string) => Promise<void>;
}
function decode(text: string): unknown { return decodeRecoveryDocument(text); }
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  }
  catch(e) {
    if((e as NodeJS.ErrnoException).code==='ENOENT')
      return false;
    throw e;
  }
}
function splitInput(selection: PublicClaimSelection,material: Material,manifest: Pick<Manifest,'stages'|'createdAt'>,history: ClaimHistoryContent): ClaimSplitInput {
  const source=historySource(history,selection.source);
  const bound=validateOccurrenceSource(source);
  const member=bound.members.find(m => m.ref===selection.findingRef);
  if(!member||member.unresolvedReason||member.identity!==selection.previousIdentity)
    throw new Error('claim_original_mapping_unavailable');
  return {
    scope: selection.source.scope,target: selection.source.target,eventId: manifest.stages[0]!.id,occurredAt: manifest.createdAt,
    nativeJson: material.nativeJson,nativeSourceJsons: material.nativeSourceJsons,recoveryMaterials: material.recoveryMaterials,reportJson: source.reportJson,findingRef: selection.findingRef,
    previousIdentity: selection.previousIdentity,identity: selection.identity,descriptor: selection.descriptor,reason: selection.reason,
    expectedEventSequence: historyContext(history,selection.source).eventSequence,classificationId: source.classification.id,
    ...(member.correction? { correctionId: member.correction.id }:{}),sourceReceipts: [source.classification,...(member.correction? [member.correction]:[])]
  };
}
function errorCode(e: unknown): string { const m=e instanceof Error? e.message:''; return /^[a-z][a-z0-9_]+$/.test(m)? m:'claim_recovery_refused'; }
/** Public Mode B. Ordinary authenticated reads, exact durable events and the
 * same native target; no review, accounting reset, outbox or original rewrite. */
export async function runPublicClaimRecovery(options: PublicClaimRecoveryOptions,deps: PublicClaimRecoveryDeps): Promise<number> {
  let stage: 'input'|'remote'|'journal'='input';
  try {
    if([options.preview,options.apply,options.resume].filter(Boolean).length!==1)
      throw new Error('choose_exactly_one_recovery_mode');
    const path=platformPath(options.manifest);
    const pool=`${path}.proofs`;
    await inspectRecoveryDirectory(dirname(path),true);
    const commonDir=await realpath(await resolveGitCommonDir(deps.cwd));
    let manifest: Manifest;
    let material: Material;
    let manifestSha: string;
    if(options.preview) {
      if(options.manifestSha256||Boolean(options.selection)===Boolean(options.adoptManifest)||Boolean(options.adoptManifest)!==Boolean(options.adoptManifestSha256))
        throw new Error('preview_requires_selection_or_adoption');
      if(await exists(path)||await exists(`${path}.material`))
        throw new Error('manifest_already_exists');
      const oldPath=options.adoptManifest? platformPath(options.adoptManifest):undefined;
      const oldRaw=oldPath? await readStable(oldPath,MAX_RECOVERY_DOCUMENT_BYTES):undefined;
      if(oldRaw&&oldRaw.sha256!==options.adoptManifestSha256) throw new Error('manifest_digest_mismatch');
      const oldManifest=oldRaw? manifestSchema.parse(decode(oldRaw.text)):undefined;
      if(oldManifest&&oldManifest.gitCommonDir!==commonDir) throw new Error('native_repository_conflict');
      const selection=oldManifest?.selection??publicClaimSelectionSchema.parse(decodeOriginalReport((await readStable(platformPath(options.selection!),MAX_RECOVERY_DOCUMENT_BYTES)).text,{ exactNumbers: true }).value);
      const native=await loadConvergeRunStateEvidence(commonDir,selection.source.target);
      if(!native)
        throw new Error('native_target_unavailable');
      const nativeRaw=await readStable(convergeRunStatePath(commonDir,selection.source.target),MAX_MATERIAL);
      if(nativeRaw.sha256!==native.sha256)
        throw new Error('native_source_changed');
      const ancestors=await readNativeRecoverySourceJsons(commonDir,native.state);
      stage='remote';
      const sink=await openSink(deps);
      if(!sink)
        return 3;
      const read=await readClaimTargetHistory(sink,selection.source);
      if(read.kind!=='ok')
        throw new Error('claim_history_unanswered');
      const history=claimHistoryContent(read.value);
      if (selection.action === 'split'&&!oldManifest) assertUnusedClaimIdentity(history, selection.identity);
      material={ nativeJson: nativeRaw.text,nativeSourceJsons: ancestors,recoveryMaterials: await readNativeRecoveryMaterials(commonDir,native.state),history };
      const carriers=claimCarriers(history,selection);
      if(!carriers.length)
        throw new Error('claim_carrier_unavailable');
      if(selection.action==='disposition'&&!selection.disposition||selection.action==='refresh'&&selection.disposition)
        throw new Error('claim_action_disposition_conflict');
      let stages: Manifest['stages']=[...(selection.action==='split'? [{ id: randomUUID(),kind: 'split' as const },...carriers.map((_,carrierIndex) => ({ id: randomUUID(),kind: 'transfer' as const,carrierIndex }))]:[]),
      ...(selection.disposition? [{ id: randomUUID(),kind: 'disposition' as const }]:[])];
      const createdAt=new Date().toISOString();
      if(oldManifest) {
        if(oldManifest.nativeSha256!==nativeRaw.sha256) throw new Error('native_source_changed');
        const adoption=await prepareClaimAdoption({path:oldPath!,manifest:oldManifest,manifestSha:oldRaw!.sha256,current:history,stages,sink,validate:validatePreparation,splitEvidence});
        material.adoption=adoption.proof; stages=adoption.stages;
      }
      const adoptedSplit=material.adoption?.accepted.find(s => s.id===stages[0]?.id);
      const prepared=adoptedSplit? prepareClaimSplit(adoptedSplit.preparation as ClaimSplitInput):selection.action==='split'? prepareClaimSplit(splitInput(selection,material,{ stages,createdAt },history)):
        prepareClaimSplit(existingSplit(selection,material,history).selection);
      if(adoptedSplit&&selection.disposition&&!material.adoption?.accepted.some(a=>a.id===stages.at(-1)?.id))
        prepareClaimDisposition(dispositionInput(selection,history,splitEvidence(material,selection,adoptedSplit.preparation as ClaimSplitInput,adoptedSplit.receipt),stages.at(-1)!.id,createdAt,history.actorUserId));
      else if(!adoptedSplit) validateDispositionIntent(selection,history,stages.at(-1)?.id,material,createdAt);
      const preview={
        source: prepared.source,newIdentity: selection.identity,carriers: carriers.map(carrier => projectOccurrenceCarrier({
          carrier,
          inventoryStatus: 'complete',sources: history.sources,transfers: [],nativePredecessors: [{ sourceJson: material.nativeJson,nativeSourceJsons: ancestors }]
        })),
        disposition: selection.disposition??null,legacyVerdicts: 'retained without inherited semantic approval',accounting: 'unchanged; same target and rounds',
        ...(material.adoption? {adoption:{previous_manifest:oldPath,previous_manifest_sha256:oldRaw!.sha256,accepted_event_ids:material.adoption.accepted.map(a=>a.id),replacements:material.adoption.replacements}}:{})
      };
      if((await readStable(convergeRunStatePath(commonDir,selection.source.target),MAX_MATERIAL)).sha256!==nativeRaw.sha256)
        throw new Error('native_source_changed');
      stage='journal';
      await writeClaimProof(`${path}.material`,pool,material);
      const stored=await readStable(`${path}.material`,MAX_MATERIAL);
      manifest={
        kind: 'rcl-public-claim-recovery',version: material.adoption?3:2,operationId: randomUUID(),createdAt,rclVersion: deps.rclVersion,gitCommonDir: commonDir,
        selection,actorUserId: history.actorUserId,materialSha256: stored.sha256,nativeSha256: nativeRaw.sha256,stages,preview
      };
      await writeExclusive(path,manifest,MAX_RECOVERY_DOCUMENT_BYTES);
      manifestSha=(await readStable(path,MAX_RECOVERY_DOCUMENT_BYTES)).sha256;
      deps.stdout(JSON.stringify({ status: 'prepared',manifest: path,manifest_sha256: manifestSha,operation_id: manifest.operationId,preview }));
      return 0;
    }
    if(options.selection||options.adoptManifest||options.adoptManifestSha256||!options.manifestSha256)
      throw new Error('apply_requires_exact_manifest');
    const retained=await readStable(path,MAX_RECOVERY_DOCUMENT_BYTES);
    if(retained.sha256!==options.manifestSha256)
      throw new Error('manifest_digest_mismatch');
    manifest=manifestSchema.parse(decode(retained.text));
    manifestSha=retained.sha256;
    if(manifest.gitCommonDir!==commonDir)
      throw new Error('native_repository_conflict');
    const rawMaterial=await readStable(`${path}.material`,MAX_MATERIAL);
    if(rawMaterial.sha256!==manifest.materialSha256)
      throw new Error('claim_material_changed');
    material=await readClaimProof(`${path}.material`,pool) as Material;
    if(sha256(material.nativeJson)!==manifest.nativeSha256)
      throw new Error('native_source_conflict');
    const selection=manifest.selection;
    if(Boolean(material.adoption)!==(manifest.version===3)) throw new Error('claim_adoption_version_conflict');
    if(material.adoption) await verifyAdoptionFiles(material.adoption);
    const adoptedSplit=material.adoption?.accepted.find(s=>s.id===manifest.stages[0]?.id);
    if (selection.action === 'split'&&!adoptedSplit) assertUnusedClaimIdentity(material.history, selection.identity);
    const carriers=claimCarriers(material.history,selection);
    const expectedKinds=[...(selection.action==='split'? ['split',...carriers.map(() => 'transfer')]:[]),...(selection.disposition? ['disposition']:[])];
    if(!isDeepStrictEqual(manifest.stages.map(s => s.kind),expectedKinds)||new Set(manifest.stages.map(s => s.id)).size!==manifest.stages.length||
      selection.action==='split'&&carriers.some((_,i) => manifest.stages[i+1]!.carrierIndex!==i))
      throw new Error('claim_manifest_stage_conflict');
    if(!adoptedSplit) validateDispositionIntent(selection,material.history,manifest.stages.at(-1)?.id,material,manifest.createdAt);
    // Re-prove the pinned original before acquiring authority or contacting HTTP.
    if(selection.action==='split')
      prepareClaimSplit(adoptedSplit?adoptedSplit.preparation as ClaimSplitInput:splitInput(selection,material,manifest,material.history));
    else
      existingSplit(selection,material,material.history);
    stage='remote';
    const sink=await openSink(deps);
    if(!sink)
      return 3;
    const output=await withRecoveryTarget(commonDir,selection.source.target,async (ownership) => {
      stage='journal';
      const journal=await openJournal(`${path}.journal`,manifestSha,manifest.operationId,options.apply? 'apply':'resume',deps.beforeCheckpoint);
      const owned=new Map<string,string>(material.adoption?.accepted.map(a=>[a.id,a.eventJson]));
      // Existing packets are immutable and are the only receipts permitted to
      // extend the preview. Never regenerate a payload after uncertain delivery.
      for(const item of manifest.stages) {
        const packetPath=`${path}.${item.id}.packet`;
        if(await exists(packetPath)) {
          const packet=decode((await readStable(packetPath,MAX_RECOVERY_DOCUMENT_BYTES)).text) as {
            event_json: string;
          };
          owned.set(item.id,packet.event_json);
        }
      }
      let history=material.history;
      let historyToken: AuthenticatedClaimHistory|undefined;
      const fresh=async () => {
        if((await readStable(path,MAX_RECOVERY_DOCUMENT_BYTES)).sha256!==manifestSha||
          (await readStable(`${path}.material`,MAX_MATERIAL)).sha256!==manifest.materialSha256)
          throw new Error('claim_manifest_changed');
        if(material.adoption) { await verifyAdoptionFiles(material.adoption); await verifyReplacedAbsence(material.adoption,sink); }
        const read=await readClaimTargetHistory(sink,selection.source,manifest.actorUserId);
        if(read.kind!=='ok')
          throw new Error('claim_history_unanswered');
        const current=claimHistoryContent(read.value);
        assertHistoryExtension(material.history,current,owned);
        for(const h of current.histories)
          for(const receipt of h.receipts) {
            const event=owned.get(receipt.id);
            if(event&&
              !matchesPreparedEventReceipt(receipt,event,{ ...selection.source.scope,run_id: h.runId },manifest.actorUserId))
              throw new Error('claim_receipt_conflict');
          }
        history=current;
        historyToken=read.value;
      };
      await fresh();
      const stateBefore=await readStable(convergeRunStatePath(commonDir,selection.source.target),MAX_MATERIAL);
      const savedPlanPath=`${path}.native-plan`;
      if(stateBefore.sha256!==manifest.nativeSha256&&!(await exists(savedPlanPath)))
        throw new Error('native_source_changed');
      const transfers: AcceptedOccurrenceTransfer[]=[];
      const dispositions: AcceptedClaimDisposition[]=[];
      let acceptedSplit: AcceptedSplitEvidence|undefined=selection.action==='split'? undefined:existingSplit(selection,material,history);
      for(const item of manifest.stages) {
        stage='remote';
        await fresh();
        const inputPath=`${path}.${item.id}.input`;
        let preparation: ClaimSplitInput|ObligationTransferInput|ClaimDispositionInput;
        const inputExists=await exists(inputPath);
        const adopted=material.adoption?.accepted.find(a=>a.id===item.id);
        if(adopted) {
          preparation=adopted.preparation;
          if(inputExists&&!isDeepStrictEqual(await readClaimProof(inputPath,pool),preparation)) throw new Error('claim_preparation_conflict');
        }
        else if(inputExists)
          preparation=await readClaimProof(inputPath,pool) as typeof preparation;
        else if(item.kind==='split')
          preparation=splitInput(selection,material,manifest,history);
        else {
          if(!acceptedSplit)
            throw new Error('claim_split_receipt_missing');
          const common={ eventId: item.id,occurredAt: manifest.createdAt,actorUserId: manifest.actorUserId,split: acceptedSplit,sourceContext: historyContext(history,selection.source) };
          if(item.kind==='transfer') {
            const carrier=carriers[item.carrierIndex!]!;
            preparation={ ...common,carrier: historySource(history,carrier),carrierContext: historyContext(history,carrier),carrierKind: carrier.kind,carrierIdentity: carrier.identity,reason: selection.reason };
          }
          else {
            preparation=dispositionInput(selection,history,acceptedSplit,item.id,manifest.createdAt,manifest.actorUserId);
          }
        }
        validatePreparation(manifest,material,adopted?.validationStage??item,preparation,adopted?.history??history,acceptedSplit,adopted?.createdAt??manifest.createdAt);
        const event=item.kind==='split'? prepareClaimSplit(preparation as ClaimSplitInput).event:
          item.kind==='transfer'? prepareObligationTransfer(preparation as ObligationTransferInput).event:prepareClaimDisposition(preparation as ClaimDispositionInput).event;
        const eventJson=JSON.stringify(event);
        if(adopted&&eventJson!==adopted.eventJson) throw new Error('claim_adoption_event_conflict');
        const packetPath=`${path}.${item.id}.packet`;
        if(!inputExists)
          await writeClaimProof(inputPath,pool,preparation);
        owned.set(item.id,eventJson);
        const receipt=await deliverPreparedClaimEvent({
          gitCommonDir: commonDir,target: selection.source.target,ownership,
          operationId: manifest.operationId,manifestSha256: manifestSha,packetPath,mode: await exists(packetPath)? 'resume':'apply',
          scope: { ...selection.source.scope,run_id: event.run_id! },actor: manifest.actorUserId,eventJson,sink,journal,verifyContext: fresh,allowPost: !adopted
        });
        if(item.kind==='split') {
          const p=preparation as ClaimSplitInput;
          acceptedSplit={
            selection: p,receipt,actorUserId: manifest.actorUserId,
            source: historySource(history,selection.source),native: {
              sourceJson: material.nativeJson,target: selection.source.target,nativeSourceJsons: material.nativeSourceJsons,recoveryMaterials: material.recoveryMaterials,
              reports: nativeReports(material)
            }
          };
        }
        else if(item.kind==='transfer')
          transfers.push({ preparation: preparation as ObligationTransferInput,receipt,actorUserId: manifest.actorUserId });
        else
          dispositions.push({ preparation: preparation as ClaimDispositionInput,receipt,actorUserId: manifest.actorUserId });
      }
      await fresh();
      if(!acceptedSplit)
        throw new Error('claim_split_receipt_missing');
      if(await exists(savedPlanPath)) {
        const saved=await readClaimProof(savedPlanPath,pool) as import('../converge/recovery-state.js').NativeRecoveryPlan;
        if(!saved.currentHistory||!sameClaimHistoryEvidence(saved.currentHistory,history))
          throw new Error('native_plan_history_changed');
        history={ ...history,readWindow: saved.currentHistory.readWindow };
      }
      const input: NativeRecoveryInput={
        sourceJson: material.nativeJson,externalMaterial: true,recoveryMaterials: material.recoveryMaterials,currentHistory: history,nativeSourceJsons: material.nativeSourceJsons,target: selection.source.target,operationId: manifest.operationId,
        anchors: selection.action==='split'? [correctionAnchor(acceptedSplit.selection,acceptedSplit.receipt,manifest.actorUserId,manifest.operationId)]:[],reports: selection.action==='split'? [acceptedSplit.source.reportJson]:[],
        sourceReceipts: selection.action==='split'? acceptedSplit.selection.sourceReceipts:[],transfers,dispositions,carriers: carriers.map(carrier => ({ carrier,inventoryStatus: 'complete',sources: history.sources }))
      };
      const plan=deriveNativeRecovery(input);
      if(await exists(savedPlanPath)) {
        if(!isDeepStrictEqual(await readClaimProof(savedPlanPath,pool),plan))
          throw new Error('native_plan_conflict');
      }
      else
        await writeClaimProof(savedPlanPath,pool,plan);
      await journal.append('claim_native_intent',{ source_sha256: plan.sourceSha256,result_sha256: plan.resultSha256 });
      await fresh();
      const result=await applyNativeRecovery({ gitCommonDir: commonDir,plan,ownership,history: historyToken });
      await journal.append('claim_native_verified',result);
      return {
        status: 'acknowledged',operation_id: manifest.operationId,native: result,actionable_identities: plan.actionableIdentities,
        accounting: 'rounds, attempts and original findings unchanged',projection_freshness: { read_window: plan.currentHistory?.readWindow,qualification: 'authenticated snapshot; not current server approval' },receipt_ids: manifest.stages.map(s => s.id)
      };
    });
    deps.stdout(JSON.stringify(output));
    return 0;
  }
  catch(error) {
    deps.stdout(JSON.stringify({ status: 'refused',reason: errorCode(error),stage }));
    return stage==='input'? 2:stage==='journal'? 5:4;
  }
}
function nativeReports(material: Material): string[] {
  const states=[material.nativeJson,...material.nativeSourceJsons].map(s => decode(s) as Record<string,any>);
  const digests=new Set<string>();
  for(const state of states) {
    for(const round of state.rounds??[])
      if(round.reportBinding?.reportSha256)
        digests.add(round.reportBinding.reportSha256);
    for(const op of state.recovery?.operations??[])
      for(const anchor of op.anchors??[])
        digests.add(anchor.source.reportSha256);
  }
  return [...digests].map(digest => {
    const source=material.history.sources.find(s => s.selector.reportSha256===digest); if(!source?.reportJson)
      throw new Error('native_original_report_unavailable'); return source.reportJson;
  });
}
function existingSplit(selection: PublicClaimSelection,material: Material,history: ClaimHistoryContent): AcceptedSplitEvidence {
  const state=decode(material.nativeJson) as import('../converge/run-state.js').ConvergeRunState;
  const candidates=recoveryAnchors(state).filter(a => a.identity===selection.identity);
  if(candidates.length!==1)
    throw new Error('existing_claim_anchor_unavailable');
  const anchor=candidates[0]!;
  if(anchor.source.findingRef!==selection.findingRef||anchor.source.previousIdentity!==selection.previousIdentity||
    anchor.source.reportSha256!==selection.source.reportSha256||anchor.source.runId!==selection.source.scope.run_id||
    !isDeepStrictEqual(anchor.descriptor,selection.descriptor)||!isDeepStrictEqual(anchor.destination,selection.source.scope))
    throw new Error('existing_claim_anchor_conflict');
  const receipt=history.histories.flatMap(h => h.receipts).find(r => r.id===anchor.receipt.id);
  if(!receipt||!isDeepStrictEqual(receipt,anchor.receipt)||!receipt.actor_user_id)
    throw new Error('existing_claim_receipt_unavailable');
  const snapshotMap=new Map([material.nativeJson,...material.nativeSourceJsons].map(text => [sha256(text),text]));
  const nativeJson=snapshotMap.get(anchor.nativeSource.sha256);
  if(!nativeJson)
    throw new Error('existing_claim_native_source_unavailable');
  const snapshots: string[]=[];
  let sourceState=decode(nativeJson) as Record<string,any>;
  const seen=new Set<string>();
  for(;;) {
    const digest=sourceState.version===3? sourceState.recovery.operations.at(-1).sourceSha256:sourceState.version===2? sourceState.migration?.sourceSha256:undefined;
    if(!digest)
      break;
    const text=snapshotMap.get(digest);
    if(!text||seen.has(digest))
      throw new Error('existing_claim_native_source_unavailable');
    seen.add(digest);
    snapshots.push(text);
    sourceState=decode(text) as Record<string,any>;
  }
  const event=decode(anchor.eventJson) as Record<string,any>;
  const payload=event.payload;
  const source=historySource(history,selection.source);
  const eventIds=payload.source_event_ids as string[];
  const sourceReceipts=eventIds.map(id => {
    const r=history.histories.flatMap(h => h.receipts).find(r => r.id===id);
    if(!r)
      throw new Error('existing_claim_receipt_unavailable');
    return r;
  });
  const input: ClaimSplitInput={
    scope: anchor.destination,target: selection.source.target,eventId: event.id,occurredAt: event.occurred_at,nativeJson,nativeSourceJsons: snapshots,
    recoveryMaterials: material.recoveryMaterials,reportJson: source.reportJson,findingRef: selection.findingRef,previousIdentity: selection.previousIdentity,
    identity: selection.identity,descriptor: selection.descriptor,reason: payload.reason,expectedEventSequence: payload.expected_event_sequence,
    classificationId: eventIds[0]!,...(eventIds[1]? { correctionId: eventIds[1] }:{}),sourceReceipts
  };
  if(!isDeepStrictEqual(correctionAnchor(input,receipt,receipt.actor_user_id,anchor.operationId),anchor))
    throw new Error('existing_claim_anchor_conflict');
  const oldMaterial={ ...material,nativeJson,nativeSourceJsons: snapshots };
  return {
    selection: input,receipt,actorUserId: receipt.actor_user_id,source,native: {
      sourceJson: nativeJson,nativeSourceJsons: snapshots,
      recoveryMaterials: material.recoveryMaterials,target: selection.source.target,reports: nativeReports(oldMaterial)
    }
  };
}
function validateDispositionIntent(selection: PublicClaimSelection,history: ClaimHistoryContent,eventId: string|undefined,material: Material,occurredAt: string): void {
  const request=selection.disposition;
  if(!request)
    return;
  if(!isDeepStrictEqual(scrubDeep(request),request))
    throw new Error('claim_disposition_redaction_conflict');
  const source=validateOccurrenceSource(historySource(history,selection.source));
  const member=source.members.find(m => m.ref===selection.findingRef);
  if(!member||member.unresolvedReason)
    throw new Error('claim_original_mapping_unavailable');
  if(selection.action!=='split') {
    prepareClaimDisposition(dispositionInput(selection,history,existingSplit(selection,material,history),eventId!,occurredAt,history.actorUserId));
    return;
  }
  if(member.severity==='critical'&&member.gating!=='none'&&request.severity!=='critical')
    throw new Error('claim_critical_disposition_required');
  if(request.mode==='fresh') {
    if(request.originalVerdictEventId)
      throw new Error('fresh_disposition_has_original_verdict');
    return;
  }
  const receipt=history.histories.find(h => h.runId===selection.source.scope.run_id)?.receipts.find(r => r.id===request.originalVerdictEventId);
  validatePreservedDispositionSubject({
    source,member,descriptor: selection.descriptor,eventId: eventId!,verdict: request.verdict,
    severity: request.severity,reason: request.reason,originalVerdict: receipt,originalVerdictActorUserId: receipt?.actor_user_id??undefined
  });
}
function dispositionInput(selection: PublicClaimSelection,history: ClaimHistoryContent,split: AcceptedSplitEvidence,eventId: string,occurredAt: string,actorUserId: string): ClaimDispositionInput {
  const request=selection.disposition!;
  const rows=history.histories.find(h => h.runId===selection.source.scope.run_id)!.receipts;
  const prior=rows.filter(r => r.kind==='finding_claim_disposition'&&r.payload.claim_identity===selection.identity).at(-1);
  const original=request.originalVerdictEventId? rows.find(r => r.id===request.originalVerdictEventId):undefined;
  return {
    eventId,occurredAt,actorUserId,split,sourceContext: historyContext(history,selection.source),
    mode: request.mode,verdict: request.verdict,severity: request.severity,reason: request.reason,
    previousDispositionEventId: prior?.id??null,...(prior? { previousDisposition: prior }:{}),
    ...(original? { originalVerdict: original,originalVerdictActorUserId: original.actor_user_id??undefined }:{}),
    laterSources: history.sources.filter(s => s.selector.round>selection.source.round).flatMap(s => {
      let source;
      try {
        source=historySource(history,s.selector);
      }
      catch {
        return [];
      }
      return validateOccurrenceSource(source).members.some(m => m.identity===selection.identity)? [source]:[];
    })
  };
}

function validatePreparation(manifest: Manifest,material: Material,item: Manifest['stages'][number],preparation: Preparation,history: ClaimHistoryContent,acceptedSplit: AcceptedSplitEvidence|undefined,createdAt=manifest.createdAt): void {
  const selection=manifest.selection;
  const carriers=claimCarriers(history,selection);
  if(preparation.eventId!==item.id||preparation.occurredAt!==createdAt)
    throw new Error('claim_preparation_conflict');
  if(item.kind==='split') {
    const p=preparation as ClaimSplitInput;
    const expected=splitInput(selection,material,{...manifest,createdAt},history);
    if(!isDeepStrictEqual({ ...p,expectedEventSequence: expected.expectedEventSequence },expected))
      throw new Error('claim_preparation_conflict');
  }
  else {
    const p=preparation as ObligationTransferInput|ClaimDispositionInput;
    if(!isDeepStrictEqual(p.split,acceptedSplit)||p.actorUserId!==manifest.actorUserId||
      !isDeepStrictEqual({ ...p.sourceContext,eventSequence: 0 },{ ...historyContext(history,selection.source),eventSequence: 0 }))
      throw new Error('claim_preparation_conflict');
    if(item.kind==='transfer') {
      const t=p as ObligationTransferInput;
      const carrier=carriers[item.carrierIndex!]!;
      if(t.reason!==selection.reason||t.carrierKind!==carrier.kind||t.carrierIdentity!==carrier.identity||
        !isDeepStrictEqual(t.carrier,historySource(history,carrier))||!isDeepStrictEqual({ ...t.carrierContext,eventSequence: 0 },{ ...historyContext(history,carrier),eventSequence: 0 }))
        throw new Error('claim_preparation_conflict');
    }
    else {
      const d=p as ClaimDispositionInput;
      const request=selection.disposition!;
      if(d.mode!==request.mode||d.verdict!==request.verdict||d.severity!==request.severity||d.reason!==request.reason||
        (d.originalVerdict?.id??null)!==(request.originalVerdictEventId??null))
        throw new Error('claim_preparation_conflict');
      const rows=history.histories.find(h => h.runId===selection.source.scope.run_id)!.receipts;
      const prior=rows.filter(r => r.kind==='finding_claim_disposition'&&r.payload.claim_identity===selection.identity&&
        r.sequence<=d.sourceContext.eventSequence).at(-1);
      const original=request.originalVerdictEventId? rows.find(r => r.id===request.originalVerdictEventId):undefined;
      const later=history.sources.filter(s => s.selector.round>selection.source.round).flatMap(s => {
        let source;
        try {
          source=historySource(history,s.selector);
        }
        catch {
          return [];
        }
        return validateOccurrenceSource(source).members.some(m => m.identity===selection.identity)? [source]:[];
      });
      if(d.previousDispositionEventId!==(prior?.id??null)||!isDeepStrictEqual(d.previousDisposition,prior)||
        !isDeepStrictEqual(d.originalVerdict,original)||!isDeepStrictEqual(d.laterSources??[],later))
        throw new Error('claim_preparation_conflict');
    }
  }

}

function splitEvidence(material: Material,selection: PublicClaimSelection,p: ClaimSplitInput,receipt: import('./event-receipts.js').StoredEventReceipt): AcceptedSplitEvidence {
 return {selection:p,receipt,actorUserId:material.history.actorUserId,source:historySource(material.history,selection.source),native:{sourceJson:material.nativeJson,target:selection.source.target,nativeSourceJsons:material.nativeSourceJsons,recoveryMaterials:material.recoveryMaterials,reports:nativeReports(material)}};
}
