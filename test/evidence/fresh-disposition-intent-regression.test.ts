import { afterEach, describe, expect, it } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { runPublicClaimRecovery, type PublicClaimRecoveryDeps } from '../../src/evidence/recover-claim.js';
import { publicLoopback } from './public-claim-loopback.js';
import { sha, uuid } from './recovery-validation/fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

describe('fresh disposition intent validation', { timeout: 45000 }, () => {
  it('refuses an original verdict id during preview before persisting an unusable manifest', async () => {
    const f = await publicLoopback(); cleanups.push(f.cleanup);
    const lines: string[] = [];
    const deps: PublicClaimRecoveryDeps = {
      cwd: f.repo, env: f.env, rclVersion: 'test',
      stdout: line => lines.push(line), stderr: () => {},
    };

    expect(await runPublicClaimRecovery({ preview: true, manifest: f.manifest, selection: f.selectionPath }, deps)).toBe(0);
    const originalManifest = await readFile(f.manifest, 'utf8');
    expect(await runPublicClaimRecovery({ apply: true, manifest: f.manifest,
      manifestSha256: sha(originalManifest) }, deps)).toBe(0);

    f.selection.action = 'disposition';
    f.selection.disposition.originalVerdictEventId = uuid(9999);
    await writeFile(f.selectionPath, JSON.stringify(f.selection), { mode: 0o600 });
    const manifest = `${f.manifest}.fresh-disposition`;
    const postsBefore = f.calls.filter(call => call.method === 'POST').length;
    lines.length = 0;

    const previewExit = await runPublicClaimRecovery({ preview: true, manifest, selection: f.selectionPath }, deps);

    expect(previewExit).toBe(4);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: 'refused', reason: 'fresh_disposition_has_original_verdict' });
    expect(await exists(manifest)).toBe(false);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(postsBefore);
  });
});
