// Fresh private released-cycle state for each importing test file. No shared fixtures are mutated.
import { afterAll } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releasedLoopbackCycleFixture } from './parent123-cycle.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { deriveNativeRecovery } from '../../src/converge/recovery-state.js';
import { uuid } from '../evidence/recovery-validation/fixtures.js';

export async function retainedCycleFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'retained-cycle-suite-')));
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'rcl-converge-runs'), { mode: 0o700 });
  const fixture = await releasedLoopbackCycleFixture(root, 'https://harness.example');
  const { selection } = fixture;
  const operationId = uuid(803), event = prepareClaimSplit(selection).event;
  const anchor = correctionAnchor(selection, { ...selection.scope, ...event, actor_user_id: uuid(7), attempt: null }, uuid(7), operationId);
  const plan = deriveNativeRecovery({ sourceJson: selection.nativeJson, target: selection.target, operationId,
    anchors: [anchor], reports: [selection.reportJson], sourceReceipts: selection.sourceReceipts });
  return { bundle: { ...fixture, root, target: selection.target, sourceJson: selection.nativeJson,
    nativeJson: selection.nativeJson, reportJson: selection.reportJson }, plan };
}
