import { isDeepStrictEqual } from 'node:util';
import type { HarnessSink, SinkOutcome } from '../../telemetry/sink.js';
import { readClaimEventIndex, claimEventSelector, type ClaimEventSelector } from './claim-index.js';
import type { StoredEventReceipt } from '../event-receipts.js';
import { readEventReceipts } from '../event-receipts.js';
import { object, uuidSchema } from './validation/primitives.js';
import { isEventReceiptScope } from './validation/receipts.js';
import type { CarrierSourceInventory, OccurrenceCarrierSelector, OccurrenceRunSelector } from './validation/carrier-types.js';
import type { NativeCarrierInventory } from './validation/native-occurrences.js';
import { MAX_CARRIER_INVENTORY, MAX_CARRIER_PREFIX_ROUNDS } from './validation/carrier-projection.js';

/** A live read token. Serialized/caller-supplied objects cannot recreate it. */
export interface AuthenticatedCarrierInventory { readonly qualification: 'authenticated-carrier-inventory-read' }
export interface CarrierInventoryContent {
  actorUserId: string;
  inventory: NativeCarrierInventory;
  runSequences: Array<{ runId: string; eventSequence: number }>;
}
export const MAX_CARRIER_READ_BYTES = 64 * 1024 * 1024;
const accepted = new WeakMap<AuthenticatedCarrierInventory, CarrierInventoryContent>();

/** Return defensive content, never a persisted flag authorizing native mutation. */
export function carrierInventoryContent(read: AuthenticatedCarrierInventory): CarrierInventoryContent {
  const content = accepted.get(read);
  if (!content) throw new Error('unverified_carrier_inventory');
  return structuredClone(content);
}

interface ListedRun { id: string; target: Record<string, unknown>; converge: Record<string, unknown> | null }
interface RunView {
  data: Record<string, unknown>;
  recovery: Record<string, unknown>;
  source: CarrierSourceInventory;
  bytes: number;
  stored: boolean;
  sequence: number;
  classificationId: string | null;
  correctionIds: string[];
  eventSelectors: Array<{ id: string; sequence: number; kind: string }>;
}
type ReadError = Exclude<SinkOutcome<never>, { kind: 'ok' }>;
class FailedRead extends Error { constructor(readonly result: ReadError) { super('carrier_inventory_read_failed'); } }
function conflict(message: string): never { throw new FailedRead({ kind: 'conflict', message }); }
function value<T>(result: SinkOutcome<T>): T { if (result.kind !== 'ok') throw new FailedRead(result); return result.value; }
const uuid = (x: unknown): x is string => uuidSchema.safeParse(x).success;
const count = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const sha = (x: unknown): x is string => typeof x === 'string' && x.length === 64 && /^[a-f0-9]{64}$/.test(x);
const head = (x: unknown): x is string => typeof x === 'string' && [40, 64].includes(x.length) && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(x) && !/^0+$/.test(x);
function scopedTarget(target: unknown, carrier: OccurrenceCarrierSelector): target is Record<string, unknown> {
  return object(target) && typeof target.repo === 'string' && target.repo.toLowerCase() === carrier.scope.repo.toLowerCase() &&
    target.pr_number === carrier.scope.pr_number;
}

