import { describe, expect, it } from 'vitest';
import { qualifyRecoveryConfirmation, recoveryConfirmationContent } from '../../src/evidence/claim-recovery/confirmation.js';
import { readCarrierInventory } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { verifyAuthenticatedSelectedReceipts } from '../../src/evidence/claim-recovery/authenticated-receipts.js';
import { prepareClaimDisposition } from '../../src/evidence/claim-recovery/validation/occurrence.js';
import { HarnessSink } from '../../src/telemetry/sink.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { sampleResult, sampleReview, sampleFinding } from '../telemetry/fixtures.js';
import { projection } from './original-run-fixtures.js';
import { fixture, preserved } from './recovery-validation/occurrence-fixtures.js';
import { sha, uuid } from './recovery-validation/fixtures.js';

const floor = '2026-09-22T13:00:00.123456Z';
async function evidence(change?: (report: any, stored: any, classification: any) => void, preserve = false) {
  const f = preserve ? preserved() : fixture();
  const p = f.disposition;
  const receipt = { ...p.sourceContext.scope, ...prepareClaimDisposition(p).event, actor_user_id: p.actorUserId,
    attempt: null, sequence: 4, received_at: floor };
  const proof = { preparation: p, receipt, actorUserId: p.actorUserId };
  const sourceReceipts = [p.split.source.classification, p.split.receipt, receipt,
    ...(p.originalVerdict ? [p.originalVerdict] : [])];
  const report = sampleResult({ reviews: [sampleReview({ model: 'a' }), sampleReview({ model: 'b' }),
    sampleReview({ model: 'c', status: 'timeout' })], findings: [], belowThresholdFindings: [] }) as any;
  report.run.id = uuid(900);
  report.run.target = { ...report.run.target, repo: p.sourceContext.scope.repo, pr_number: p.sourceContext.scope.pr_number };
  report.run.converge = { target: p.sourceContext.target, round: 2, attempt: 3 };
  report.run.roster = report.reviews.map((r: any) => ({ model: r.model, role: r.role, provider: r.provider, lane: 'blocking' }));
  report.run.started_at = '2026-09-22T13:00:00.123457Z';
  report.run.finished_at = '2026-09-22T14:00:00.000000Z';
  const makeStored = () => ({ ...projection(buildRunEnvelope(report, { report_json: JSON.stringify(report) },
    { level: 'full', delivery: { mode: 'direct' } }), { report_json: 'present' }), repo_verified: true,
    is_cross_repository: false, received_at: '2026-09-22T14:01:00.000000Z' });
  const stored = makeStored() as any;
  const classification = { ...p.sourceContext.scope, id: uuid(901), run_id: report.run.id, actor_user_id: uuid(902),
    kind: 'round_processed', converge_target: p.sourceContext.target, round: 2, attempt: 3, sequence: 1,
    occurred_at: '2026-09-22T14:02:00.000000Z', received_at: '2026-09-22T14:02:00.000000Z',
    payload: { classification_version: 1, report_json_sha256: sha(JSON.stringify(report)), identities: [] } } as any;
  const originalReport = JSON.stringify(report);
  change?.(report, stored, classification);
  if (JSON.stringify(report) !== originalReport) Object.assign(stored, makeStored());
  const raw = JSON.stringify(report);
  classification.payload.report_json_sha256 = sha(raw);
  classification.round = report.run.converge.round;
  classification.attempt = report.run.converge.attempt;
  const scope = p.sourceContext.scope;
  const candidateScope = { ...scope, run_id: report.run.id };
  const calls: string[] = [];
  const sink = new HarnessSink({ credential: { url: scope.base_url, token: 'synthetic-only', source: 'login' },
    rclVersion: 'test', fetchImpl: async (input, init) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const url = new URL(String(input)); calls.push(url.pathname);
      const candidate = url.pathname.includes(report.run.id);
      if (url.pathname.endsWith('/artifacts/report_json')) return new Response(raw,
        { headers: { 'x-artifact-sha256': sha(raw) } });
      if (url.pathname === '/api/v1/reviews/runs') return Response.json({ data: [{ id: report.run.id,
        target: stored.target, converge: stored.converge }], meta: { org_id: scope.org_id,
        evidence_protocol_version: 2, page: 1, page_size: 100, total: 1, total_pages: 1 } });
      if (url.pathname.endsWith('/events')) return Response.json({ data: (candidate ? [classification] : sourceReceipts)
        .filter(row => url.searchParams.get('ids')!.split(',').includes(row.id)), meta: { org_id: scope.org_id,
        run_id: candidate ? report.run.id : scope.run_id, claim_recovery_version: 1 } });
      return Response.json({ data: candidate ? stored : p.split.source.storedRun,
        meta: { org_id: scope.org_id, actor_user_id: p.actorUserId, claim_recovery_version: 1, evidence_protocol_version: 2,
          recovery: { truncated: false, event_sequence: candidate ? 1 : 4, native_corrections: [],
            classification_event: candidate ? { id: classification.id, sequence: 1, round: classification.round } : null } } });
    } });
  const verified = await verifyAuthenticatedSelectedReceipts(sink, p.actorUserId, [{ selection: p.sourceContext,
    expectedReceipts: sourceReceipts, readRequirements: [{ kind: 'selected-event-receipts', scope,
      eventIds: sourceReceipts.map(r => r.id) }] }]);
  if (verified.kind !== 'verified') throw new Error(JSON.stringify(verified));
  const inventory = await readCarrierInventory(sink, { scope: candidateScope, target: p.sourceContext.target,
    round: stored.converge.round, headSha: stored.target.head_sha, reportSha256: sha(raw), kind: 'classified_group',
    classificationId: classification.id, identity: p.split.selection.identity }, p.actorUserId);
  if (inventory.kind !== 'ok') throw new Error(JSON.stringify(inventory));
  return { proof, inventory: inventory.value, receipts: verified.value, calls };
}

