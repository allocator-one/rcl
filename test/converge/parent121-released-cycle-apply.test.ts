import { retainedCycleFixture } from '../fixtures/parent123-retained-cycle.js';
import { expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
import { applyNativeRecovery, deriveNativeRecovery } from '../../src/converge/recovery-state.js';
import { withRecoveryTarget } from '../../src/converge/target-ownership.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { validateRetainedNativeEvidence } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';

const { bundle } = await retainedCycleFixture();
async function preserve() {
  expect(await readFile(bundle.runPath, 'utf8')).toBe(bundle.nativeJson);
  expect(await readFile(bundle.attemptPath, 'utf8')).toBe(bundle.attemptsJson);
  expect(await readFile(bundle.archivePath, 'utf8')).toBe(bundle.archiveJson);
}

it('loads actual released cycle2 physical state without inventing semantic sightings', async () => {
  await preserve();
  expect(validateRetainedNativeEvidence({ sourceJson: bundle.nativeJson, target: bundle.selection.target, reports: [] }).state).toEqual(bundle.native);
  try {
    const loaded = await loadConvergeRunState(bundle.root, bundle.selection.target);
    expect(loaded).toEqual(bundle.native);
  } finally { await preserve(); }
});

it('derives, owns, applies, reloads and replays actual released-cycle recovery without changing accounting', async () => {
  await preserve();
  const selection = bundle.selection, operationId = uuid(803);
  const event = prepareClaimSplit(selection).event;
  const receipt = { ...selection.scope, ...event, actor_user_id: uuid(7), attempt: null };
  const anchor = correctionAnchor(selection, receipt, uuid(7), operationId);
  const input = { sourceJson: bundle.nativeJson, target: selection.target, operationId, anchors: [anchor],
    reports: [selection.reportJson], sourceReceipts: selection.sourceReceipts };
  const plan = deriveNativeRecovery(input), result = JSON.parse(plan.resultJson);
  expect(result.cycle).toEqual(bundle.native.cycle);
  expect(result.rounds).toEqual(bundle.native.rounds);
  expect(result.findings).toEqual(bundle.native.findings);
  expect(plan.actionableIdentities).toContain(selection.previousIdentity);
  expect(plan.actionableIdentities).toContain(selection.identity);
  expect(validateRetainedNativeEvidence({ sourceJson: plan.resultJson, target: plan.target, reports: plan.reports,
    nativeSourceJsons: [plan.sourceJson] }).qualification).toBe('content-only');
  let applied = false;
  try {
    const apply = () => withRecoveryTarget(bundle.root, plan.target, ownership =>
      applyNativeRecovery({ gitCommonDir: bundle.root, plan, ownership }));
    const first = await apply(); applied = true;
    expect(first.status).toBe('applied');
    expect(await readFile(first.snapshotPath, 'utf8')).toBe(bundle.nativeJson);
    const loaded = await loadConvergeRunState(bundle.root, plan.target);
    expect(loaded).toEqual(result);
    const before = await stat(bundle.runPath);
    expect((await apply()).status).toBe('already_applied');
    expect((await stat(bundle.runPath)).ino).toBe(before.ino);
    expect(await readFile(bundle.runPath, 'utf8')).toBe(plan.resultJson);
    expect(sha(await readFile(first.snapshotPath, 'utf8'))).toBe(plan.sourceSha256);
  } finally {
    expect(await readFile(bundle.attemptPath, 'utf8')).toBe(bundle.attemptsJson);
    expect(await readFile(bundle.archivePath, 'utf8')).toBe(bundle.archiveJson);
    if (!applied) expect(await readFile(bundle.runPath, 'utf8')).toBe(bundle.nativeJson);
  }
});
