import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { stableStringify } from '../../../report/run-header.js';
import type { ClaimHistoryContent } from '../carrier-inventory.js';
import { replayEligibleConfirmationCandidate,replayRecoveryConfirmation } from '../confirmation.js';
import type { NativeCorrectionAnchor } from './anchors.js';
import type { ConvergeRunState } from './types.js';
import type { NativeOccurrenceEvidence,AcceptedClaimDisposition } from './native-occurrences.js';
import type { OccurrenceCarrierSelector,OccurrenceCarrierProjection } from './carrier-types.js';
import { projectOccurrenceCarrier } from './carrier-projection.js';
import { before,receiptFor,requireReason,validateOccurrenceSource,type ValidatedOccurrenceSource } from './occurrence-source.js';
import { migratedLegacyPendingRound } from './obligations.js';
import { isStoredEventReceipt,type StoredEventReceipt } from './receipts.js';
import { instant,object,uuidSchema } from './primitives.js';
export interface CurrentClaimProjection {
  version: 1|2;
  nativeFingerprint: string;
  history: ClaimHistoryContent;
  actionableIdentities: string[];
  carriers: OccurrenceCarrierProjection[];
  claims: Array<{
    identity: string;
    standing: 'pending'|'dismissed'|'confirmed-fixed'|'nongating';
    dispositionEventId: string|null;
    reasons: string[];
  }>;
  residuals: Array<{
    reason: string;
    runId?: string;
    round?: number;
  }>;
}
const requireProof=(condition: unknown): void => {
  if(!condition)
    throw new Error('current_claim_projection_conflict');
};
const time=(v: string) => BigInt(instant(v));

/** An ordinary later-run decision needs its own exact classified subject.
 * Complete authenticated history is supplied by the caller; this proof never
 * guesses attribution from a matching key, client timestamp, or run sequence. */
function ordinaryDecisionProven(receipt: StoredEventReceipt,anchor: NativeCorrectionAnchor,split: StoredEventReceipt,
  sources: ValidatedOccurrenceSource[],history: StoredEventReceipt[]): boolean {
  try {
    const source=sources.find(s => s.input.scope.run_id===receipt.run_id);
    if(!source||!uuidSchema.safeParse(receipt.actor_user_id).success) return false;
    receiptFor(receipt,source);
    const entries=receipt.payload.verdicts;
    if(!Array.isArray(entries)||!entries.every(v => object(v)&&typeof v.identity_key==='string'&&v.identity_key.length>0&&
      ['fixed','dismissed'].includes(v.verdict as string)&&['critical','important','minor','nitpick'].includes(v.severity as string))||
      new Set(entries.map(v => v.identity_key)).size!==entries.length) return false;
    for(const entry of entries) requireReason(entry.reason);
    const members=source.members.filter(m => m.mapping?.matched_identity===anchor.identity);
    let floor=split;
    let refs=[anchor.source.findingRef];
    if(receipt.run_id!==anchor.source.runId) {
      const classification=source.input.classification;
      const received=source.input.storedRun.received_at;
      if(source.round<=anchor.source.round||typeof received!=='string'||time(received)<time(split.received_at)||
        time(classification.received_at)<time(received)||time(classification.received_at)<time(split.received_at)||
        time(classification.received_at)===time(split.received_at)&&classification.sequence<=split.sequence||
        !uuidSchema.safeParse(classification.actor_user_id).success||
        classification.payload.classification_version!==1||members.length===0||
        members.some(m => m.mapping?.version!==1||!isDeepStrictEqual(m.raw.claimDescriptor,anchor.descriptor))||
        new Set(source.members.map(m => m.raw.identity)).size!==source.members.length) return false;
      floor=classification;
      refs=members.map(m => m.ref);
    }
    before(floor,receipt);
    return !history.some(event => event.run_id===receipt.run_id&&event.sequence>floor.sequence&&event.sequence<=receipt.sequence&&
      (event.kind==='round_processed'||event.kind==='finding_identity_corrected'&&refs.includes(event.payload.finding_ref as string)));
  } catch { return false; }
}

/** Only bound post-split classifications participate in the server's current
 * severity/confirmation view. Corrections cannot erase original attribution. */