async function listRuns(sink: HarnessSink, carrier: OccurrenceCarrierSelector): Promise<ListedRun[]> {
  const rows: ListedRun[] = []; let total: number | undefined; let pages = 1;
  for (let page = 1; page <= Math.max(pages, 1); page++) {
    const query = new URLSearchParams({ repo: carrier.scope.repo, pr: String(carrier.scope.pr_number),
      page: String(page), page_size: '100', order_by: 'received_at', order_dir: 'asc' });
    const answer = value(await sink.getJson(`/api/v1/reviews/runs?${query}`, (data, meta) => {
      if (!object(meta) || meta.org_id !== carrier.scope.org_id || meta.evidence_protocol_version !== 2 ||
          meta.page !== page || meta.page_size !== 100 || !count(meta.total) || meta.total > MAX_CARRIER_INVENTORY ||
          meta.total_pages !== Math.ceil(meta.total / 100) || !Array.isArray(data) ||
          data.length !== Math.min(100, Math.max(0, meta.total - (page - 1) * 100))) return null;
      const runs: ListedRun[] = [];
      for (const row of data) {
        if (!object(row) || !uuid(row.id) || !scopedTarget(row.target, carrier) ||
            !(row.converge === null || object(row.converge) && typeof row.converge.target === 'string' &&
              row.converge.target.trim() === row.converge.target && row.converge.target.length > 0 &&
              count(row.converge.round) && row.converge.round > 0)) return null;
        runs.push({ id: row.id, target: row.target, converge: row.converge });
      }
      return { runs, total: meta.total, pages: meta.total_pages as number };
    }, { requireCompleteRead: true }));
    if (total !== undefined && total !== answer.total) conflict('carrier_inventory_pagination_changed');
    total = answer.total; pages = answer.pages; rows.push(...answer.runs);
  }
  if (rows.length !== total || new Set(rows.map(r => r.id)).size !== rows.length) conflict('carrier_inventory_duplicate_or_missing_run');
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function runView(sink: HarnessSink, carrier: OccurrenceCarrierSelector, listed: ListedRun, actor: string, fullHistory = false): Promise<RunView> {
  return value(await sink.getJson(`/api/v1/reviews/runs/${listed.id}`, (data, meta) => {
    if (!object(meta) || meta.org_id !== carrier.scope.org_id || meta.actor_user_id !== actor ||
        meta.evidence_protocol_version !== 2 || meta.claim_recovery_version !== 1 || !object(meta.recovery) ||
        (fullHistory ? typeof meta.recovery.truncated !== 'boolean' : meta.recovery.truncated !== false) || !count(meta.recovery.event_sequence) ||
        !object(data) || data.id !== listed.id || !scopedTarget(data.target, carrier) ||
        !['pr', 'patch'].includes(data.target.kind as string) || !head(data.target.head_sha) ||
        !isDeepStrictEqual(data.target, listed.target) || !isDeepStrictEqual(data.converge, listed.converge) ||
        !object(data.converge) || !count(data.converge.round) || data.converge.round < 1 ||
        data.converge.target !== carrier.target || !Array.isArray(data.artifacts)) return null;
    const artifacts = data.artifacts.filter(a => object(a) && a.kind === 'report_json');
    if (artifacts.length !== 1 || !sha(artifacts[0].declared_sha256) || !count(artifacts[0].declared_bytes) ||
        artifacts[0].declared_bytes > 25_000_000 || typeof artifacts[0].stored !== 'boolean') return null;
    const sequence = meta.recovery.event_sequence;
    const recovery = meta.recovery; const classification = recovery.classification_event;
    if (!(classification === null || object(classification) && uuid(classification.id) && count(classification.sequence) &&
        classification.sequence > 0 && classification.sequence <= sequence && classification.round === data.converge.round) ||
        !Array.isArray(recovery.native_corrections) || recovery.native_corrections.length > MAX_CARRIER_INVENTORY) return null;
    const corrections: string[] = [];
    const eventSelectors = classification === null ? [] : [{ id: classification.id as string,
      sequence: classification.sequence as number, kind: 'round_processed' }];
    for (const correction of recovery.native_corrections) {
      if (!object(correction) || !uuid(correction.id) || !count(correction.sequence) || correction.sequence < 1 ||
          correction.sequence > sequence || corrections.includes(correction.id) ||
          classification !== null && correction.id === classification.id) return null;
      if (eventSelectors.some(event => event.sequence === correction.sequence)) return null;
      corrections.push(correction.id);
      eventSelectors.push({ id: correction.id, sequence: correction.sequence, kind: 'finding_identity_corrected' });
    }
    return { data, recovery, sequence,
      classificationId: classification === null ? null : classification.id as string,
      correctionIds: corrections, eventSelectors, bytes: artifacts[0].declared_bytes as number, stored: artifacts[0].stored as boolean,
      source: { selector: { scope: { ...carrier.scope, repo: data.target.repo as string, run_id: listed.id },
        target: carrier.target, round: data.converge.round, headSha: data.target.head_sha,
        reportSha256: artifacts[0].declared_sha256 }, reportJson: null, storedRun: data,
        classifications: [], correctionIds: corrections, corrections: [] } };
  }, { requireCompleteRead: true }));
}

async function material(sink: HarnessSink, view: RunView): Promise<void> {
  const source = view.source;
  if (view.stored) {
    const read = value(await sink.getArtifact(source.selector.scope.run_id, 'report_json', view.bytes));
    if (read.sha256 !== source.selector.reportSha256 || read.bytes.length !== view.bytes) conflict('carrier_inventory_artifact_changed');
    const report = read.bytes.toString('utf8');
    if (!Buffer.from(report, 'utf8').equals(read.bytes)) conflict('carrier_inventory_invalid_utf8');
    source.reportJson = report;
  }
  const ids = [...(view.classificationId ? [view.classificationId] : []), ...view.correctionIds];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const read = value(await readEventReceipts(sink, source.selector.scope, ids.slice(offset, offset + 50)));
    for (const receipt of read.receipts) {
      const selector = view.eventSelectors.find(event => event.id === receipt.id);
      if (!selector || receipt.sequence !== selector.sequence || receipt.kind !== selector.kind ||
          receipt.sequence > view.sequence || receipt.converge_target !== source.selector.target || receipt.round !== source.selector.round) {
        conflict('carrier_inventory_receipt_selector_conflict');
      }
      if (receipt.id === view.classificationId) source.classifications!.push(receipt);
      else source.corrections!.push(receipt);
    }
  }
}

