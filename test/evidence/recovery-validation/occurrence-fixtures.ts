import { prepareClaimSplit } from '../../../src/evidence/claim-recovery/validation/claim-split.js';
import type { ClaimDispositionInput, ObligationTransferInput, OccurrenceSource } from '../../../src/evidence/claim-recovery/validation/occurrence-types.js';
import type { StoredEventReceipt } from '../../../src/evidence/claim-recovery/validation/receipts.js';
import { recoveredFixture, sha, uuid } from './fixtures.js';

export function fixture(marked = false) {
  const base = recoveredFixture();
  const selection = structuredClone(base.selection);
  const report = JSON.parse(selection.reportJson);
  report.run.rcl_version = '3.8.0'; report.run.command = 'review';
  report.run.converge.attempt = 1;
  report.findings.push({ ...structuredClone(report.findings[0]), identity: 'raw-second', id: 'same-model-id' });
  report.belowThresholdFindings = [{ ...structuredClone(report.findings[0]), identity: 'raw-appendix', id: 'f001', gating: { reason: 'none' } }];
  selection.reportJson = JSON.stringify(report);
  const all = [...report.findings, ...report.belowThresholdFindings];
  const classification = { ...selection.sourceReceipts[0]!, sequence: 1, received_at: '2026-09-22T11:00:00.123456Z',
    payload: { ...(marked ? { classification_version: 1, report_json_sha256: sha(selection.reportJson) } : {}),
      identities: all.map((f, i) => ({ identity_key: f.identity, matched_identity: selection.previousIdentity, status: 'new',
        ...(marked ? { version: 1, finding_ref: `f00${i + 1}`, report_json_sha256: sha(selection.reportJson),
          claim_descriptor: f.claimDescriptor, match_rationale: 'exact_descriptor', pending_round: 1 } :
          { claim_descriptor: f.claimDescriptor }) })) } } as StoredEventReceipt;
  selection.sourceReceipts = [classification]; selection.expectedEventSequence = 2;
  const source: OccurrenceSource = { scope: selection.scope, reportJson: selection.reportJson, classification, corrections: [],
    storedRun: { ...report.run, artifacts: [{ kind: 'report_json', declared_sha256: sha(selection.reportJson),
      declared_bytes: Buffer.byteLength(selection.reportJson), stored: true }],
      findings: all.map((f, i) => ({ ref: `f00${i + 1}`, identity_key: f.identity, file: f.file, category: f.category,
        start_line: f.startLine, end_line: f.endLine, severity: f.severity, below_threshold: i === 2,
        gating_reason: f.gating.reason, verification_verdict: null, claim_descriptor: f.claimDescriptor })) } };
  const event = prepareClaimSplit(selection).event;
  const receipt: StoredEventReceipt = { ...selection.scope, ...event, converge_target: selection.target, round: 1, attempt: null,
    actor_user_id: uuid(7), sequence: 3, received_at: '2026-09-22T12:00:00.123456Z' };
  const sourceContext = { scope: selection.scope, target: selection.target, round: 1, actorUserId: uuid(8), eventSequence: 3,
    headSha: report.run.target.head_sha, reportSha256: sha(selection.reportJson) };
  const split = { selection, source, receipt, actorUserId: uuid(7), native: { sourceJson: selection.nativeJson,
    target: selection.target, reports: [] as string[] } };
  const common = { eventId: uuid(20), occurredAt: '2026-09-22T13:00:00.123457Z', actorUserId: uuid(8), split, sourceContext };
  const transfer: ObligationTransferInput = { ...common, carrier: source, carrierContext: sourceContext,
    carrierKind: 'classified_group', carrierIdentity: selection.previousIdentity, reason: 'Transfer this original occurrence only.' };
  const disposition: ClaimDispositionInput = { ...common, mode: 'fresh', verdict: 'fixed', severity: 'important',
    reason: 'The expired-entry branch now checks the timestamp.', previousDispositionEventId: null };
  const originalVerdict: StoredEventReceipt = { ...classification, id: uuid(10), kind: 'verdicts_recorded', actor_user_id: uuid(9),
    sequence: 2, occurred_at: '2026-09-22T11:10:00.123456Z', received_at: '2026-09-22T11:10:00.123457Z',
    payload: { verdicts: [{ identity_key: selection.previousIdentity, verdict: 'fixed', severity: 'important', reason: disposition.reason }] } };
  return { transfer, disposition, originalVerdict, report };
}

