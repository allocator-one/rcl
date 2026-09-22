import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runOriginalRecovery, type OriginalRunOptions } from '../../src/evidence/recover-run.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function refusal(change: Partial<OriginalRunOptions>, json = true) {
  const dir = await mkdtemp(join(tmpdir(), 'rcl-selection-')); directories.push(dir);
  const manifest = join(dir, 'private-manifest.json'); const stdout: string[] = []; const stderr: string[] = [];
  const fetchImpl = vi.fn(async () => { throw new Error('unexpected_network'); });
  const exit = await runOriginalRecovery({
    preview: true, json, manifest, run: '00000000-0000-4000-8000-000000000001', forPr: 'allocator-one/rcl#76',
    head: 'a'.repeat(40), reportJson: join(dir, 'private-source.json'), reportSha256: 'b'.repeat(64), originalMode: 'asserted', ...change,
  }, { rclVersion: '3.8.0', cwd: dir, env: {}, fetchImpl: fetchImpl as typeof fetch, stdout: text => stdout.push(text), stderr: text => stderr.push(text) });
  expect(exit).toBe(2); expect(fetchImpl).not.toHaveBeenCalled();
  await expect(readFile(manifest)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await readdir(dir)).toEqual([]);
  const output = [...stdout, ...stderr].join('\n');
  expect(output).not.toContain(dir); expect(output).not.toContain('private-source'); expect(output).not.toContain('private-manifest');
  expect(Buffer.byteLength(output)).toBeLessThan(2048);
  return { output, result: json ? JSON.parse(stdout[0]!) : undefined, stdout, stderr };
}

it('identifies invalid selection flags without printing raw Zod payloads or supplied secrets', async () => {
  const secret = 'secret-selection-value/'.repeat(1000);
  const { output, result } = await refusal({ run: secret, head: secret, originalMode: secret });
  expect(result).toMatchObject({ status: 'incomplete', error: 'invalid_recovery_selection', stage: 'input', exit_code: 2 });
  expect(result.instruction).toContain('--run'); expect(result.instruction).toContain('lowercase UUID');
  expect(result.instruction).toContain('--head'); expect(result.instruction).toContain('--original-mode asserted');
  expect(output).not.toContain('secret-selection-value'); expect(output).not.toContain('invalid_format');
});

it('provides safe explicit PR-format guidance in human diagnostics', async () => {
  const { output, stdout, stderr } = await refusal({ forPr: 'https://secret-user:secret-token@invalid.example/private/pr' }, false);
  expect(stdout).toEqual([]); expect(stderr).toHaveLength(1);
  expect(output).toContain('invalid_recovery_pr'); expect(output).toContain('--for-pr owner/repo#N');
  expect(output).not.toContain('secret-user'); expect(output).not.toContain('secret-token'); expect(output).not.toContain('invalid.example');
});

it.each([{ reportMd: '/private/secret-markdown' }, { markdownSha256: 'b'.repeat(64) }])('explains that Markdown path and digest must be paired: %j', async change => {
  const { output, result } = await refusal(change);
  expect(result).toMatchObject({ error: 'unpaired_recovery_markdown', stage: 'input', exit_code: 2 });
  expect(result.instruction).toContain('--report-md and --markdown-sha256 together'); expect(output).not.toContain('secret-markdown');
});

it('identifies invalid Markdown selection values separately from missing pairing', async () => {
  const { result } = await refusal({ reportMd: '', markdownSha256: 'b'.repeat(64) });
  expect(result.error).toBe('invalid_recovery_selection'); expect(result.instruction).toContain('--report-md');
});