describe('recovery confirmation evidence', () => {
  it('qualifies a genuinely later marked source at exactly the two-thirds blocking threshold', async () => {
    const f = await evidence();
    const result = qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts);
    expect(result.kind).toBe('eligible');
    if (result.kind !== 'eligible') throw new Error(JSON.stringify(result));
    const content = recoveryConfirmationContent(result.value);
    expect(content.health).toEqual({ blocking: 3, successful: 2, required: 2 });
    expect(content.assertion.receivedAt).toBe(floor);
    expect(content.source.selector.round).toBe(2);
    expect(content.claimStanding).toBe('not-evaluated');
    expect(() => recoveryConfirmationContent(JSON.parse(JSON.stringify(result.value)))).toThrow();
    content.source.reportJson = null;
    expect(recoveryConfirmationContent(result.value).source.reportJson).not.toBeNull();
  });

  it.each(['equal-start', 'old-start', 'unmarked', 'inconclusive', 'foreign-repository', 'backfill',
    'missing-eligibility', 'receipt-before-finish', 'classification-before-run', 'stored-health-conflict', 'stored-time-conflict'])
    ('refuses %s evidence without granting standing', async kind => {
      const f = await evidence((report, stored, classification) => {
        if (kind === 'equal-start') report.run.started_at = floor;
        if (kind === 'old-start') report.run.started_at = '2026-09-22T12:00:00.000000Z';
        if (kind === 'unmarked') delete classification.payload.classification_version;
        if (kind === 'inconclusive') report.reviews[1].status = 'timeout';
        if (kind === 'foreign-repository') stored.is_cross_repository = true;
        if (kind === 'backfill') stored.provenance = 'backfill';
        if (kind === 'missing-eligibility') delete stored.repo_verified;
        if (kind === 'receipt-before-finish') stored.received_at = floor;
        if (kind === 'classification-before-run') classification.received_at = '2026-09-22T14:00:30.000000Z';
        if (kind === 'stored-health-conflict') stored.calls[2].status = 'success';
        if (kind === 'stored-time-conflict') stored.started_at = '2026-09-22T13:00:00.123458Z';
      });
      expect(qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts).kind).toBe('ineligible');
    });

  it('does not let auxiliary successful calls make an inconclusive blocking lane eligible', async () => {
    const f = await evidence(report => { report.run.roster[1].lane = 'async'; report.run.roster[2].lane = 'secondary'; });
    expect(qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts).kind).toBe('ineligible');
  });

  it('requires the actual numeric later round independently of attempt number', async () => {
    const f = await evidence(report => { report.run.converge.round = 1; report.run.converge.attempt = 20; });
    expect(qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts).kind).toBe('ineligible');
  });

  it('allows a later numeric round with an unrelated smaller attempt number', async () => {
    const f = await evidence(report => { report.run.converge.attempt = 1; });
    expect(qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts).kind).toBe('eligible');
  });

  it('binds the entire supplied disposition to its authenticated receipt', async () => {
    const f = await evidence(); f.proof.receipt.received_at = '2026-09-22T10:00:00.000000Z';
    expect(qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts).kind).toBe('ineligible');
  });

  it('applies one receipt cutoff to the assertion, run and classification', async () => {
    const f = await evidence();
    expect(qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts,
      '2026-09-22T14:01:59.999999Z').kind).toBe('ineligible');
    expect(qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts,
      '2026-09-22T14:02:00.000000Z').kind).toBe('eligible');
  });

  it('uses a preserved original fixed receipt only after exact claim attribution validation', async () => {
    const f = await evidence(report => { report.run.started_at = '2026-09-22T12:00:00.000000Z'; }, true);
    const result = qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts);
    expect(result.kind).toBe('eligible');
    if (result.kind !== 'eligible') throw new Error(JSON.stringify(result));
    expect(recoveryConfirmationContent(result.value).assertion.eventId).toBe(f.proof.preparation.originalVerdict!.id);
  });

  it('retains a later re-gating sighting without treating its eligible review as claim clearance', async () => {
    const original = fixture().disposition;
    const f = await evidence((report, _stored, classification) => {
      const finding = sampleFinding({ identity: 'candidate-report-key', claimDescriptor: original.split.selection.descriptor,
        severity: 'critical', gating: { reason: 'critical' } });
      report.findings = [finding];
      classification.payload.identities = [{ version: 1, identity_key: finding.identity,
        matched_identity: original.split.selection.identity, status: 'regating', finding_ref: 'f001',
        report_json_sha256: sha(JSON.stringify(report)), claim_descriptor: finding.claimDescriptor,
        match_rationale: 'exact_descriptor', pending_round: 2 }];
    });
    const result = qualifyRecoveryConfirmation(f.proof, f.inventory, f.receipts);
    expect(result.kind).toBe('eligible');
    if (result.kind !== 'eligible') throw new Error(JSON.stringify(result));
    expect(recoveryConfirmationContent(result.value)).toMatchObject({ claimStanding: 'not-evaluated',
      sightings: [{ findingRef: 'f001', severity: 'critical', gating: 'critical', status: 'regating', pendingRound: 2 }] });
  });

  it('rejects serialized inventory and receipt tokens as unauthenticated inputs', async () => {
    const f = await evidence();
    expect(qualifyRecoveryConfirmation(f.proof, JSON.parse(JSON.stringify(f.inventory)), f.receipts).kind).toBe('ineligible');
    expect(qualifyRecoveryConfirmation(f.proof, f.inventory, JSON.parse(JSON.stringify(f.receipts))).kind).toBe('ineligible');
  });
});