export function preserved() {
  const f = fixture(true);
  f.disposition.mode = 'preserved'; f.disposition.originalVerdict = f.originalVerdict;
  f.disposition.originalVerdictActorUserId = uuid(9);
  return f;
}

/** Rebind every digest/projection so semantic adversaries do not fail on a stale hash. */
export function rebind(input: ClaimDispositionInput | ObligationTransferInput, report: any) {
  const source = input.split.source; const selection = input.split.selection;
  source.reportJson = JSON.stringify(report); selection.reportJson = source.reportJson;
  const all = [...report.findings, ...report.belowThresholdFindings];
  source.storedRun = { ...structuredClone(report.run), artifacts: [{ kind: 'report_json', stored: true,
    declared_sha256: sha(source.reportJson), declared_bytes: Buffer.byteLength(source.reportJson) }], findings: all.map((f, i) => ({
    ref: `f${String(i + 1).padStart(3, '0')}`, identity_key: f.identity, file: f.file, category: f.category,
    start_line: f.startLine, end_line: f.endLine, severity: f.severity, below_threshold: i >= report.findings.length,
    gating_reason: f.gating?.reason ?? 'none', verification_verdict: f.gating?.verification?.verdict ?? null,
    claim_descriptor: f.claimDescriptor ?? null })) };
  const marked = source.classification.payload.classification_version === 1;
  source.classification.payload.identities = all.map((f, i) => ({ identity_key: f.identity, matched_identity: selection.previousIdentity,
    status: 'new', ...(f.claimDescriptor ? { claim_descriptor: f.claimDescriptor } : {}),
    ...(marked ? { version: 1, finding_ref: `f${String(i + 1).padStart(3, '0')}`, report_json_sha256: sha(source.reportJson),
      match_rationale: 'exact_descriptor', pending_round: 1 } : {}) }));
  if (marked) source.classification.payload.report_json_sha256 = sha(source.reportJson);
  input.sourceContext.reportSha256 = sha(source.reportJson);
  input.split.receipt = { ...input.split.receipt, ...prepareClaimSplit(selection).event } as StoredEventReceipt;
}

export function laterSource(input: ClaimDispositionInput | ObligationTransferInput, round = 2, gated = true, severity = 'important'): OccurrenceSource {
  const source = structuredClone(input.split.source); const report = JSON.parse(source.reportJson);
  report.run.id = uuid(30 + round); report.run.converge.round = round;
  report.findings = [report.findings[0]]; report.belowThresholdFindings = [];
  report.findings[0].severity = severity; report.findings[0].gating.reason = gated ? 'consensus' : 'none';
  source.scope.run_id = report.run.id; source.reportJson = JSON.stringify(report);
  const f = report.findings[0];
  source.storedRun = { ...report.run, artifacts: [{ kind: 'report_json', declared_sha256: sha(source.reportJson),
    declared_bytes: Buffer.byteLength(source.reportJson), stored: true }], findings: [{ ref: 'f001', identity_key: f.identity,
    file: f.file, category: f.category, start_line: f.startLine, end_line: f.endLine, severity, below_threshold: false,
    gating_reason: f.gating.reason, verification_verdict: null, claim_descriptor: f.claimDescriptor }] };
  source.classification = { ...source.classification, id: uuid(40 + round), run_id: report.run.id, round, attempt: null,
    sequence: 1, received_at: '2026-09-22T14:00:00.123456Z', payload: { classification_version: 1,
      report_json_sha256: sha(source.reportJson), identities: [{ version: 1, identity_key: f.identity,
        matched_identity: input.split.selection.identity, status: 'repeat', finding_ref: 'f001',
        report_json_sha256: sha(source.reportJson), claim_descriptor: f.claimDescriptor, match_rationale: 'exact_descriptor',
        pending_round: gated ? round : null }] } };
  return source;
}
