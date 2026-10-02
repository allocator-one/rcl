import { expect, it } from 'vitest';
import { residualFixture, independent } from './current-claim-residual-fixture.js';
import { historyFixture } from './claim-history-fixture.js';
import { sha, uuid } from './recovery-validation/fixtures.js';
import { sampleResult, sampleReview } from '../telemetry/fixtures.js';
import { projection as storedProjection } from './original-run-fixtures.js';
import { buildRunEnvelope } from '../../src/telemetry/envelope.js';
import { readClaimTargetHistory, claimHistoryContent } from '../../src/evidence/claim-recovery/carrier-inventory.js';
import { verifyNativeRecoveryLineage } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { migratedLegacyPendingRound } from '../../src/evidence/claim-recovery/validation/obligations.js';
import { deriveCurrentClaimProjection } from '../../src/evidence/claim-recovery/validation/current-projection.js';

type Fixture = ReturnType<typeof residualFixture>;
async function project(f: Fixture, version: 1|2 = 2, native = f.state) {
  const before = JSON.stringify(f);
  const parsed = verifyNativeRecoveryLineage(JSON.stringify(native), native.target).state;
  const transport = historyFixture(false, f.history);
  const authenticated = await readClaimTargetHistory(transport.sink, f.history.sources[0]!.selector, f.history.actorUserId);
  expect(authenticated.kind).toBe('ok');
  if (authenticated.kind !== 'ok') throw Error(JSON.stringify(authenticated));
  const content = claimHistoryContent(authenticated.value);
  expect(() => claimHistoryContent(JSON.parse(JSON.stringify(authenticated.value)))).toThrow('unverified_claim_history');
  expect(content.histories.flatMap(h => h.receipts)).toHaveLength(f.history.histories.flatMap(h => h.receipts).length);
  expect(transport.calls.filter(c => c.includes('index=claim_recovery'))).toHaveLength(f.history.sources.length);
  const value = deriveCurrentClaimProjection(parsed, [f.anchor], [{ transfers: [f.transfer], dispositions: [f.disposition], carriers: [], pendingIdentities: [] }], content, [], JSON.stringify(native), version);
  expect(value.residuals).toEqual([]);
  expect(value.claims[0]).toMatchObject({ identity: f.anchor.identity, standing: 'dismissed' });
  expect(JSON.stringify(f)).toBe(before);
  return value;
}
function decision(f: Fixture, index = 1, verdict = 'dismissed', received = '2026-09-22T14:30:00.000000Z') {
  const history = f.history.histories[index]!;
  const receipt = { ...structuredClone(history.receipts[0]!), id: uuid(950 + index), kind: 'verdicts_recorded',
    sequence: history.eventSequence + 1, received_at: received,
    payload: { verdicts: [{ identity_key: independent, verdict, severity: 'important', reason: 'Explicit decision on this complete bound subject.' }] } };
  history.receipts.push(receipt);
  history.eventSequence = receipt.sequence;
  return receipt;
}
function later(f: Fixture, pendingRound: number|null = null, change?: (report: any) => void) {
  const source = structuredClone(f.history.sources[1]!);
  const report = JSON.parse(source.reportJson!);
  report.run.id = uuid(933); report.run.converge.round = 3;
  report.findings[0].identity = `report:${report.run.id}:independent`;
  change?.(report);
  const raw = report.findings[0];
  source.reportJson = JSON.stringify(report);
  source.selector.scope.run_id = report.run.id; source.selector.round = 3; source.selector.reportSha256 = sha(source.reportJson);
  source.storedRun = { ...structuredClone(report.run), received_at: '2026-09-22T16:49:00.000000Z',
    artifacts: [{ kind: 'report_json', declared_sha256: sha(source.reportJson), declared_bytes: Buffer.byteLength(source.reportJson), stored: true }],
    findings: [{ ref: 'f001', identity_key: raw.identity, file: raw.file, category: raw.category,
      start_line: raw.startLine, end_line: raw.endLine, severity: raw.severity, below_threshold: false,
      gating_reason: raw.gating.reason, verification_verdict: null, claim_descriptor: raw.claimDescriptor }] };
  const event = { ...structuredClone(source.classifications![0]!), id: uuid(943), run_id: report.run.id, round: 3,
    received_at: '2026-09-22T16:50:00.000000Z', payload: { classification_version: 1, report_json_sha256: sha(source.reportJson),
      identities: [{ version: 1, identity_key: raw.identity, matched_identity: independent, status: 'repeat',
        finding_ref: 'f001', report_json_sha256: sha(source.reportJson), claim_descriptor: raw.claimDescriptor,
        match_rationale: 'exact_descriptor', pending_round: pendingRound }] } };
  source.classifications = [event];
  f.history.sources.push(source);
  f.history.histories.push({ runId: report.run.id, eventSequence: 1, receipts: [event] });
  return { source,event };
}
function confirmation(f: Fixture, healthy = true) {
  const original = f.history.sources[0]!;
  const report = sampleResult({ reviews: [sampleReview({ model: 'a' }),sampleReview({ model: 'b', status: healthy ? 'success' : 'timeout' }),sampleReview({ model: 'c',status: 'timeout' })],findings: [],belowThresholdFindings: [] }) as any;
  report.run.id = uuid(900);
  report.run.target = { ...report.run.target, repo: original.selector.scope.repo, pr_number: original.selector.scope.pr_number };
  report.run.converge = { target: f.state.target, round: 3, attempt: 3 };
  report.run.roster = report.reviews.map((r: any) => ({ model: r.model,role: r.role,provider: r.provider,lane: 'blocking' }));
  report.run.started_at = '2026-09-22T17:00:00.000000Z';
  report.run.finished_at = '2026-09-22T17:01:00.000000Z';
  const raw = JSON.stringify(report);
  const stored = { ...storedProjection(buildRunEnvelope(report,{ report_json: raw },{ level: 'full',delivery: { mode: 'direct' } }),{ report_json: 'present' }),
    repo_verified: true,is_cross_repository: false,received_at: '2026-09-22T17:02:00.000000Z' };
  const event = { ...structuredClone(f.history.histories[1]!.receipts[0]!),id: uuid(901),run_id: report.run.id,round: 3,attempt: 3,
    received_at: '2026-09-22T17:03:00.000000Z',payload: { classification_version: 1,report_json_sha256: sha(raw),identities: [] } };
  f.history.sources.push({ selector: { ...original.selector,scope: { ...original.selector.scope,run_id: report.run.id },round: 3,
    headSha: report.run.target.head_sha,reportSha256: sha(raw) },reportJson: raw,storedRun: stored,classifications: [event],corrections: [],correctionIds: [] });
  f.history.histories.push({ runId: report.run.id,eventSequence: 1,receipts: [event] });
}