function observationSource(source: ValidatedOccurrenceSource,anchor: NativeCorrectionAnchor,split: StoredEventReceipt): boolean {
  const marker=source.input.classification,received=source.input.storedRun.received_at;
  return marker.payload.classification_version===1&&typeof received==='string'&&
    time(marker.received_at)>=time(received)&&
    (time(marker.received_at)>time(split.received_at)||time(marker.received_at)===time(split.received_at)&&marker.sequence>split.sequence)&&
    (marker.run_id===split.run_id&&marker.sequence>split.sequence||source.round>anchor.source.round);
}

function latestDecision(receipts: StoredEventReceipt[]): { latest?: StoredEventReceipt;ambiguous: boolean } {
  const ordered=receipts.slice().sort((a,b) => time(a.received_at)<time(b.received_at)? -1:
    time(a.received_at)>time(b.received_at)? 1:a.sequence-b.sequence);
  const latest=ordered.at(-1);
  return { latest,ambiguous: !!latest&&ordered.some(r => r.run_id!==latest.run_id&&time(r.received_at)===time(latest.received_at)) };
}
/** Any ordinary round/verdict change invalidates a previous remote projection. */
export function nativeProjectionFingerprint(state: ConvergeRunState): string {
  const { version: _version,recovery: _recovery,sightings,...ordinary }=state;
  return createHash('sha256').update(stableStringify({ ...ordinary,sightings: sightings??[] })).digest('hex');
}
export interface RecoveryProjectionFreshness {
  readWindow: ClaimHistoryContent['readWindow'];
  proofSha256: string;
  validForNative: boolean;
  qualification: 'authenticated snapshot; not current server approval';
}
/** Report the retained read boundary without claiming a new authenticated read. */
export function recoveryProjectionFreshness(state: ConvergeRunState): RecoveryProjectionFreshness|undefined {
  const material=state.recovery?.operations.at(-1)?.material;
  if(!material?.current)
    return undefined;
  return {
    readWindow: material.current.readWindow,proofSha256: material.rootSha256,
    validForNative: material.current.nativeFingerprint===nativeProjectionFingerprint(state),
    qualification: 'authenticated snapshot; not current server approval'
  };
}
/** Content replay only. The native write boundary separately requires the live
 * opaque complete-history token; saved booleans never authorize clearing. */
