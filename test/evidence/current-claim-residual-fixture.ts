import type { ClaimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { fixture, laterSource, rebind } from './recovery-validation/occurrence-fixtures.js';
import { inventory } from './recovery-validation/carrier-fixtures.js';
import { sha, uuid } from './recovery-validation/fixtures.js';
import { correctionAnchor } from '../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { prepareClaimDisposition, prepareObligationTransfer } from '../../src/evidence/claim-recovery/validation/occurrence.js';

export const independent = '9999999999999999';

export function residualFixture(originalIndependentIdentity = independent, origin?: { marked: boolean; severity?: string; carriedInvariant?: string }) {
  const f = fixture(origin?.marked);
  const split = f.transfer.split;
  const state = JSON.parse(split.selection.nativeJson);
  state.updatedAt = '2026-09-22T14:01:00.000Z';
  split.selection.occurredAt = '2026-09-22T15:00:00.123456Z';
  split.receipt.received_at = '2026-09-22T15:00:00.123456Z';
  f.transfer.occurredAt = '2026-09-22T16:00:00.123457Z';
  f.disposition.occurredAt = '2026-09-22T16:00:00.123457Z';
  const original = f.report.findings[1];
  if (origin?.severity) original.severity = origin.severity;
  original.file = 'other-cache.ts';
  original.claimDescriptor.operation = 'other-cache.ts :: cache.read';
  state.findings[independent] = { ...structuredClone(state.findings[split.selection.previousIdentity]),
    key: independent, file: original.file, firstRound: 1, lastRound: 2,
    verdict: 'fixed', verdictRound: 1, verdictSeverity: 'important' };
  delete state.findings[independent].pendingRound;
  delete state.lastAnnotations;
  state.rounds.push({ round: 2, runId: uuid(32), counts: { new: 0, repeat: 1, suppressed: 0, regating: 0 } });
  for (const round of state.rounds) delete round.severities;
  split.selection.nativeJson = JSON.stringify(state);
  split.native.sourceJson = split.selection.nativeJson;
  rebind(f.transfer, f.report);
  (split.source.classification.payload.identities as any[])[1].matched_identity = originalIndependentIdentity;
  split.receipt = { ...split.receipt, ...prepareClaimSplit(split.selection).event } as any;
  split.source.storedRun.received_at = '2026-09-22T10:00:00.000000Z';
  (f.originalVerdict.payload.verdicts as any[]).push({ identity_key: independent, verdict: 'fixed', severity: 'important', reason: 'The original independent cache path was corrected.' });
  f.transfer.eventId = uuid(21);
  f.disposition.eventId = uuid(22);
  f.disposition.verdict = 'dismissed';
  const anchor = correctionAnchor(split.selection, split.receipt, split.actorUserId, uuid(99));
  const receipt = (preparation: any, sequence: number, event: any) => ({ ...split.source.scope, ...event,
    actor_user_id: preparation.actorUserId, attempt: null, sequence, received_at: '2026-09-22T16:00:00.123458Z' });
  const transfer = { preparation: f.transfer, actorUserId: f.transfer.actorUserId,
    receipt: receipt(f.transfer, 4, prepareObligationTransfer(f.transfer).event) };
  const disposition = { preparation: f.disposition, actorUserId: f.disposition.actorUserId,
    receipt: receipt(f.disposition, 5, prepareClaimDisposition(f.disposition).event) };
  const later = laterSource(f.disposition, 2, true, 'important');
  const report = JSON.parse(later.reportJson);
  report.findings = [{ ...structuredClone(original), severity: 'important', identity: `report:${report.run.id}:independent` }];
  if (origin?.carriedInvariant) report.findings[0].claimDescriptor.invariant = origin.carriedInvariant;
  later.reportJson = JSON.stringify(report);
  const raw = report.findings[0];
  later.storedRun = { ...structuredClone(report.run), received_at: '2026-09-22T13:59:00.000000Z',
    artifacts: [{ kind: 'report_json', declared_sha256: sha(later.reportJson), declared_bytes: Buffer.byteLength(later.reportJson), stored: true }],
    findings: [{ ref: 'f001', identity_key: raw.identity, file: raw.file, category: raw.category,
      start_line: raw.startLine, end_line: raw.endLine, severity: raw.severity, below_threshold: false,
      gating_reason: raw.gating.reason, verification_verdict: null, claim_descriptor: raw.claimDescriptor }] };
  later.classification.payload = { classification_version: 1, report_json_sha256: sha(later.reportJson),
    identities: [{ version: 1, identity_key: raw.identity, matched_identity: independent, status: 'repeat',
      finding_ref: 'f001', report_json_sha256: sha(later.reportJson), claim_descriptor: raw.claimDescriptor,
      match_rationale: 'exact_descriptor', pending_round: 2 }] };
  const history: ClaimHistoryContent = { actorUserId: f.disposition.actorUserId,
    readWindow: { startedAt: '2026-09-23T00:00:00.000Z', completedAt: '2026-09-23T00:00:01.000Z' },
    sources: [inventory(split.source), inventory(later)], histories: [
      { runId: split.source.scope.run_id, eventSequence: 5, receipts: [split.source.classification, f.originalVerdict, split.receipt, transfer.receipt, disposition.receipt] },
      { runId: later.scope.run_id, eventSequence: 1, receipts: [later.classification] }] };
  return { state,history,anchor,transfer,disposition };
}