it('preserves the complete authenticated later important residual while replaying version1 unchanged', async () => {
  const f = residualFixture();
  const parsed = verifyNativeRecoveryLineage(JSON.stringify(f.state), f.state.target).state;
  expect(migratedLegacyPendingRound(parsed.findings[independent]!, parsed)).toBeUndefined();
  expect((await project(f)).actionableIdentities).toContain(independent);
  expect((await project(f, 1)).actionableIdentities).not.toContain(independent);
  const explicit = structuredClone(f.state); explicit.findings[independent].pendingRound = 2;
  expect((await project(f, 2, explicit)).actionableIdentities).toContain(independent);
});
it('leaves a legitimately disposed unmarked legacy repeat settled', async () => {
  const f = residualFixture(), event = f.history.histories[1]!.receipts[0]!;
  const row = (event.payload.identities as any[])[0];
  event.payload = { identities: [{ identity_key: row.identity_key,matched_identity: independent,status: 'repeat',claim_descriptor: row.claim_descriptor }] };
  f.history.sources[1]!.classifications = [event];
  expect((await project(f)).actionableIdentities).not.toContain(independent);
});
it('accepts a later bound dismissal without clearing an existing native pending obligation', async () => {
  const f = residualFixture(); decision(f);
  expect((await project(f)).actionableIdentities).not.toContain(independent);
  f.state.findings[independent].pendingRound = 2;
  expect((await project(f)).actionableIdentities).toContain(independent);
});
it('accepts a later-run dismissal only for the same complete subject', async () => {
  const f = residualFixture(); later(f); decision(f, 2, 'dismissed', '2026-09-22T17:00:00.000000Z');
  expect((await project(f)).actionableIdentities).not.toContain(independent);
});
it('keeps fixed pending until an actual later conclusive confirmation', async () => {
  const f = residualFixture(); decision(f, 1, 'fixed');
  expect((await project(f)).actionableIdentities).toContain(independent);
  confirmation(f);
  expect((await project(f)).actionableIdentities).not.toContain(independent);
  const inconclusive = residualFixture(); decision(inconclusive, 1, 'fixed'); confirmation(inconclusive, false);
  expect((await project(inconclusive)).actionableIdentities).toContain(independent);
});
it('requires a critical decision for a later critical pending member', async () => {
  const f = residualFixture(); later(f, 3, report => { report.findings[0].severity = 'critical'; });
  const receipt = decision(f, 2, 'dismissed', '2026-09-22T17:00:00.000000Z');
  expect((await project(f)).actionableIdentities).toContain(independent);
  receipt.payload.verdicts[0]!.severity = 'critical';
  expect((await project(f)).actionableIdentities).not.toContain(independent);
});
it.each(['old-subject','different-descriptor','unmarked-subject','invalid-actor','client-time-only','ambiguous-order','later-pending'] as const)
('preserves pending for %s instead of inferring clearing authority', async kind => {
  const f = residualFixture();
  if (kind === 'old-subject') decision(f, 0, 'dismissed', '2026-09-22T18:00:00.000000Z');
  if (kind === 'different-descriptor') { later(f, null, r => { r.findings[0].claimDescriptor.invariant = 'A different unselected obligation.'; }); decision(f, 2, 'dismissed', '2026-09-22T17:00:00.000000Z'); }
  if (kind === 'unmarked-subject') { const { source,event } = later(f); const row = event.payload.identities[0]!; event.payload = { identities: [{ identity_key: row.identity_key,matched_identity: independent,status: 'repeat',claim_descriptor: row.claim_descriptor }] } as any; source.classifications = [event]; decision(f, 2, 'dismissed', '2026-09-22T17:00:00.000000Z'); }
  if (kind === 'invalid-actor') decision(f).actor_user_id = null;
  if (kind === 'client-time-only') decision(f, 1, 'dismissed', '2026-09-22T13:00:00.000000Z').occurred_at = '2026-09-22T18:00:00.000000Z';
  if (kind === 'ambiguous-order') { decision(f, 1, 'dismissed', '2026-09-22T17:00:00.000000Z'); later(f); decision(f, 2, 'dismissed', '2026-09-22T17:00:00.000000Z'); }
  if (kind === 'later-pending') { decision(f); later(f, 3); }
  expect((await project(f)).actionableIdentities).toContain(independent);
});
it('preserves an explicit legacy pending marker without inventing its subject', async () => {
  const f = residualFixture(); decision(f); confirmation(f);
  const event = f.history.histories[2]!.receipts[0]!;
  event.payload.legacy_pending_identities = [independent];
  f.history.sources[2]!.classifications = [event];
  expect((await project(f)).actionableIdentities).toContain(independent);
});

