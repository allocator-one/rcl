import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processRoundReport } from '../../src/converge/run-state.js';
import { withNativeTarget } from '../../src/converge/target-ownership.js';

const [gitCommonDir, target, timeout] = process.argv.slice(2);
if (!gitCommonDir || !target) throw new Error('synthetic_arguments_required');
await writeFile(join(gitCommonDir, 'child-ready'), 'ready\n');
try {
  await withNativeTarget(gitCommonDir, target, ownership =>
    processRoundReport({ gitCommonDir, target, ownership, round: 2, findings: [] }),
  timeout === undefined ? {} : { lockTimeoutMs: Number(timeout), lockRetryMs: 1 });
} catch (error) {
  process.stderr.write(`native-target-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
