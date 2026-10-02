import { retainedCycleFixture } from '../fixtures/parent123-retained-cycle.js';
import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateNativeRecoveryState } from '../../src/converge/recovery-state.js';
import { validateRetainedNativeEvidence } from '../../src/evidence/claim-recovery/validation/native-state.js';
import { sha } from '../evidence/recovery-validation/fixtures.js';

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
