import { isDeepStrictEqual } from 'node:util';
import type { ReviewResult } from '../../consensus/types.js';
import { stableStringify } from '../../report/run-header.js';
import { buildRunEnvelope } from '../../telemetry/envelope.js';
import { originalRunReportSchema } from '../../telemetry/recovery/source.js';
import { decodeRecoveryOriginal as decodeOriginalReport } from './validation/recovery-json.js';
import { authenticatedReceiptContent, type AuthenticatedSelectedReceipts, type AuthenticatedReceiptContent } from './authenticated-receipts.js';
import { carrierInventoryContent, type AuthenticatedCarrierInventory, type CarrierInventoryContent } from './carrier-inventory.js';
import { prepareClaimDisposition } from './validation/occurrence.js';
import { hash, validateOccurrenceSource } from './validation/occurrence-source.js';
import { instant, object } from './validation/primitives.js';
import { isStoredEventReceipt, matchesPreparedEventReceipt, type StoredEventReceipt } from './validation/receipts.js';
import type { AcceptedClaimDisposition } from './validation/native-occurrences.js';
import type { CarrierSourceInventory } from './validation/carrier-types.js';
import type { OccurrenceSource, OccurrenceContext, ReceiptAttribution } from './validation/occurrence-types.js';

/** A historical witness. It does not establish the current claim or gate state. */
export interface RecoveryConfirmation { readonly qualification: 'authenticated-confirmation-source' }
export interface RecoveryConfirmationContent {
  actorUserId: string;
  claimIdentity: string;
  disposition: AcceptedClaimDisposition;
  assertion: ReceiptAttribution;
  source: CarrierSourceInventory;
  sourceEventSequence: number;
  health: { blocking: number; successful: number; required: number };
  claimStanding: 'not-evaluated';
  /** Matching sightings remain visible for the complete obligation projection. */
  sightings: Array<{ findingRef: string; severity: string; gating: string; status: string; pendingRound: number | null }>;
  receiptCutoff: string | null;
}
const accepted = new WeakMap<RecoveryConfirmation, RecoveryConfirmationContent>();
export function recoveryConfirmationContent(witness: RecoveryConfirmation): RecoveryConfirmationContent {
  const content = accepted.get(witness);
  if (!content) throw new Error('unverified_recovery_confirmation');
  return structuredClone(content);
}
const requireEvidence = (value: unknown): void => { if (!value) throw new Error('confirmation_source_conflict'); };
const time = (value: unknown): bigint => BigInt(instant(value));
const attribution = (r: StoredEventReceipt): ReceiptAttribution => ({ eventId: r.id, actorUserId: r.actor_user_id,
  occurredAt: r.occurred_at, receivedAt: r.received_at, sequence: r.sequence });
const callKeys = ['model', 'role', 'provider', 'lane', 'chunk_index', 'status', 'duration_ms', 'input_tokens',
  'output_tokens', 'reasoning_tokens', 'dropped_findings', 'warnings', 'error', 'async'];
const headerKeys = ['id', 'command', 'rcl_version', 'config_sha256', 'roster', 'thresholds', 'gating',
  'spec', 'context_files', 'plan', 'runner', 'duration_ms', 'ci_exit_code'];
function fields(row: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [key, (row as Record<string, unknown>)[key] ?? null]));
}

/**
 * Qualify an actual later review against an authenticated fixed assertion.
 * Both inputs must come from the bounded readers. A witness never retires a
 * carrier, selects the latest disposition, clears a re-gating sighting, or
 * approves a head: those require the complete current obligation projection.
 * A supplied receipt cutoff applies to every receipt used by this witness.
 */
