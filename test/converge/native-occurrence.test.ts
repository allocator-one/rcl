import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { applyNativeRecovery, deriveNativeRecovery } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { validateRetainedNativeEvidence } from '../../src/evidence/claim-recovery/validation/native-state.js';
import type { AcceptedClaimDisposition } from '../../src/evidence/claim-recovery/validation/native-occurrences.js';
import type { ClaimDispositionInput } from '../../src/evidence/claim-recovery/validation/occurrence-types.js';
import { prepareClaimDisposition } from '../../src/evidence/claim-recovery/validation/occurrence.js';
import { accepted, projectionFixture, roundInput, inventory, carrier } from '../evidence/recovery-validation/carrier-fixtures.js';
import { legacyFixture, sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { preserved, laterSource, rebind } from '../evidence/recovery-validation/occurrence-fixtures.js';
import { sampleRunHeader } from '../telemetry/fixtures.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(refs = [1]) {
  const f = projectionFixture(); const transfers = refs.map(ref => accepted(f.input, ref));
  const operationId = uuid(9000);
  const anchors = transfers.map(t => correctionAnchor(t.preparation.split.selection, t.preparation.split.receipt,
    t.preparation.split.actorUserId, operationId));
  const input = { sourceJson: f.input.split.selection.nativeJson, target: f.input.sourceContext.target, operationId,
    anchors, reports: [f.input.split.source.reportJson], sourceReceipts: [f.input.split.source.classification], transfers,
    dispositions: [] as AcceptedClaimDisposition[], carriers: [{ carrier: f.projection.carrier, inventoryStatus: f.projection.inventoryStatus,
      sources: f.projection.sources }] };
  return { ...f, input, anchors };
}
function disposition(f: ReturnType<typeof fixture>, verdict: 'fixed' | 'dismissed' = 'fixed') {
  const t = f.input.transfers[0]!; const preparation: ClaimDispositionInput = { eventId: uuid(9500), occurredAt: '2026-09-22T15:00:00.123450Z',
    actorUserId: t.actorUserId, split: t.preparation.split,
    sourceContext: { ...t.preparation.sourceContext, eventSequence: t.receipt.sequence }, mode: 'fresh' as const,
    verdict, severity: 'important' as const, reason: 'The exact expired-entry condition has been checked.', previousDispositionEventId: null };
  const event = prepareClaimDisposition(preparation).event;
  return { preparation, actorUserId: preparation.actorUserId, receipt: { ...preparation.sourceContext.scope, ...event,
    actor_user_id: preparation.actorUserId, attempt: null, sequence: 30, received_at: '2026-09-22T15:00:00.123456Z' } };
}
async function install(f: ReturnType<typeof fixture>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'native-occurrence-'))); directories.push(dir);
  const path = convergeRunStatePath(dir, f.input.target); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, f.input.sourceJson, { mode: 0o600 }); return { dir, path };
}

it('keeps the existing anchor-only derivation usable', () => {
  const f = fixture(); const plan = deriveNativeRecovery({ ...f.input, transfers: [], carriers: [] });
  expect(plan.actionableIdentities).toContain(f.anchors[0]!.identity);
});

it('retains receipt-bound partial transfers and exact native history without claiming authenticated closure', () => {
  const f = fixture(); const before = structuredClone(f.input); const plan = deriveNativeRecovery(f.input);
  const state = JSON.parse(plan.resultJson); const evidence = state.recovery.operations[0].occurrences;
  expect(evidence.transfers).toEqual(f.input.transfers);
  expect(evidence.projection.carriers[0].content.transfers).toHaveLength(1);
  expect(evidence.projection.carriers[0].content.residuals.filter((r: any) => r.reason === 'untransferred-occurrence')).toHaveLength(2);
  expect(evidence.projection.carriers[0].unresolved).toContain('authenticated-inventory-unavailable');
  expect(evidence.projection.qualification).toBe('supplied-content-only');
  expect(plan.actionableIdentities).toContain(f.input.carriers[0]!.carrier.identity);
  const source = JSON.parse(f.input.sourceJson);
  expect(state.rounds).toEqual(source.rounds); expect(state.findings).toEqual(source.findings); expect(state.updatedAt).toBe(source.updatedAt);
  expect(f.input).toEqual(before); expect(deriveNativeRecovery(f.input)).toEqual(plan);
});

it('never promotes complete supplied content into carrier closure', () => {
  const f = fixture([1, 2, 3]); const plan = deriveNativeRecovery(f.input);
  const evidence = JSON.parse(plan.resultJson).recovery.operations[0].occurrences;
  expect(evidence.projection.carriers[0].content.coverage).toBe('no-residuals-in-supplied-content');
  expect(evidence.projection.carriers[0].unresolved).toEqual(['authenticated-inventory-unavailable']);
  expect(plan.actionableIdentities).toContain(f.input.carriers[0]!.carrier.identity);
});

