import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { deriveNativeRecovery } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath, loadConvergeRunStateEvidence, prepareVerdicts, writeStateIfUnchanged } from '../../src/converge/run-state.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';
import { recoveredFixture, uuid } from '../evidence/recovery-validation/fixtures.js';
import { accepted, projectionFixture } from '../evidence/recovery-validation/carrier-fixtures.js';
import { prepareClaimDisposition } from '../../src/evidence/claim-recovery/validation/occurrence.js';
import type { AcceptedClaimDisposition } from '../../src/evidence/claim-recovery/validation/native-occurrences.js';
import type { ClaimDispositionInput } from '../../src/evidence/claim-recovery/validation/occurrence-types.js';
import { correctionAnchor } from '../../src/evidence/claim-recovery/validation/anchors.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function recovered() {
  const fixture = recoveredFixture();
  const operationId = uuid(8000);
  const event = prepareClaimSplit(fixture.selection).event;
  const anchor = correctionAnchor(fixture.selection, { ...fixture.selection.scope, ...event,
    actor_user_id: uuid(7), converge_target: fixture.selection.target, round: 1, attempt: null }, uuid(7), operationId);
  return { input: { sourceJson: fixture.sourceJson, target: fixture.selection.target, operationId,
    anchors: [anchor], reports: [fixture.reportJson], sourceReceipts: fixture.selection.sourceReceipts },
  key: fixture.key, report: fixture.report };
}
function occurrenceRecovered() {
  const fixture = projectionFixture();
  const transfer = accepted(fixture.input);
  const operationId = uuid(8100);
  const anchor = correctionAnchor(transfer.preparation.split.selection, transfer.preparation.split.receipt,
    transfer.preparation.split.actorUserId, operationId);
  const preparation: ClaimDispositionInput = { eventId: uuid(8101), occurredAt: '2026-09-22T15:00:00.123450Z',
    actorUserId: transfer.actorUserId, split: transfer.preparation.split,
    sourceContext: { ...transfer.preparation.sourceContext, eventSequence: transfer.receipt.sequence }, mode: 'fresh',
    verdict: 'fixed', severity: 'important', reason: 'Exact synthetic occurrence disposition.', previousDispositionEventId: null };
  const event = prepareClaimDisposition(preparation).event;
  const disposition: AcceptedClaimDisposition = { preparation, actorUserId: preparation.actorUserId,
    receipt: { ...preparation.sourceContext.scope, ...event, actor_user_id: preparation.actorUserId, attempt: null,
      sequence: 30, received_at: '2026-09-22T15:00:00.123456Z' } };
  return { input: { sourceJson: fixture.input.split.selection.nativeJson, target: fixture.input.sourceContext.target, operationId,
    anchors: [anchor], reports: [fixture.input.split.source.reportJson], sourceReceipts: [fixture.input.split.source.classification],
    transfers: [transfer], dispositions: [disposition], carriers: [{ carrier: fixture.projection.carrier,
      inventoryStatus: fixture.projection.inventoryStatus, sources: fixture.projection.sources }] } };
}

