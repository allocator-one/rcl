import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const runtimeUrl = process.env.RCL_TEST_PACKAGED_CLI
  ? new URL('./evidence/reviewer-recovery.js', pathToFileURL(process.env.RCL_TEST_PACKAGED_CLI))
  : new URL('../../src/evidence/reviewer-recovery.ts', import.meta.url);
const { applyReviewerRecovery } = await import(runtimeUrl.href);
const runtimeSha256 = createHash('sha256').update(await readFile(runtimeUrl)).digest('hex');
const input = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
await applyReviewerRecovery({ ...input,
  preflight: async () => {}, onLateAuditError: () => {},
  adapterFactory: () => ({ name: 'local-synthetic', provider: 'fake', ask: async () => { throw new Error('unexpected verifier'); },
    review: async (model: string) => {
      await writeFile(process.argv[3]!, JSON.stringify({ model, pid: process.pid,
        runtimeUrl: runtimeUrl.href, runtimeSha256,
        runtimeMode: process.env.RCL_TEST_PACKAGED_CLI ? 'installed' : 'source' }));
      process.exit(73);
    } }),
});
throw new Error('child should exit at its first real adapter invocation');