/**
 * Enumerate the exact PR's retained original sources and selected receipts. All
 * initial contexts precede material reads; all final contexts and re-enumeration
 * follow them. This authenticates a stable read window, never global historical
 * absence, carrier retirement, disposition standing or permission to mutate.
 * Missing source parts remain explicit inputs to the residual projection.
 */
export async function readCarrierInventory(sink: HarnessSink, carrier: OccurrenceCarrierSelector,
  actorUserId: string): Promise<SinkOutcome<AuthenticatedCarrierInventory>> {
  if (!carrier || !isEventReceiptScope(carrier.scope) || !uuid(actorUserId) || !uuid(carrier.classificationId) ||
      !head(carrier.headSha) || !sha(carrier.reportSha256) || !/^[a-f0-9]{16}$/.test(carrier.identity) ||
      !['classified_group', 'legacy_pending'].includes(carrier.kind) || !count(carrier.round) || carrier.round < 1 ||
      carrier.round > MAX_CARRIER_PREFIX_ROUNDS || typeof carrier.target !== 'string' ||
      !carrier.target || carrier.target.trim() !== carrier.target || carrier.target.length > 500) {
    throw new Error('invalid_carrier_inventory_selection');
  }
  carrier = structuredClone(carrier);
  if (sink.credentialSource === 'attest') throw new Error('unsupported_attested_recovery');
  if (sink.baseUrl !== carrier.scope.base_url) throw new Error('carrier_inventory_destination_conflict');
  try {
    const listed = await listRuns(sink, carrier);
    const selected = listed.filter(run => {
      if (carrier.kind === 'classified_group') return run.id === carrier.scope.run_id;
      if (run.converge?.target !== carrier.target) return false;
      if (!count(run.converge.round) || run.converge.round < 1) conflict('carrier_inventory_invalid_round');
      return run.converge.round <= carrier.round;
    });
    if (!selected.some(run => run.id === carrier.scope.run_id)) conflict('carrier_inventory_carrier_unavailable');
    const views: RunView[] = []; let retainedBytes = 0;
    for (const run of selected) {
      const view = await runView(sink, carrier, run, actorUserId);
      retainedBytes += view.bytes + Buffer.byteLength(JSON.stringify([view.data, view.recovery]), 'utf8');
      if (retainedBytes > MAX_CARRIER_READ_BYTES) conflict('carrier_inventory_read_limit');
      views.push(view);
    }
    const own = views.find(view => view.source.selector.scope.run_id === carrier.scope.run_id)!.source.selector;
    if (!isDeepStrictEqual(own, { scope: carrier.scope, target: carrier.target, round: carrier.round,
      headSha: carrier.headSha, reportSha256: carrier.reportSha256 })) conflict('carrier_inventory_carrier_binding_conflict');
    for (const view of views) await material(sink, view);
    for (let index = 0; index < selected.length; index++) {
      const after = await runView(sink, carrier, selected[index]!, actorUserId); const before = views[index]!;
      if (!isDeepStrictEqual(after.data, before.data) || !isDeepStrictEqual(after.recovery, before.recovery)) {
        conflict('carrier_inventory_source_changed');
      }
    }
    if (!isDeepStrictEqual(await listRuns(sink, carrier), listed)) conflict('carrier_inventory_run_set_changed');
    const token = Object.freeze({ qualification: 'authenticated-carrier-inventory-read' as const });
    accepted.set(token, structuredClone({ actorUserId, inventory: { carrier, inventoryStatus: 'complete',
      sources: views.map(view => view.source) }, runSequences: views.map(view => ({
        runId: view.source.selector.scope.run_id, eventSequence: view.sequence })) }));
    return { kind: 'ok', httpStatus: 200, value: token };
  } catch (error) {
    if (error instanceof FailedRead) return error.result;
    return { kind: 'unavailable', reason: 'carrier_inventory_read_failed' };
  }
}