it('pins the accepted fresh assertion microseconds separately from client time and keeps fixed unresolved', () => {
  const f = fixture(); f.input.dispositions.push(disposition(f)); const plan = deriveNativeRecovery(f.input);
  const projection = JSON.parse(plan.resultJson).recovery.operations[0].occurrences.projection;
  expect(projection.dispositions[0]).toMatchObject({ claimIdentity: f.anchors[0]!.identity, verdict: 'fixed', standing: 'unresolved',
    asserting: { receivedAt: '2026-09-22T15:00:00.123456Z', occurredAt: '2026-09-22T15:00:00.123450Z' },
    assertion: { receivedAt: '2026-09-22T15:00:00.123456Z' } });
  expect(projection.dispositions[0].unresolved).toContain('eligible-confirmation-unavailable');
  expect(plan.actionableIdentities).toContain(f.anchors[0]!.identity);
});

it('applies and reloads immutable receipt evidence, resumes exact bytes, and rejects persisted receipt tampering', async () => {
  const f = fixture(); f.input.dispositions.push(disposition(f)); const { dir, path } = await install(f);
  const plan = deriveNativeRecovery(f.input);
  const apply = () => withRecoveryTarget(dir, f.input.target, ownership => applyNativeRecovery({ gitCommonDir: dir, plan, ownership }));
  const first = await apply(); expect(first.status).toBe('applied');
  expect(await readFile(first.snapshotPath, 'utf8')).toBe(f.input.sourceJson);
  expect((await loadConvergeRunState(dir, f.input.target))!.rounds).toEqual(JSON.parse(f.input.sourceJson).rounds);
  expect((await apply()).status).toBe('already_applied'); expect(await readFile(path, 'utf8')).toBe(plan.resultJson);
  expect(validateRetainedNativeEvidence({ sourceJson: plan.resultJson, target: f.input.target, reports: f.input.reports,
    nativeSourceJsons: [f.input.sourceJson] }).actionableIdentities).toEqual(plan.actionableIdentities);
  const tampered = JSON.parse(plan.resultJson); tampered.recovery.operations[0].occurrences.transfers[0].receipt.actor_user_id = uuid(999);
  await writeFile(path, JSON.stringify(tampered)); await expect(loadConvergeRunState(dir, f.input.target)).rejects.toThrow(/native_recovery/);
});

it('keeps receipt-time confirmation unresolved after a numeric later empty ordinary round and verdict action', async () => {
  const f = fixture(); f.input.dispositions.push(disposition(f)); const { dir } = await install(f);
  const plan = deriveNativeRecovery(f.input);
  await withRecoveryTarget(dir, f.input.target, ownership => applyNativeRecovery({ gitCommonDir: dir, plan, ownership }));
  const run = sampleRunHeader({ id: uuid(9991), converge: { target: f.input.target, round: 2,
    recovery_source: { version: 1, native_sha256: plan.resultSha256 } } });
  run.gating.bound_classification_protocol = 1;
  const result = await processRoundReport({ gitCommonDir: dir, target: f.input.target, round: 2, runId: run.id, findings: [],
    evidence: { reportJson: JSON.stringify({ run, findings: [] }) } });
  expect(result.actionableIdentities).toContain(f.anchors[0]!.identity);
  const verdict = await recordVerdicts({ gitCommonDir: dir, target: f.input.target, round: 2, verdicts: [] });
  expect(verdict.resolution).toMatchObject({ status: 'unresolved' });
  expect(verdict.resolution!.unresolved).toContain(f.anchors[0]!.identity);
});


it('retains the pinned critical legacy obligation at the filesystem reader boundary', async () => {
  const f = legacyFixture(); f.state.findings[f.key].severity = 'critical'; delete f.state.rounds[0].severities;
  const source = JSON.stringify(f.state);
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'native-critical-'))); directories.push(dir);
  const path = convergeRunStatePath(dir, f.state.target); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const snapshotPath = `${path}.v1-${sha(source)}.snapshot`; await writeFile(snapshotPath, source, { mode: 0o600 });
  const current = { ...f.state, version: 2, sightings: [], findings: { [f.key]: { ...f.state.findings[f.key],
    verdict: 'dismissed', verdictRound: 1, verdictSeverity: 'important' } },
    migration: { sourceSha256: sha(source), snapshotPath, migratedAt: '2026-09-22T01:00:00Z' } };
  await writeFile(path, JSON.stringify(current), { mode: 0o600 });
  await expect(loadConvergeRunState(dir, f.state.target)).rejects.toThrow();
  current.findings[f.key].pendingRound = 1; await writeFile(path, JSON.stringify(current));
  expect((await loadConvergeRunState(dir, f.state.target))!.findings[f.key]!.pendingRound).toBe(1);
});