it('preserves a carried pending marker when its original-round subject cannot be authenticated', async () => {
  const f = residualFixture('8888888888888888');
  const originalMappings = f.history.sources[0]!.classifications![0]!.payload.identities as any[];
  expect(originalMappings.every(row => row.matched_identity !== independent)).toBe(true);
  const carried = f.history.histories[1]!.receipts[0]!;
  (carried.payload.identities as any[])[0].pending_round = 1;
  f.history.sources[1]!.classifications = [carried];
  expect(f.history.sources[1]!.selector.round).toBe(2);
  decision(f);
  expect((await project(f)).actionableIdentities).toContain(independent);
});

function carriedOrigin(origin?: { marked: boolean; severity?: string; carriedInvariant?: string }) {
  const f = residualFixture(independent, origin);
  const carried = f.history.histories[1]!.receipts[0]!;
  (carried.payload.identities as any[])[0].pending_round = 1;
  f.history.sources[1]!.classifications = [carried];
  return f;
}
it('preserves a carried marker when an original same-identity occurrence does not prove pending', async () => {
  const f = carriedOrigin(); decision(f);
  expect((await project(f)).actionableIdentities).toContain(independent);
});
it('accepts dismissal of a carried marker with its authenticated original pending subject', async () => {
  const f = carriedOrigin({ marked: true }); decision(f);
  expect((await project(f)).actionableIdentities).not.toContain(independent);
});
it('preserves the original critical severity when a later carried occurrence is important', async () => {
  const f = carriedOrigin({ marked: true, severity: 'critical' });
  const receipt = decision(f);
  expect((await project(f)).actionableIdentities).toContain(independent);
  receipt.payload.verdicts[0]!.severity = 'critical';
  expect((await project(f)).actionableIdentities).not.toContain(independent);
});
it('requires eligible later confirmation after fixing a carried authenticated obligation', async () => {
  const f = carriedOrigin({ marked: true }); decision(f, 1, 'fixed');
  expect((await project(f)).actionableIdentities).toContain(independent);
  confirmation(f);
  expect((await project(f)).actionableIdentities).not.toContain(independent);
});
it('cannot confirm away a carried marker with an unavailable original pending subject', async () => {
  const f = carriedOrigin(); decision(f, 1, 'fixed'); confirmation(f);
  expect((await project(f)).actionableIdentities).toContain(independent);
});

it('refuses a bound original occurrence whose pending marker was absent', async () => {
  const f = carriedOrigin({ marked: true });
  const original = f.history.histories[0]!.receipts[0]!;
  (original.payload.identities as any[])[1].pending_round = null;
  f.history.sources[0]!.classifications = [original];
  decision(f);
  expect((await project(f)).actionableIdentities).toContain(independent);
});
it('refuses to clear a carried marker using a different original pending subject', async () => {
  const f = carriedOrigin({ marked: true, carriedInvariant: 'A different pending cache lifetime obligation.' });
  decision(f);
  expect((await project(f)).actionableIdentities).toContain(independent);
});
