import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { claimDescriptorSchema } from '../../consensus/claim-identity.js';
import { uuidSchema } from './validation/primitives.js';
import { validateOccurrenceSource } from './validation/occurrence-source.js';
import type { ClaimHistoryContent } from './carrier-inventory.js';
import type { OccurrenceSource,OccurrenceContext } from './validation/occurrence-types.js';
import type { OccurrenceCarrierSelector,OccurrenceRunSelector } from './validation/carrier-types.js';
import type { StoredEventReceipt } from '../event-receipts.js';
import { matchesPreparedEventReceipt } from '../event-receipts.js';
import { object } from './validation/primitives.js';
const key=z.string().regex(/^[a-f0-9]{16}$/);
export const sourceSelectionSchema=z.object({
  scope: z.object({ base_url: z.string(),org_id: uuidSchema,run_id: uuidSchema,repo: z.string(),pr_number: z.number().int().positive() }).strict(),
  target: z.string().min(1).max(500),round: z.number().int().positive(),headSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const publicClaimSelectionSchema=z.object({
  version: z.literal(1),action: z.enum(['split','disposition','refresh']).default('split'),source: sourceSelectionSchema,findingRef: z.string().regex(/^f\d{3,}$/),
  previousIdentity: key,identity: key,descriptor: claimDescriptorSchema,reason: z.string().min(1),
  disposition: z.object({
    mode: z.enum(['fresh','preserved']),verdict: z.enum(['fixed','dismissed']),
    severity: z.enum(['critical','important','minor','nitpick']),reason: z.string().min(1),originalVerdictEventId: uuidSchema.optional()
  }).strict().optional(),
}).strict();
export type PublicClaimSelection=z.infer<typeof publicClaimSelectionSchema>;
export function runSelector(selection: OccurrenceRunSelector): OccurrenceRunSelector {
  const { scope,target,round,headSha,reportSha256 }=selection;
  return { scope,target,round,headSha,reportSha256 };
}
export function historySource(content: ClaimHistoryContent,selection: OccurrenceRunSelector): OccurrenceSource {
  selection=runSelector(selection);
  const rows=content.sources.filter(s => isDeepStrictEqual(s.selector,selection));
  if(rows.length!==1)
    throw new Error('claim_source_selection_conflict');
  const row=rows[0]!;
  if(!row.reportJson||!row.storedRun||row.classifications?.length!==1||!row.corrections||!row.correctionIds||
    !isDeepStrictEqual([...row.correctionIds].sort(),row.corrections.map(r => r.id).sort()))
    throw new Error('claim_source_material_unavailable');
  const source={ scope: selection.scope,reportJson: row.reportJson,storedRun: row.storedRun,classification: row.classifications[0]!,corrections: row.corrections };
  validateOccurrenceSource(source);
  return source;
}
export function historyContext(content: ClaimHistoryContent,selection: OccurrenceRunSelector): OccurrenceContext {
  const rows=content.histories.filter(h => h.runId===selection.scope.run_id);
  if(rows.length!==1)
    throw new Error('claim_context_unavailable');
  return { ...runSelector(selection),actorUserId: content.actorUserId,eventSequence: rows[0]!.eventSequence };
}
export function claimCarriers(content: ClaimHistoryContent,selection: PublicClaimSelection): OccurrenceCarrierSelector[] {
  const carriers: OccurrenceCarrierSelector[]=[];
  for(const row of content.sources) {
    // Missing/ambiguous sources stay in the complete inventory as residuals;
    // they never manufacture a transferable carrier.
    let source: OccurrenceSource;
    try {
      source=historySource(content,row.selector);
    }
    catch {
      continue;
    }
    const valid=validateOccurrenceSource(source);
    if(row.selector.scope.run_id===selection.source.scope.run_id&&valid.members.some(m => m.ref===selection.findingRef&&m.identity===selection.previousIdentity&&!m.unresolvedReason)) {
      carriers.push({ ...row.selector,kind: 'classified_group',classificationId: source.classification.id,identity: selection.previousIdentity });
    }
    const payload=source.classification.payload;
    if(payload.classification_version===1&&Array.isArray(payload.legacy_pending_identities)&&
      payload.legacy_pending_identities.includes(selection.previousIdentity)&&row.selector.round>=selection.source.round) {
      carriers.push({ ...row.selector,kind: 'legacy_pending',classificationId: source.classification.id,identity: selection.previousIdentity });
    }
  }
  return carriers.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
/** Own planned receipts may extend the preview; any other change needs a new
 * operator-reviewed preview. Comparing complete material prevents a newer
 * classification/correction from silently changing an original selector. */
export function assertHistoryExtension(before: ClaimHistoryContent,after: ClaimHistoryContent,owned: Map<string,string>): void {
  if(before.actorUserId!==after.actorUserId||before.sources.length!==after.sources.length||before.histories.length!==after.histories.length)
    throw new Error('claim_history_changed_since_preview');
  const acceptedSplits: StoredEventReceipt[]=[];
  for(const old of before.histories) {
    const current=after.histories.find(h => h.runId===old.runId);
    if(!current||current.eventSequence<old.eventSequence)
      throw new Error('claim_history_changed_since_preview');
    for(const receipt of old.receipts)
      if(!isDeepStrictEqual(receipt,current.receipts.find(r => r.id===receipt.id)))
        throw new Error('claim_history_changed_since_preview');
    const extra=current.receipts.filter(r => !old.receipts.some(o => o.id===r.id));
    if(extra.some(r => !owned.has(r.id)))
      throw new Error('claim_history_changed_since_preview');
    const sources=before.sources.filter(source=>source.selector.scope.run_id===old.runId);
    for(const receipt of extra) {
      if(sources.length!==1||!matchesPreparedEventReceipt(receipt,owned.get(receipt.id)!,sources[0]!.selector.scope,before.actorUserId))
        throw new Error('claim_receipt_conflict');
      if(receipt.kind==='finding_claim_split') acceptedSplits.push(receipt);
    }
    if(current.eventSequence!==Math.max(old.eventSequence,...extra.map(r => r.sequence)))
      throw new Error('claim_sequence_changed_since_preview');
  }
  for(const [index,source] of before.sources.entries()) {
    const current=after.sources[index]!;
    if(isDeepStrictEqual(source,current)) continue;
    const expected=structuredClone(source);
    for(const receipt of acceptedSplits.filter(r=>r.run_id===source.selector.scope.run_id)) {
      const payload=receipt.payload;
      if(receipt.converge_target!==source.selector.target||receipt.round!==source.selector.round||
        payload.report_json_sha256!==source.selector.reportSha256||!Array.isArray(expected.storedRun?.findings))
        throw new Error('claim_history_changed_since_preview');
      const findings=expected.storedRun.findings.filter(f=>object(f)&&f.ref===payload.finding_ref);
      if(findings.length!==1) throw new Error('claim_history_changed_since_preview');
      // The backend projects these two fields from the immutable split receipt.
      // Never discard derived fields: require their complete expected values,
      // retaining strict equality for every original field, artifact and receipt.
      Object.assign(findings[0],{
        claim_identity: payload.matched_identity,
        identity_provenance: {
          source: 'semantic_split',event_id: receipt.id,actor_user_id: receipt.actor_user_id,
          reason: payload.reason,previous_identity: payload.previous_identity,
          report_json_sha256: payload.report_json_sha256,claim_descriptor: payload.claim_descriptor,
          native_evidence: payload.native_evidence,source_event_ids: payload.source_event_ids,
          received_at: receipt.received_at
        }
      });
      // Accepted splits reserve an unused destination. FindingVerdicts now
      // requires that claim's own run/round verdict; the old co-key verdict
      // cannot follow it. Other kinds of verdict changes remain unexplained.
      if(Object.hasOwn(findings[0],'verdict')) findings[0].verdict=null;
    }
    if(!isDeepStrictEqual(expected,current)) throw new Error('claim_history_changed_since_preview');
  }
}
export function uniqueReceipts(rows: StoredEventReceipt[]): StoredEventReceipt[] {
  const result=new Map<string,StoredEventReceipt>();
  for(const row of rows) {
    const old=result.get(row.id);
    if(old&&!isDeepStrictEqual(old,row))
      throw new Error('claim_receipt_conflict');
    result.set(row.id,row);
  }
  return [...result.values()];
}

/** Detect occupied destinations in the authenticated read scope. The server's
 * transaction remains authoritative for histories outside this target. */
export function assertUnusedClaimIdentity(content: ClaimHistoryContent, identity: string): void {
  const includesKey = (rows: unknown, field: string): boolean => Array.isArray(rows) &&
    rows.some(row => row !== null && typeof row === 'object' && !Array.isArray(row) &&
      (row as Record<string, unknown>)[field] === identity);
  const finding = content.sources.some(source => includesKey(source.storedRun?.findings, 'identity_key'));
  const event = content.histories.some(history => history.receipts.some(receipt => {
    if (receipt.kind === 'finding_claim_split') return receipt.payload.matched_identity === identity;
    if (receipt.kind === 'verdicts_recorded') return includesKey(receipt.payload.verdicts, 'identity_key');
    if (receipt.kind === 'round_processed') return includesKey(receipt.payload.identities, 'matched_identity');
    return false;
  }));
  if (finding || event) throw new Error('claim_identity_already_used');
}