export function qualifyRecoveryConfirmation(proof: AcceptedClaimDisposition, inventory: AuthenticatedCarrierInventory,
  receipts: AuthenticatedSelectedReceipts, receiptCutoff?: string):
  { kind: 'eligible'; value: RecoveryConfirmation } | { kind: 'ineligible'; reason: 'confirmation_source_conflict' } {
  try {
    const content = replayRecoveryConfirmation(proof, carrierInventoryContent(inventory), authenticatedReceiptContent(receipts), receiptCutoff);
    if (!content) return {kind:'ineligible',reason:'confirmation_source_conflict'};
    const value=Object.freeze({qualification:'authenticated-confirmation-source' as const});accepted.set(value,content);
    return {kind:'eligible',value};
  } catch {return {kind:'ineligible',reason:'confirmation_source_conflict'};}
}

/** Content replay used when validating retained proof; this function does not
 * authenticate transport or grant native mutation authority. */
export function replayRecoveryConfirmation(proof:AcceptedClaimDisposition,candidates:CarrierInventoryContent,
  reads:AuthenticatedReceiptContent,receiptCutoff?:string):RecoveryConfirmationContent|null {
  try {
    proof = structuredClone(proof);
    const p = proof.preparation;
    const prepared = prepareClaimDisposition(p);
    requireEvidence(p.verdict === 'fixed' && proof.actorUserId === p.actorUserId &&
      reads.actorUserId === candidates.actorUserId && candidates.inventory.inventoryStatus === 'complete');
    const cutoff = receiptCutoff === undefined ? undefined : time(receiptCutoff);
    const beforeCutoff = (received: unknown) => requireEvidence(cutoff === undefined || time(received) <= cutoff);
    const verified = new Map(reads.selections.flatMap(s => s.receipts.map(r => [r.id, r] as const)));
    const requireReceipt = (r: StoredEventReceipt) => {
      requireEvidence(isDeepStrictEqual(verified.get(r.id), r)); beforeCutoff(r.received_at);
    };
    const sources: OccurrenceSource[] = [p.split.source, ...p.laterSources ?? []];
    for (const source of sources) {
      const bound = validateOccurrenceSource(source);
      const selected = reads.selections.find(s => s.selection.scope.run_id === source.scope.run_id);
      requireEvidence(selected && isDeepStrictEqual(fields(selected.selection, ['scope', 'target', 'round', 'reportSha256', 'headSha']), { scope: source.scope,
        target: bound.target, round: bound.round, reportSha256: bound.digest, headSha: bound.head }));
      for (const r of [source.classification, ...source.corrections]) requireReceipt(r);
    }
    for (const r of [proof.receipt, p.split.receipt, ...(p.originalVerdict ? [p.originalVerdict] : []),
      ...(p.previousDisposition ? [p.previousDisposition] : [])]) requireReceipt(r);
    requireEvidence(isStoredEventReceipt(proof.receipt, p.sourceContext.scope) &&
      matchesPreparedEventReceipt(proof.receipt, JSON.stringify(prepared.event), p.sourceContext.scope, proof.actorUserId) &&
      proof.receipt.sequence > p.sourceContext.eventSequence &&
      time(proof.receipt.received_at) >= time(p.split.receipt.received_at) &&
      sources.flatMap(s => [s.classification, ...s.corrections]).every(r => time(r.received_at) <= time(proof.receipt.received_at)));
    const assertion = prepared.assertionReceipt.kind === 'preserved' ? prepared.assertionReceipt.receipt : attribution(proof.receipt);
    const candidate=replayEligibleConfirmationCandidate(p.sourceContext,p.split.selection.identity,assertion,candidates,receiptCutoff);
    return candidate?{...candidate,disposition:proof}:null;
  } catch { return null; }
}

/** Replay one candidate against an already attributed assertion. Pure content
 * checking only: callers must authenticate the complete source and receipt view. */