it.each(['actor', 'microsecond', 'sequence', 'source-head', 'source-target', 'source-bytes', 'different-anchor', 'different-id-selector', 'co-key', 'disposition-payload'])
('refuses %s evidence drift before producing a native result', change => {
  const f = fixture(); f.input.dispositions.push(disposition(f));
  const proof = f.input.transfers[0]!;
  if (change === 'actor') proof.receipt.actor_user_id = uuid(999);
  if (change === 'microsecond') proof.receipt.occurred_at = '2026-09-22T13:00:00.123456Z';
  if (change === 'sequence') proof.receipt.sequence = proof.preparation.carrierContext.eventSequence;
  if (change === 'source-head') proof.preparation.sourceContext.headSha = 'b'.repeat(40);
  if (change === 'source-target') proof.preparation.sourceContext.target = 'another-target';
  if (change === 'source-bytes') proof.preparation.split.source.reportJson += ' ';
  if (change === 'different-anchor') f.input.anchors[0]!.identity = '9999999999999999';
  if (change === 'different-id-selector') {
    const duplicate = structuredClone(proof); duplicate.preparation.eventId = uuid(999); duplicate.receipt.id = uuid(999);
    duplicate.receipt.sequence = 29; f.input.transfers.push(duplicate);
  }
  if (change === 'co-key') (proof.preparation.split.source.storedRun.findings as Array<Record<string, unknown>>)[1].claim_descriptor = null;
  if (change === 'disposition-payload') f.input.dispositions[0].receipt.payload.severity = 'critical';
  expect(() => deriveNativeRecovery(f.input)).toThrow(/native_recovery/);
});

it('preserves conflicting inventory as residual without deleting accepted transfer receipts', () => {
  const f = fixture([1, 2, 3]); f.input.carriers[0]!.sources[0]!.classifications![0]!.actor_user_id = uuid(999);
  const plan = deriveNativeRecovery(f.input); const evidence = JSON.parse(plan.resultJson).recovery.operations[0].occurrences;
  expect(evidence.projection.carriers[0].content.transfers).toHaveLength(3);
  expect(evidence.projection.carriers[0].content.residuals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'classification-conflict' })]));
  expect(plan.actionableIdentities).toContain(f.input.carriers[0]!.carrier.identity);
});

it('adds later occurrence evidence under a new operation without rewriting anchors, snapshots or the previous decision', async () => {
  const f = fixture(); const decision = disposition(f); f.input.dispositions.push(decision);
  const { dir, path } = await install(f); const first = deriveNativeRecovery(f.input);
  await withRecoveryTarget(dir, f.input.target, ownership => applyNativeRecovery({ gitCommonDir: dir, plan: first, ownership }));
  const next = structuredClone(decision); next.preparation.eventId = uuid(9600); next.preparation.verdict = 'dismissed';
  next.preparation.previousDispositionEventId = decision.receipt.id;
  Object.assign(next.preparation, { previousDisposition: decision.receipt });
  next.preparation.sourceContext.eventSequence = decision.receipt.sequence;
  next.preparation.occurredAt = '2026-09-22T16:00:00.123456Z';
  next.receipt = { ...next.receipt, ...prepareClaimDisposition(next.preparation).event, sequence: 31, received_at: '2026-09-22T16:00:00.123457Z' };
  const second = deriveNativeRecovery({ sourceJson: first.resultJson, target: f.input.target, operationId: uuid(9700),
    anchors: [], reports: [], sourceReceipts: [], nativeSourceJsons: [f.input.sourceJson], dispositions: [next] });
  const apply = () => withRecoveryTarget(dir, f.input.target, ownership => applyNativeRecovery({ gitCommonDir: dir, plan: second, ownership }));
  const applied = await apply(); expect(await readFile(applied.snapshotPath, 'utf8')).toBe(first.resultJson);
  expect((await apply()).status).toBe('already_applied');
  const state = (await loadConvergeRunState(dir, f.input.target))!;
  expect(state.recovery!.operations[0]).toEqual(JSON.parse(first.resultJson).recovery.operations[0]);
  expect(state.recovery!.operations[1]!.anchors).toEqual([]);
  const projection = state.recovery!.operations[1]!.occurrences!.projection;
  expect(projection.dispositions).toHaveLength(2); expect(projection.dispositions[1]!.supersedes).toBe(decision.receipt.id);
  expect(second.actionableIdentities).toContain(f.anchors[0]!.identity);
  expect(await readFile(path, 'utf8')).toBe(second.resultJson);
});

