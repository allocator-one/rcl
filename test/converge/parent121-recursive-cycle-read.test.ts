import { retainedCycleFixture } from '../fixtures/parent123-retained-cycle.js';
import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateNativeRecoveryState } from '../../src/converge/recovery-state.js';
import { validateRetainedNativeEvidence } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { sha } from '../evidence/recovery-validation/fixtures.js';

const reads = vi.hoisted(() => [] as string[]);
vi.mock('../../src/telemetry/recovery/files.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/telemetry/recovery/files.js')>();
  return { ...original, readStable: async (...args: Parameters<typeof original.readStable>) => {
    reads.push(args[0]);
    return original.readStable(...args);
  } };
});

const { bundle, plan } = await retainedCycleFixture();

it('physically validates exact recovered3 lineage from the real released-cycle source', async () => {
  expect(plan.sourceJson).toBe(bundle.nativeJson);
  const state = JSON.parse(plan.resultJson);
  expect(validateRetainedNativeEvidence({ sourceJson: plan.resultJson, target: plan.target, reports: plan.reports,
    nativeSourceJsons: [plan.sourceJson] }).state).toEqual(state);
  // Explicit test-only retention to isolate recursive physical validation.
  // This is not apply success: the actual owned apply failed before retention.
  const artifacts = [[`${bundle.runPath}.recovery-sources/${sha(plan.sourceJson)}.json`, plan.sourceJson],
    ...plan.reports.map((raw: string) => [`${bundle.runPath}.evidence/${sha(raw)}.json`, raw])];
  for (const [path, raw] of artifacts) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, raw, { flag: 'wx', mode: 0o600 });
  }
  try {
    await validateNativeRecoveryState(state, bundle.root, Buffer.from(plan.resultJson));
  } finally {
    expect(await readFile(bundle.runPath, 'utf8')).toBe(bundle.nativeJson);
    expect(await readFile(bundle.attemptPath, 'utf8')).toBe(bundle.attemptsJson);
    expect(await readFile(bundle.archivePath, 'utf8')).toBe(bundle.archiveJson);
    for (const [path, raw] of artifacts) expect(await readFile(path, 'utf8')).toBe(raw);
  }
});

it.each(['anchor', 'round'] as const)('rejects a malformed %s report digest before opening an outside path', async kind => {
  reads.splice(0);
  const state = JSON.parse(plan.resultJson), malicious = '../../outside';
  if (kind === 'anchor') state.recovery.operations[0].anchors[0].source.reportSha256 = malicious;
  else state.rounds[0].reportBinding = { runId: '00000000-0000-7000-8000-000000000099', target: state.target,
    round: state.rounds[0].round, reportSha256: malicious, sourcePath: '/outside' };
  await expect(validateNativeRecoveryState(state, bundle.root, Buffer.from(JSON.stringify(state))))
    .rejects.toThrow('native_recovery_state_invalid');
  expect(reads.some(path => path.includes('outside'))).toBe(false);
});