export interface AuthenticatedClaimHistory { readonly qualification: 'authenticated-claim-history' }
export interface ClaimHistoryContent {
  readWindow:{startedAt:string;completedAt:string};
  actorUserId: string;
  sources: CarrierSourceInventory[];
  histories: Array<{runId: string; eventSequence: number; receipts: StoredEventReceipt[]}>;
}
const histories = new WeakMap<AuthenticatedClaimHistory, ClaimHistoryContent>();
export function claimHistoryContent(token: AuthenticatedClaimHistory): ClaimHistoryContent {
  const content = histories.get(token);
  if (!content) throw new Error('unverified_claim_history');
  return structuredClone(content);
}

function prefix(actual: unknown, complete: ClaimEventSelector[], exhaustive: boolean): boolean {
  if (!Array.isArray(actual) || !actual.every(claimEventSelector) || actual.length > complete.length) return false;
  return isDeepStrictEqual(actual, complete.slice(0, actual.length)) && (!exhaustive || actual.length === complete.length);
}

/** All retained same-target sources, including later rounds, with a complete pinned
 * index followed by exact selected receipt reads. Inline truncation alone never
 * authenticates completeness. Both source and event ceilings are read again. */
export async function readClaimTargetHistory(sink: HarnessSink, selection: OccurrenceRunSelector,
  expectedActor?: string): Promise<SinkOutcome<AuthenticatedClaimHistory>> {
  if (!isEventReceiptScope(selection.scope) || !head(selection.headSha) || !sha(selection.reportSha256) ||
      !count(selection.round) || selection.round < 1 || !selection.target || selection.target.trim() !== selection.target ||
      expectedActor !== undefined && !uuid(expectedActor)) throw new Error('invalid_claim_history_selection');
  if (sink.credentialSource === 'attest' || sink.baseUrl !== selection.scope.base_url) throw new Error('claim_history_destination_conflict');
  selection = structuredClone(selection);
  const startedAt=new Date().toISOString();
  try {
    // Bootstrap only the actor; this response grants no mutation authority.
    const actor = value(await sink.getJson(`/api/v1/reviews/runs/${selection.scope.run_id}`, (data, meta) =>
      object(data) && data.id === selection.scope.run_id && object(meta) && meta.org_id === selection.scope.org_id &&
      meta.evidence_protocol_version === 2 && meta.claim_recovery_version === 1 && uuid(meta.actor_user_id) &&
      (expectedActor === undefined || expectedActor === meta.actor_user_id) ? meta.actor_user_id : null,
      { requireCompleteRead: true }));
    // Only scope fields are used by list/run readers. No synthetic carrier proof
    // is exposed or accepted: the result contains original sources and receipts.
    const scope = selection as OccurrenceCarrierSelector;
    const listed = await listRuns(sink, scope);
    const selected = listed.filter(run => run.converge?.target === selection.target);
    if (!selected.some(run => run.id === selection.scope.run_id)) conflict('claim_history_source_unavailable');
    const views: RunView[] = []; let bytes = 0;
    for (const row of selected) {
      const view = await runView(sink, scope, row, actor, true);
      bytes += view.bytes + Buffer.byteLength(JSON.stringify([view.data, view.recovery]));
      if (bytes > MAX_CARRIER_READ_BYTES) conflict('claim_history_read_limit');
      views.push(view);
    }
    const own = views.find(v => v.source.selector.scope.run_id === selection.scope.run_id)!;
    if (!isDeepStrictEqual(own.source.selector, selection)) conflict('claim_history_source_binding_conflict');
    const content: ClaimHistoryContent = { readWindow:{startedAt,completedAt:startedAt},actorUserId: actor, sources: [], histories: [] };
    for (const view of views) {
      const index = value(await readClaimEventIndex(sink, view.source.selector.scope, view.sequence));
      if (typeof view.recovery.claim_events_complete !== 'boolean' ||
          !prefix(view.recovery.claim_events, index, view.recovery.claim_events_complete)) conflict('claim_history_inline_index_conflict');
      const corrections = index.filter(e => e.kind === 'finding_identity_corrected');
      const inline = view.eventSelectors.filter(e => e.kind === 'finding_identity_corrected').sort((a,b) => a.sequence-b.sequence);
      if (!prefix(inline, corrections, view.recovery.truncated === false)) conflict('claim_history_correction_prefix_conflict');
      const classifications = index.filter(e => e.kind === 'round_processed');
      if (view.classificationId === null ? classifications.length !== 0 :
          !classifications.some(e => e.id === view.classificationId && view.eventSelectors.some(i => isDeepStrictEqual(i,e)))) {
        conflict('claim_history_classification_selector_conflict');
      }
      const receipts: StoredEventReceipt[] = [];
      for (let offset=0; offset<index.length; offset+=50) {
        const chunk = index.slice(offset,offset+50);
        const read = value(await readEventReceipts(sink,view.source.selector.scope,chunk.map(e=>e.id)));
        if (read.missing.length || read.receipts.length !== chunk.length) conflict('claim_history_receipt_unavailable');
        for (const receipt of read.receipts) {
          const selected = chunk.find(e=>e.id===receipt.id)!;
          if (receipt.sequence !== selected.sequence || receipt.kind !== selected.kind ||
              receipt.converge_target !== selection.target || receipt.round !== view.source.selector.round) {
            conflict('claim_history_receipt_selector_conflict');
          }
          bytes += Buffer.byteLength(JSON.stringify(receipt));
          if (bytes > MAX_CARRIER_READ_BYTES) conflict('claim_history_read_limit');
          receipts.push(receipt);
        }
      }
      receipts.sort((a,b)=>a.sequence-b.sequence);
      view.source.classifications = receipts.filter(e=>e.kind==='round_processed');
      view.source.corrections = receipts.filter(e=>e.kind==='finding_identity_corrected');
      view.source.correctionIds = view.source.corrections.map(e=>e.id);
      if (view.stored) {
        const raw = value(await sink.getArtifact(view.source.selector.scope.run_id,'report_json',view.bytes));
        if (raw.sha256 !== view.source.selector.reportSha256 || raw.bytes.length !== view.bytes ||
            !Buffer.from(raw.bytes.toString('utf8')).equals(raw.bytes)) conflict('claim_history_artifact_conflict');
        view.source.reportJson=raw.bytes.toString('utf8');
      }
      content.sources.push(view.source);
      content.histories.push({runId:view.source.selector.scope.run_id,eventSequence:view.sequence,receipts});
    }
    for (let i=0;i<selected.length;i++) {
      const after=await runView(sink,scope,selected[i]!,actor,true); const before=views[i]!;
      if (!isDeepStrictEqual(after.data,before.data) || !isDeepStrictEqual(after.recovery,before.recovery)) conflict('claim_history_changed');
    }
    if (!isDeepStrictEqual(await listRuns(sink,scope),listed)) conflict('claim_history_run_set_changed');
    content.readWindow.completedAt=new Date().toISOString();
    const token=Object.freeze({qualification:'authenticated-claim-history' as const});
    histories.set(token,structuredClone(content)); return {kind:'ok',httpStatus:200,value:token};
  } catch(error) {
    if (error instanceof FailedRead) return error.result;
    return {kind:'unavailable',reason:'claim_history_read_failed'};
  }
}

export function sameClaimHistoryEvidence(first:ClaimHistoryContent,second:ClaimHistoryContent):boolean {
  const {readWindow:_first,...a}=first;const {readWindow:_second,...b}=second;return isDeepStrictEqual(a,b);
}