it('retains preserved verdict attribution and receipt floor without creating a historical native verdict', () => {
  const f = preserved(); const preparation = f.disposition; const event = prepareClaimDisposition(preparation).event;
  const proof = { preparation, actorUserId: preparation.actorUserId, receipt: { ...preparation.sourceContext.scope, ...event,
    actor_user_id: preparation.actorUserId, attempt: null, sequence: 4, received_at: '2026-09-22T15:00:00.123456Z' } };
  const operationId = uuid(9800); const anchor = correctionAnchor(preparation.split.selection, preparation.split.receipt,
    preparation.split.actorUserId, operationId);
  const plan = deriveNativeRecovery({ sourceJson: preparation.split.selection.nativeJson, target: preparation.sourceContext.target,
    operationId, anchors: [anchor], sourceReceipts: preparation.split.selection.sourceReceipts, reports: [preparation.split.source.reportJson],
    dispositions: [proof] });
  const state = JSON.parse(plan.resultJson); const projected = state.recovery.operations[0].occurrences.projection.dispositions[0];
  expect(projected.assertion).toMatchObject({ actorUserId: f.originalVerdict.actor_user_id, receivedAt: f.originalVerdict.received_at });
  expect(projected.asserting.actorUserId).toBe(preparation.actorUserId); expect(projected.original).toEqual(projected.assertion);
  expect(state.findings).toEqual(JSON.parse(preparation.split.selection.nativeJson).findings);
  expect(plan.actionableIdentities).toContain(anchor.identity);
});


it.each(['read-provenance', 'residual-erasure', 'receipt-time', 'false-standing'])
('refuses persisted %s edits under pure and filesystem revalidation', async change => {
  const f = fixture(); f.input.dispositions.push(disposition(f)); const plan = deriveNativeRecovery(f.input);
  const { dir, path } = await install(f);
  await withRecoveryTarget(dir, f.input.target, ownership => applyNativeRecovery({ gitCommonDir: dir, plan, ownership }));
  const state = JSON.parse(plan.resultJson); const evidence = state.recovery.operations[0].occurrences;
  if (change === 'read-provenance') evidence.projection.readProvenance = 'authenticated';
  if (change === 'residual-erasure') evidence.projection.carriers[0].content.residuals = [];
  if (change === 'receipt-time') evidence.dispositions[0].receipt.received_at = '2026-09-22T15:00:00.123457Z';
  if (change === 'false-standing') evidence.projection.dispositions[0].standing = 'confirmed';
  const corrupt = JSON.stringify(state); await writeFile(path, corrupt);
  expect(() => validateRetainedNativeEvidence({ sourceJson: corrupt, target: f.input.target, reports: f.input.reports,
    nativeSourceJsons: [f.input.sourceJson] })).toThrow(/native_recovery/);
  await expect(loadConvergeRunState(dir, f.input.target)).rejects.toThrow(/native_recovery/);
  expect(await readFile(path, 'utf8')).toBe(corrupt);
});


it('refuses a disposition received one microsecond before the later gated source used for its triage', () => {
  const f = fixture(); const proof = disposition(f); f.input.transfers = [];
  proof.preparation.laterSources = [laterSource(proof.preparation)];
  proof.receipt.received_at = '2026-09-22T14:00:00.123455Z'; f.input.dispositions.push(proof);
  expect(() => deriveNativeRecovery(f.input)).toThrow(/native_recovery/);
  proof.receipt.received_at = '2026-09-22T14:00:00.123456Z';
  expect(deriveNativeRecovery(f.input).actionableIdentities).toContain(f.anchors[0]!.identity);
});

it.each([[1], [1, 2, 3]])('does not manufacture a pending obligation for an entirely nongating classified group (%j)', (...refs) => {
  const input = roundInput(); const report = JSON.parse(input.split.selection.reportJson);
  for (const finding of [...report.findings, ...report.belowThresholdFindings]) finding.gating.reason = 'none';
  const source = JSON.parse(input.split.selection.nativeJson);
  for (const annotation of source.lastAnnotations.identities) annotation.gating = 'none';
  input.split.selection.nativeJson = JSON.stringify(source); input.split.native.sourceJson = input.split.selection.nativeJson;
  rebind(input, report);
  const transfers = refs.map(ref => accepted(input, ref)); const operationId = uuid(9900);
  const anchors = transfers.map(t => correctionAnchor(t.preparation.split.selection, t.preparation.split.receipt,
    t.preparation.split.actorUserId, operationId));
  const plan = deriveNativeRecovery({ sourceJson: input.split.selection.nativeJson, target: input.sourceContext.target, operationId,
    anchors, reports: [input.split.source.reportJson], sourceReceipts: [input.split.source.classification], transfers,
    carriers: [{ carrier: carrier(input.split.source, input.carrierIdentity), inventoryStatus: 'complete', sources: [inventory(input.split.source)] }] });
  expect(plan.actionableIdentities).toEqual([]);
  expect(JSON.parse(plan.resultJson).findings).toEqual(source.findings);
});