export function replayEligibleConfirmationCandidate(context:OccurrenceContext,claimIdentity:string,assertion:ReceiptAttribution,
  candidates:CarrierInventoryContent,receiptCutoff?:string):Omit<RecoveryConfirmationContent,'disposition'>|null {
  try {
    const cutoff=receiptCutoff===undefined?undefined:time(receiptCutoff);
    const beforeCutoff=(received:unknown)=>requireEvidence(cutoff===undefined||time(received)<=cutoff);
    beforeCutoff(assertion.receivedAt);
    const floor = time(assertion.receivedAt);
    const own = candidates.inventory;
    requireEvidence(own.carrier.kind === 'classified_group' && own.sources.length === 1);
    const source = own.sources[0]!;
    const selection = source.selector;
    requireEvidence(selection.scope.base_url === context.scope.base_url && selection.scope.org_id === context.scope.org_id &&
      selection.scope.repo.toLowerCase() === context.scope.repo.toLowerCase() &&
      selection.scope.pr_number === context.scope.pr_number && selection.target === context.target &&
      selection.round > context.round && selection.scope.run_id !== context.scope.run_id &&
      typeof source.reportJson === 'string' && source.storedRun && source.classifications?.length === 1 && source.corrections &&
      source.correctionIds && isDeepStrictEqual([...source.correctionIds].sort(), source.corrections.map(r => r.id).sort()));
    const classification = source.classifications![0]!;
    requireEvidence(classification.id === own.carrier.classificationId && classification.payload.classification_version === 1);
    const bound = validateOccurrenceSource({ scope: selection.scope, reportJson: source.reportJson!, storedRun: source.storedRun!,
      classification, corrections: source.corrections! });
    requireEvidence(bound.digest === selection.reportSha256 && bound.head === selection.headSha &&
      bound.target === selection.target && bound.round === selection.round);
    const raw = decodeOriginalReport(source.reportJson!, { exactNumbers: true, originalProse: 'control-code-units-v1' });
    requireEvidence(originalRunReportSchema.safeParse(raw.value).success);
    const report = raw.value as ReviewResult & { run: NonNullable<ReviewResult['run']> };
    const run = source.storedRun!;
    const envelope = buildRunEnvelope(report, { report_json: source.reportJson! }, { level: 'full', delivery: { mode: 'direct' } });
    requireEvidence(isDeepStrictEqual(envelope.run, report.run) &&
      isDeepStrictEqual(fields(run, headerKeys), fields(report.run, headerKeys)) &&
      run.repo_verified === true && run.is_cross_repository === false && run.provenance === 'live' &&
      (report.run.provenance === undefined || report.run.provenance === 'live') &&
      time(run.started_at) === time(report.run.started_at) && time(run.finished_at) === time(report.run.finished_at) &&
      time(run.started_at) > floor && time(run.finished_at) >= time(run.started_at) &&
      time(run.received_at) >= time(run.finished_at) && time(run.received_at) > floor &&
      time(classification.received_at) >= time(run.received_at) && time(classification.received_at) > floor);
    beforeCutoff(run.received_at);
    for (const r of [classification, ...source.corrections!]) beforeCutoff(r.received_at);
    requireEvidence(Array.isArray(run.calls) && run.calls.every(c => object(c) && callKeys.every(k => Object.hasOwn(c, k))));
    const storedCalls = run.calls as Record<string, unknown>[];
    const canonical = (rows: object[]) => rows.map(r => stableStringify(fields(r, callKeys))).sort();
    requireEvidence(isDeepStrictEqual(canonical(storedCalls), canonical(envelope.calls)));
    const blocking = envelope.calls.filter(c => c.lane === 'blocking');
    const successful = blocking.filter(c => c.status === 'success').length;
    const required = Math.max(2, Math.ceil(2 * blocking.length / 3));
    requireEvidence(blocking.length >= 2 && successful >= required && hash(source.reportJson!) === selection.reportSha256);
    return structuredClone({ actorUserId: candidates.actorUserId, claimIdentity: claimIdentity,
      assertion, source, sourceEventSequence: candidates.runSequences.find(r => r.runId === selection.scope.run_id)!.eventSequence,
      health: { blocking: blocking.length, successful, required }, claimStanding: 'not-evaluated' as const,
      sightings: bound.members.filter(m => m.identity === claimIdentity).map(m => ({ findingRef: m.ref,
        severity: m.severity, gating: m.gating, status: m.mapping!.status as string, pendingRound: m.mapping!.pending_round as number | null })),
      receiptCutoff: receiptCutoff ?? null });
  } catch { return null; }
}
