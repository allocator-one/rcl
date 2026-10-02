import { prepareObligationTransfer } from '../../../src/evidence/claim-recovery/validation/occurrence.js';
import type { ObligationTransferInput, OccurrenceSource } from '../../../src/evidence/claim-recovery/validation/occurrence-types.js';
import type { AcceptedOccurrenceTransfer, CarrierProjectionInput, CarrierSourceInventory, OccurrenceCarrierSelector } from '../../../src/evidence/claim-recovery/validation/carrier-types.js';
import { fixture, laterSource, rebind } from './occurrence-fixtures.js';
import { sha, uuid } from './fixtures.js';

export function roundInput(round = 1): ObligationTransferInput {
  const { transfer: input, report } = fixture();
  const runId = uuid(100 + round); report.run.id = runId; report.run.converge.round = round;
  input.split.selection.scope.run_id = runId; input.sourceContext.round = round;
  const classification = input.split.source.classification;
  classification.id = uuid(200 + round); classification.run_id = runId; classification.round = round;
  input.split.selection.classificationId = classification.id; input.split.selection.eventId = uuid(300 + round);
  const native = JSON.parse(input.split.selection.nativeJson);
  native.rounds[0].round = round; native.rounds[0].runId = runId;
  native.findings[input.carrierIdentity].firstRound = round; native.findings[input.carrierIdentity].lastRound = round;
  native.lastAnnotations.round = round;
  input.split.selection.nativeJson = JSON.stringify(native); input.split.native.sourceJson = input.split.selection.nativeJson;
  rebind(input, report); return input;
}

export function inventory(source: OccurrenceSource): CarrierSourceInventory {
  const run = source.storedRun as any;
  return { selector: { scope: structuredClone(source.scope), target: run.converge.target, round: run.converge.round,
    headSha: run.target.head_sha, reportSha256: sha(source.reportJson) }, reportJson: source.reportJson,
    storedRun: structuredClone(source.storedRun), classifications: [structuredClone(source.classification)],
    correctionIds: source.corrections.map(c => c.id), corrections: structuredClone(source.corrections) };
}

export function carrier(source: OccurrenceSource, identity: string, kind: OccurrenceCarrierSelector['kind'] = 'classified_group'): OccurrenceCarrierSelector {
  return { ...inventory(source).selector, kind, classificationId: source.classification.id, identity };
}

export function accepted(input: ObligationTransferInput, ref = 1): AcceptedOccurrenceTransfer {
  input = structuredClone(input);
  input.split.selection.findingRef = `f00${ref}`;
  input.split.selection.identity = `2222222222222${String(ref).padStart(3, '0')}`;
  input.split.selection.eventId = uuid(1000 + input.sourceContext.round * 10 + ref);
  input.split.selection.expectedEventSequence = ref + 1;
  input.split.receipt.sequence = ref + 2;
  input.sourceContext.eventSequence = ref + 2;
  if (input.carrierContext.scope.run_id === input.sourceContext.scope.run_id) input.carrierContext.eventSequence = ref + 2;
  input.eventId = uuid(2000 + input.sourceContext.round * 10 + ref);
  rebind(input, JSON.parse(input.split.selection.reportJson));
  const event = prepareObligationTransfer(input).event;
  return { preparation: input, actorUserId: input.actorUserId, receipt: { ...input.carrierContext.scope, ...event,
    actor_user_id: input.actorUserId, attempt: null, sequence: 20 + ref, received_at: '2026-09-22T15:00:00.123456Z' } };
}

export function emptySource(input: ObligationTransferInput, round: number, legacy = false): OccurrenceSource {
  const source = laterSource(input, round); const report = JSON.parse(source.reportJson);
  report.findings = []; report.belowThresholdFindings = []; source.reportJson = JSON.stringify(report);
  source.storedRun.findings = [];
  source.storedRun.artifacts = [{ kind: 'report_json', stored: true, declared_sha256: sha(source.reportJson),
    declared_bytes: Buffer.byteLength(source.reportJson) }];
  source.classification.payload = legacy ? { classification_version: 1, report_json_sha256: sha(source.reportJson),
    identities: [], legacy_pending_identities: [input.carrierIdentity] } : { identities: [] };
  return source;
}

export function projectionFixture(legacy = false) {
  const input = roundInput(); const source = input.split.source;
  const sourceCarrier = legacy ? emptySource(input, 3, true) : source;
  if (legacy) {
    input.carrier = sourceCarrier; input.carrierKind = 'legacy_pending';
    input.carrierContext = { ...inventory(sourceCarrier).selector, actorUserId: input.actorUserId, eventSequence: 1 };
  }
  const projection: CarrierProjectionInput = { carrier: carrier(sourceCarrier, input.carrierIdentity, legacy ? 'legacy_pending' : 'classified_group'),
    inventoryStatus: 'complete', sources: legacy ? [inventory(source), inventory(emptySource(input, 2)), inventory(sourceCarrier)] : [inventory(source)],
    transfers: [], nativePredecessors: [] };
  return { input, projection };
}