export function deriveCurrentClaimProjection(state: ConvergeRunState,anchors: NativeCorrectionAnchor[],evidence: NativeOccurrenceEvidence[],history: ClaimHistoryContent,nativeSourceJsons: string[]=[],sourceJson=JSON.stringify(state),projectionVersion: CurrentClaimProjection['version']=2): CurrentClaimProjection {
  requireProof(projectionVersion===1||projectionVersion===2);
  requireProof(anchors.length>0&&uuidSchema.safeParse(history.actorUserId).success&&history.sources.length===history.histories.length);
  requireProof(time(history.readWindow.startedAt)<=time(history.readWindow.completedAt));
  const target=state.target;
  const destination=anchors[0]!.destination;
  const receipts=new Map<string,StoredEventReceipt>();
  const validated: ValidatedOccurrenceSource[]=[];
  const residuals: CurrentClaimProjection['residuals']=[];
  requireProof(new Set(history.sources.map(s => s.selector.scope.run_id)).size===history.sources.length);
  for(const row of history.sources) {
    const scope=row.selector.scope;
    requireProof(scope.base_url===destination.base_url&&scope.org_id===destination.org_id&&scope.repo.toLowerCase()===destination.repo.toLowerCase()&&
      scope.pr_number===destination.pr_number&&row.selector.target===target);
    const events=history.histories.filter(h => h.runId===scope.run_id);
    requireProof(events.length===1);
    const seenSequences=new Set<number>();
    for(const receipt of events[0]!.receipts) {
      requireProof(isStoredEventReceipt(receipt,scope)&&receipt.converge_target===target&&receipt.round===row.selector.round&&
        receipt.sequence<=events[0]!.eventSequence&&!receipts.has(receipt.id)&&!seenSequences.has(receipt.sequence));
      receipts.set(receipt.id,receipt);
      seenSequences.add(receipt.sequence);
    }
    try {
      requireProof(row.reportJson&&row.storedRun&&row.classifications?.length===1&&row.corrections&&row.correctionIds&&
        isDeepStrictEqual([...row.correctionIds!].sort(),row.corrections!.map(r => r.id).sort()));
      for(const receipt of [...row.classifications!,...row.corrections!])
        requireProof(isDeepStrictEqual(receipts.get(receipt.id),receipt));
      const source=validateOccurrenceSource({ scope,reportJson: row.reportJson!,storedRun: row.storedRun!,classification: row.classifications![0]!,corrections: row.corrections! });
      requireProof(source.digest===row.selector.reportSha256&&source.head===row.selector.headSha&&source.round===row.selector.round);
      validated.push(source);
      if(source.members.some(m => m.unresolvedReason))
        residuals.push({ reason: 'source_membership_ambiguous',runId: scope.run_id,round: source.round });
    }
    catch {
      residuals.push({ reason: 'source_evidence_unavailable',runId: scope.run_id,round: row.selector.round });
    }
  }
  for(const round of state.rounds) {
    const sources=validated.filter(s => s.round===round.round);
    if(!round.runId||sources.length!==1||sources[0]!.input.scope.run_id!==round.runId||round.reportBinding&&round.reportBinding.reportSha256!==sources[0]!.digest)
      residuals.push({ reason: 'native_predecessor_unavailable_or_ambiguous',round: round.round });
  }
  for(const row of history.sources)
    if(history.sources.filter(s => s.selector.round===row.selector.round).length!==1)
      residuals.push({ reason: 'source_round_ambiguous',round: row.selector.round });
  const actual=(receipt: StoredEventReceipt) => requireProof(isDeepStrictEqual(receipts.get(receipt.id),receipt));
  for(const anchor of anchors) {
    const receipt=receipts.get(anchor.receipt.id);
    requireProof(receipt&&isDeepStrictEqual(receipt,anchor.receipt));
  }
  const transfers=[...new Map(evidence.flatMap(e => e.transfers).map(p => [p.receipt.id,p])).values()];
  const dispositions=[...new Map(evidence.flatMap(e => e.dispositions).map(p => [p.receipt.id,p])).values()];
  for(const proof of [...transfers,...dispositions]) {
    actual(proof.receipt);
    actual(proof.preparation.split.receipt);
    actual(proof.preparation.split.source.classification);
    proof.preparation.split.source.corrections.forEach(actual);
  }
  const oldKeys=new Set(anchors.map(a => a.source.previousIdentity));
  const carriers: OccurrenceCarrierProjection[]=[];
  for(const source of validated) {
    const selector=history.sources.find(r => r.selector.scope.run_id===source.input.scope.run_id)!.selector;
    for(const key of oldKeys) {
      const kinds: OccurrenceCarrierSelector['kind'][]=[];
      if(source.members.some(m => m.identity===key||m.mapping?.matched_identity===key))
        kinds.push('classified_group');
      if(source.input.classification.payload.classification_version===1&&Array.isArray(source.input.classification.payload.legacy_pending_identities)&&
        source.input.classification.payload.legacy_pending_identities.includes(key))
        kinds.push('legacy_pending');
      for(const kind of kinds) {
        const carrier={ ...selector,classificationId: source.input.classification.id,identity: key,kind };
        const projected=projectOccurrenceCarrier({
          carrier,inventoryStatus: 'complete',sources: history.sources,transfers,
          nativePredecessors: [{ sourceJson,nativeSourceJsons }]
        });
        if(kind==='legacy_pending'&&!projected.occurrences.length) {
          projected.residuals.push({ reason: 'legacy-original-occurrence-unavailable' });
          projected.coverage='residuals-present';
        }
        carriers.push(projected);
      }
    }
  }
  const pending=new Set(Object.values(state.findings).filter(e => e.pendingRound!==undefined||e.claimDescriptor===undefined&&migratedLegacyPendingRound(e,state)!==undefined).map(e => e.key));
  for(const key of oldKeys) {
    const relevant=carriers.filter(c => c.carrier.identity===key);
    const complete=!residuals.length&&relevant.length>0&&relevant.every(c => c.occurrences.length>0&&!c.residuals.length&&c.occurrences.every(o => o.transferEventId));
    if(complete)
      pending.delete(key);
    else
      pending.add(key);
  }
  const claims: CurrentClaimProjection['claims']=[];
  const readContent={
    actorUserId: history.actorUserId,selections: history.sources.map(s => ({
      selection: s.selector,
      eventSequence: history.histories.find(h => h.runId===s.selector.scope.run_id)!.eventSequence,
      eventIds: history.histories.find(h => h.runId===s.selector.scope.run_id)!.receipts.map(r => r.id),
      receipts: history.histories.find(h => h.runId===s.selector.scope.run_id)!.receipts
    }))
  };
  for(const anchor of anchors) {
    // Version 1 is retained verbatim for immutable proof replay. New authenticated
    // snapshots use version 2 and the server's cross-run assertion chronology.
    const selected=validated.filter(source => projectionVersion===1||observationSource(source,anchor,receipts.get(anchor.receipt.id)!)).map(source => ({ source,
      members: source.members.filter(m => (projectionVersion===1? m.identity:m.mapping?.matched_identity)===anchor.identity) }));
    const conflicting=projectionVersion===2&&selected.some(s => s.members.some(m => !isDeepStrictEqual(m.raw.claimDescriptor,anchor.descriptor)));
    const observed=selected.flatMap(({ source,members }) => {
      const exact=members.filter(m => isDeepStrictEqual(m.raw.claimDescriptor,anchor.descriptor));
      return (projectionVersion===1? members.filter(m => m.gating!=='none'):
        exact.some(m => ['consensus','critical','verified'].includes(m.gating)&&m.stored.below_threshold===false)? exact:[])
        .map(member => ({ source,member }));
    });
    const allReceipts=history.histories.flatMap(h => h.receipts);
    const modeB=allReceipts.filter(r => r.kind==='finding_claim_disposition'&&r.payload.claim_identity===anchor.identity);
    const splitReceipt=receipts.get(anchor.receipt.id)!;
    const ordinary=allReceipts.filter(r => r.kind==='verdicts_recorded'&&Array.isArray(r.payload.verdicts)&&
      r.payload.verdicts.some(v => v&&typeof v==='object'&&(v as Record<string,unknown>).identity_key===anchor.identity));
    const ordinaryProven=projectionVersion===1||ordinary.every(r => ordinaryDecisionProven(r,anchor,splitReceipt,validated,allReceipts));
    const legacyModeB=modeB.slice().sort((a,b) => a.sequence-b.sequence).at(-1);
    const legacyOrdinary=ordinary.filter(r => r.run_id===anchor.source.runId&&r.round===anchor.source.round&&
      r.sequence>splitReceipt.sequence&&time(r.received_at)>=time(splitReceipt.received_at)).sort((a,b) => a.sequence-b.sequence).at(-1);
    const { latest,ambiguous }=projectionVersion===1?
      { latest: legacyOrdinary&&(!legacyModeB||legacyOrdinary.sequence>legacyModeB.sequence)? legacyOrdinary:legacyModeB,ambiguous: false }:
      latestDecision([...modeB,...ordinary]);
    const proof=latest?.kind==='finding_claim_disposition'? dispositions.find(p => p.receipt.id===latest.id):undefined;
    const ordinaryEntries=latest?.kind==='verdicts_recorded'? latest.payload.verdicts as Record<string,unknown>[]:[];
    const ordinaryEntry=ordinaryEntries.find(v => v.identity_key===anchor.identity);
    const validOrdinary=!!ordinaryEntry&&(projectionVersion===2? ordinaryProven:
      uuidSchema.safeParse(latest!.actor_user_id).success&&
      ordinaryEntries.every(v => v&&typeof v==='object'&&typeof v.identity_key==='string')&&
      new Set(ordinaryEntries.map(v => v.identity_key)).size===ordinaryEntries.length&&
      ['fixed','dismissed'].includes(ordinaryEntry.verdict as string)&&['critical','important','minor','nitpick'].includes(ordinaryEntry.severity as string)&&
      typeof ordinaryEntry.reason==='string'&&ordinaryEntry.reason.trim().length>0);
    const gated=anchor.source.gating!=='none'||observed.length>0||conflicting;
    let standing: CurrentClaimProjection['claims'][number]['standing']=gated? 'pending':'nongating';
    const reasons: string[]=[];
    if(gated&&(proof||validOrdinary)&&ordinaryProven&&!ambiguous&&!residuals.length) {
      const p=proof?.preparation??ordinaryEntry!;
      const assertion=proof? (proof.preparation.mode==='preserved'? proof.preparation.originalVerdict!:proof.receipt):latest!;
      actual(assertion);
      const before=observed.filter(o => time(o.source.input.classification.received_at)<=time(assertion.received_at)).sort((a,b) => b.source.round-a.source.round);
      const severitySources=projectionVersion===1? before:observed;
      const round=severitySources.length? Math.max(...severitySources.map(o => o.source.round)):undefined;
      const severity=round===undefined? anchor.source.severity:['critical','important','minor','nitpick'].find(s => severitySources.some(o => o.source.round===round&&o.member.severity===s));
      const criticalMismatch=severity==='critical'&&p.severity!=='critical';
      const adverse=observed.filter(o => time(o.source.input.classification.received_at)>=time(assertion.received_at));
      const regated=projectionVersion===2? p.verdict==='dismissed'&&adverse.length>0:observed.some(o => time(o.source.input.classification.received_at)>time(assertion.received_at)&&
        (o.member.mapping?.status==='regating'||o.member.mapping?.status==='new'||o.member.severity==='critical'&&p.severity!=='critical'));
      if(conflicting)
        reasons.push('claim_binding_unproven');
      else if(criticalMismatch)
        reasons.push('critical_disposition_required');
      else if(regated)
        reasons.push('adverse_later_sighting');
      else if(p.verdict==='dismissed')
        standing='dismissed';
      else {
        const witness=history.sources.some(source => {
          if(source.classifications?.length!==1||projectionVersion===2&&
            (source.selector.round<=Math.max(latest!.round!,...before.map(o => o.source.round))||
              observed.some(o => o.source.round===source.selector.round)||
              adverse.some(o => o.source.round>=source.selector.round)))
            return false;
          const candidate={
            actorUserId: history.actorUserId,inventory: {
              carrier: { ...source.selector,kind: 'classified_group' as const,classificationId: source.classifications[0]!.id,identity: anchor.identity },
              inventoryStatus: 'complete' as const,sources: [source]
            },runSequences: history.histories.map(h => ({ runId: h.runId,eventSequence: h.eventSequence }))
          };
          if(proof)
            return replayRecoveryConfirmation(proof,candidate,readContent);
          const own=history.sources.find(s => s.selector.scope.run_id===(projectionVersion===1? anchor.source.runId:latest!.run_id))!;
          return replayEligibleConfirmationCandidate({
            ...own.selector,actorUserId: history.actorUserId,
            eventSequence: history.histories.find(h => h.runId===own.selector.scope.run_id)!.eventSequence
          },anchor.identity,{ eventId: assertion.id,actorUserId: assertion.actor_user_id,occurredAt: assertion.occurred_at,receivedAt: assertion.received_at,sequence: assertion.sequence },candidate);
        });
        if(witness)
          standing='confirmed-fixed';
        else
          reasons.push('eligible_confirmation_unavailable');
      }
    }
    else if(gated)
      reasons.push(residuals.length? 'current_source_inventory_unresolved':ambiguous? 'ambiguous_decision_order':
        !ordinaryProven? 'ordinary_verdict_receipt_unproven':latest? 'disposition_proof_unavailable':'explicit_disposition_required');
    if(standing==='pending')
      pending.add(anchor.identity);
    else
      pending.delete(anchor.identity);
    claims.push({ identity: anchor.identity,standing,dispositionEventId: latest?.id??null,reasons });
  }
  return structuredClone({
    version: projectionVersion,nativeFingerprint: nativeProjectionFingerprint(state),history,
    actionableIdentities: [...pending].sort(),carriers,claims,residuals
  });
}
