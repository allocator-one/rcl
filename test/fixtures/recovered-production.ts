import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deriveNativeRecovery } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { recoveredFixture, sha, uuid } from '../evidence/recovery-validation/fixtures.js';
export async function installRecoveredProduction(gitCommonDir: string) {
  const f = recoveredFixture();
  const plan = deriveNativeRecovery({ sourceJson: f.sourceJson, target: f.selection.target, operationId: uuid(8),
    anchors: [f.anchor], reports: [f.reportJson], sourceReceipts: f.selection.sourceReceipts });
  const path = convergeRunStatePath(gitCommonDir, plan.target);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, plan.resultJson, { mode: 0o600 });
  await mkdir(`${path}.recovery-sources`, { recursive: true, mode: 0o700 });
  await writeFile(`${path}.recovery-sources/${plan.sourceSha256}.json`, plan.sourceJson, { mode: 0o600 });
  await mkdir(`${path}.evidence`, { recursive: true, mode: 0o700 });
  for (const report of plan.reports) await writeFile(`${path}.evidence/${sha(report)}.json`, report, { mode: 0o600 });
  return { ...f, plan, path };
}