async function install(plan: ReturnType<typeof deriveNativeRecovery>) {
  const dir = await mkdtemp(join(tmpdir(), 'ordinary-v3-adapter-')); directories.push(dir);
  const path = convergeRunStatePath(dir, plan.target);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, plan.resultJson, { mode: 0o600 });
  await mkdir(`${path}.recovery-sources`, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.recovery-sources/${plan.sourceSha256}.json`, plan.sourceJson, { mode: 0o600 });
  await mkdir(`${path}.evidence`, { recursive: true, mode: 0o700 });
  for (const report of plan.reports) await writeFile(`${path}.evidence/${digest(report)}.json`, report, { mode: 0o600 });
  return { dir, path };
}

it('prepares an ordinary v3 verdict without changing recovery evidence or clearing its pending obligation', () => {
  const source = deriveNativeRecovery(recovered().input);
  const state = JSON.parse(source.resultJson);
  const before = structuredClone(state.recovery);
  const prepared = prepareVerdicts(state, { target: source.target, round: 1,
    verdicts: [{ key: recovered().key, verdict: 'dismissed', reason: 'ordinary synthetic triage' }], recordedAt: '2026-09-23T02:00:00.000Z' });
  expect(prepared.state.recovery).toEqual(before);
  expect(prepared.state.updatedAt).toBe('2026-09-23T02:00:00.000Z');
  expect(prepared.result.resolution?.unresolved).toContain(state.recovery.operations[0].anchors[0].identity);
});

it('uses exact v3 source/next CAS and refuses a changed validated source without mutation', async () => {
  const base = recovered(); const plan = deriveNativeRecovery(base.input); const { dir, path } = await install(plan);
  const source = await loadConvergeRunStateEvidence(dir, plan.target);
  expect(source).toBeDefined();
  const prepared = prepareVerdicts(source!.state, { target: plan.target, round: 1,
    verdicts: [{ key: base.key, verdict: 'dismissed' }], recordedAt: '2026-09-23T02:00:00.000Z' });
  await withNativeTarget(dir, plan.target, ownership => writeStateIfUnchanged(dir, source!.sha256, prepared.state, ownership));
  const next = await readFile(path, 'utf8');
  const beforeReplay = await stat(path, { bigint: true });
  await withNativeTarget(dir, plan.target, ownership => writeStateIfUnchanged(dir, source!.sha256, prepared.state, ownership));
  const afterReplay = await stat(path, { bigint: true });
  expect(await readFile(path, 'utf8')).toBe(next);
  expect(afterReplay.ino).toBe(beforeReplay.ino);
  expect(afterReplay.mtimeNs).toBe(beforeReplay.mtimeNs);
  const changedSource = JSON.stringify({ ...JSON.parse(plan.resultJson), updatedAt: '2026-09-23T12:00:00.000Z' });
  await writeFile(path, changedSource);
  await expect(withNativeTarget(dir, plan.target, ownership => writeStateIfUnchanged(dir, source!.sha256, prepared.state, ownership))).rejects.toThrow(/changed after/);
  expect(await readFile(path, 'utf8')).toBe(changedSource);
});

it('prepares and CAS-publishes ordinary fixed and dismissed verdicts without changing occurrence recovery standing or caller state', async () => {
  const original = occurrenceRecovered();
  const inputBefore = structuredClone(original.input);
  const plan = deriveNativeRecovery(original.input);
  const source = JSON.parse(plan.resultJson);
  const recoveryBefore = structuredClone(source.recovery);
  const effectiveBefore = source.recovery.operations[0].occurrences.projection;
  const key = Object.keys(source.findings)[0]!;
  const fixed = prepareVerdicts(source, { target: plan.target, round: 1,
    verdicts: [{ key, verdict: 'fixed', reason: 'Ordinary source-backed fixture result.' }], recordedAt: '2026-09-23T03:00:00.000Z' });
  const dismissed = prepareVerdicts(source, { target: plan.target, round: 1,
    verdicts: [{ key, verdict: 'dismissed', reason: 'Ordinary source-backed fixture result.' }], recordedAt: '2026-09-23T03:00:00.000Z' });
  expect(original.input).toEqual(inputBefore);
  for (const prepared of [fixed, dismissed]) {
    expect(prepared.state.recovery).toEqual(recoveryBefore);
    expect(prepared.state.recovery.operations[0].occurrences.projection).toEqual(effectiveBefore);
    expect(prepared.result.resolution?.unresolved).toEqual(expect.arrayContaining([
      source.recovery.operations[0].anchors[0].identity,
      original.input.carriers[0]!.carrier.identity,
    ]));
  }
  const { dir, path } = await install(plan);
  const retained = await loadConvergeRunStateEvidence(dir, plan.target);
  await withNativeTarget(dir, plan.target, ownership => writeStateIfUnchanged(dir, retained!.sha256, fixed.state, ownership));
  const published = await loadConvergeRunStateEvidence(dir, plan.target);
  expect(published!.state.recovery).toEqual(recoveryBefore);
  expect(published!.state.recovery.operations[0].occurrences.projection.dispositions[0].standing).toBe('unresolved');
  expect(await readFile(path, 'utf8')).toBe(JSON.stringify(fixed.state, null, 2) + '\n');
});

it.each(['predecessor', 'report', 'receipt'] as const)('refuses a v3 source with a missing retained %s before preparing any native mutation', async (missing) => {
  const plan = deriveNativeRecovery(recovered().input); const { dir, path } = await install(plan);
  if (missing === 'predecessor') await rm(`${path}.recovery-sources/${plan.sourceSha256}.json`);
  if (missing === 'report') await rm(`${path}.evidence/${digest(plan.reports[0] as string)}.json`);
  if (missing === 'receipt') {
    const malformed = JSON.parse(plan.resultJson);
    malformed.recovery.operations[0].sourceReceipts = [];
    await writeFile(path, JSON.stringify(malformed));
  }
  const before = await readFile(path, 'utf8');
  await expect(loadConvergeRunStateEvidence(dir, plan.target)).rejects.toThrow(/native_recovery/);
  expect(await readFile(path, 'utf8')).toBe(before);
});
