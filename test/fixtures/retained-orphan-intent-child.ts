import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Child processes do not inherit the installed-test resolver. Bind every runtime
// import explicitly when the caller supplies an installed CLI entrypoint.
const cli = process.env.RCL_TEST_PACKAGED_CLI;
const root = cli ? dirname(await realpath(cli)) : fileURLToPath(new URL('../../src/', import.meta.url));
const modules: Record<string, { url: string; sha256: string }> = {};
async function runtime(path: string) {
  const file = await realpath(join(root, `${path}.${cli ? 'js' : 'ts'}`));
  const url = pathToFileURL(file).href;
  modules[path] = { url, sha256: createHash('sha256').update(await readFile(file)).digest('hex') };
  return import(url);
}
const { withNativeTarget } = await runtime('converge/target-ownership') as typeof import('../../src/converge/target-ownership.js');
const { CheckpointJournal, decodeCheckpointProof } = await runtime('dispatch/checkpoint') as typeof import('../../src/dispatch/checkpoint.js');
const { recoverCapturedAssignments, recoveryAttemptsFromCheckpoint } = await runtime('dispatch/recovery') as typeof import('../../src/dispatch/recovery.js');
const { encodeRecoveryOperation } = await runtime('dispatch/recovery-operation') as typeof import('../../src/dispatch/recovery-operation.js');

const input = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
const source = decodeCheckpointProof(input.sourceProofBytes);
await withNativeTarget(input.commonDir, source.plan.target, async ownership => {
  const journal = await CheckpointJournal.create({ commonDir: input.commonDir,
    namespace: input.operation.successorRunId, plan: source.plan, ownership });
  await journal.bind('captured-inputs', input.captureBytes, ownership);
  await journal.bind('operation', encodeRecoveryOperation(input.operation), ownership);
  await recoverCapturedAssignments({ commonDir: input.commonDir, ownership, journal,
    expectedPlan: source.plan, sourceAttempts: recoveryAttemptsFromCheckpoint(source.state),
    operation: input.operation, nowMs: () => 1500,
    adapterFactory: () => ({ name: 'synthetic-child', provider: 'fake',
      ask: async () => { throw new Error('unexpected verifier call'); },
      review: async model => {
        await writeFile(process.argv[3]!, JSON.stringify({ model, pid: process.pid, modules }));
        process.exit(73);
      } }),
  });
});
throw new Error('Expected child death after its first durable intent');
