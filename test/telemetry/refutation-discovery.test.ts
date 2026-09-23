import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryRefutations } from '../../src/telemetry/recovery/discovery.js';
import { MAX_REPORT_BYTES, readStable, sha256, writeRecoveryArtifact } from '../../src/telemetry/recovery/files.js';
import { parseSource } from '../../src/telemetry/recovery/source.js';
import { sampleFinding, sampleResult, sampleReview, sampleRunHeader } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'recovery-fixture-')));
  directories.push(path); return path;
}
function report(legacy = false) {
  return sampleResult({ run: legacy ? undefined : sampleRunHeader(), reviews: [sampleReview()],
    findings: [sampleFinding({ gating: { reason: 'none', verification: { verdict: 'refuted', model: 'vendor/verifier', note: 'Original note 🙂' } } })], belowThresholdFindings: [] });
}
function git(path: string, ...args: string[]) { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function initRepo(path: string, repo: string) {
  git(path, 'init'); git(path, 'config', 'user.name', 'Synthetic'); git(path, 'config', 'user.email', 'synthetic@example.test');
  git(path, 'remote', 'add', 'origin', `https://github.com/${repo}.git`);
  git(path, 'commit', '--allow-empty', '-m', 'fixture');
}

describe('machine refutation discovery', () => {
  it('discovers registered external worktrees and follows a custom report reference beyond the roots', async () => {
    const root = await directory(); const outside = await directory();
    initRepo(root, 'owner/source');
    const worktree = join(outside, 'external-worktree'); git(root, 'worktree', 'add', '-b', 'external', worktree);
    const legacy = join(worktree, 'rcl-report-legacy.json'); await writeFile(legacy, JSON.stringify(report(true)));
    const custom = join(outside, 'retained-custom.json'); await writeFile(custom, JSON.stringify(report()));
    await writeFile(join(root, 'rcl-converge-ledger.md'), `Report: \`${custom}\`\n`);
    const found = await inventoryRefutations({ roots: [root] });
    expect(found.reports).toHaveLength(2);
    expect(found.reports.find((s) => s.format === 'legacy')).toMatchObject({ state: 'ready', repo: 'owner/source', paths: [legacy] });
    expect(found.coverage.references).toContain(custom);
    expect(found.coverage.worktrees).toContainEqual({ worktree, repo: 'owner/source' });
  });

  it('binds a referenced legacy report to its retained Git ledger proof, never the invoking cwd', async () => {
    const root = await directory(); const outside = await directory(); initRepo(root, 'owner/proven');
    const custom = join(outside, 'custom.json'); await writeFile(custom, JSON.stringify(report(true)));
    const ledger = join(root, 'rcl-converge-ledger.md'); await writeFile(ledger, `Report: \`${custom}\`\n`);
    const found = await inventoryRefutations({ roots: [root] });
    expect(found.reports[0]).toMatchObject({ state: 'ready', repo: 'owner/proven' });
    expect(found.reports[0]!.repository_proofs[0]).toMatchObject({ worktree: root, repo: 'owner/proven', reference_path: ledger, reference_sha256: sha256(await readFile(ledger)) });
  });

  it('keeps identical legacy evidence copied across two proven repositories unresolved', async () => {
    const roots = await Promise.all([directory(), directory()]);
    for (const [i, root] of roots.entries()) { initRepo(root, `owner/repo${i}`); await writeFile(join(root, 'rcl-report-copy.json'), JSON.stringify(report(true))); }
    const found = await inventoryRefutations({ roots });
    expect(found.reports).toHaveLength(1);
    expect(found.reports[0]).toMatchObject({ state: 'unbound', reason: 'ambiguous_repository' });
    expect(found.reports[0]!.paths).toHaveLength(2);
  });

  it('quarantines different bytes carrying one original run id and excludes every marked synthetic alias', async () => {
    const root = await directory(); const synthetic = join(root, 'synthetic'); await mkdir(synthetic);
    const original = report(); const bytes = JSON.stringify(original);
    await writeFile(join(synthetic, 'SYNTHETIC_TEST_ONLY'), 'test');
    await writeFile(join(synthetic, 'report.json'), bytes); await writeFile(join(root, 'report-copy.json'), bytes);
    original.run = sampleRunHeader({ id: '019921a0-0000-7000-8000-000000000002' });
    await writeFile(join(root, 'report-one.json'), JSON.stringify(original));
    original.findings[0]!.title = 'different'; await writeFile(join(root, 'report-two.json'), JSON.stringify(original));
    const found = await inventoryRefutations({ roots: [root] });
    expect(found.reports.filter((s) => s.state === 'conflict')).toHaveLength(2);
    expect(found.reports.find((s) => s.sha256 === sha256(bytes))).toMatchObject({ state: 'synthetic', paths: expect.any(Array) });
    expect(found.coverage.excluded_sha256).toContain(sha256(bytes));
  });

  it('excludes a referenced synthetic original even when only its child report is inside discovery coverage', async () => {
    const root = await directory(); const outside = await directory(); const child = join(outside, 'child'); await mkdir(child);
    await writeFile(join(outside, 'SYNTHETIC_TEST_ONLY'), 'synthetic');
    const path = join(child, 'retained.json'); await writeFile(path, JSON.stringify(report()));
    await writeFile(join(root, 'rcl-converge-ledger.md'), `Report: \`${path}\`\n`);
    const found = await inventoryRefutations({ roots: [root] });
    expect(found.reports[0]!.state).toBe('synthetic');
  });

  it('accounts for unsupported and incomplete candidates and queued envelopes lacking the original report', async () => {
    const root = await directory(); const queue = join(root, 'outbox', 'queued'); await mkdir(queue, { recursive: true });
    const invalid = { ...report(), run: { ...sampleRunHeader(), rcl_version: 42 } };
    await writeFile(join(root, 'report-unsupported.json'), JSON.stringify(invalid));
    await writeFile(join(root, 'report-incomplete.json'), '');
    await writeFile(join(queue, 'envelope.json'), JSON.stringify({ run: sampleRunHeader(), findings: [], artifacts_declared: [{ kind: 'report_json', sha256: 'a'.repeat(64), bytes: 123 }] }));
    const found = await inventoryRefutations({ roots: [root] });
    expect(found.reports.find((s) => s.sha256 === sha256(JSON.stringify(invalid)))).toMatchObject({ state: 'unsupported', run_id: invalid.run.id, refutations: [{ ref: 'f001', identity: 'abc123def4567890', note: 'Original note 🙂', model: 'vendor/verifier' }] });
    expect(found.coverage.issues).toContainEqual({ path: join(root, 'report-incomplete.json'), reason: 'invalid_or_incomplete_json' });
    expect(found.coverage.issues).toContainEqual({ path: join(queue, 'envelope.json'), reason: 'outbox_original_report_missing' });
  });

  it('does not treat arbitrary model Markdown or credentials as discovery ledgers', async () => {
    const root = await directory(); const out = join(root, 'rcl-output'); const outside = await directory(); await mkdir(out);
    const target = join(outside, 'private.json'); await writeFile(target, JSON.stringify(report()));
    await writeFile(join(out, 'report.md'), `A finding says: report \`${target}\``);
    await writeFile(join(root, 'credentials.json'), JSON.stringify(report()));
    const found = await inventoryRefutations({ roots: [root] });
    expect(found.reports).toEqual([]);
    expect(found.coverage.references).toEqual([]);
  });

  it('rejects symbolic file and directory escapes, FIFOs, excessive sizes and invalid UTF-8', async () => {
    const root = await directory(); const outside = await directory();
    const original = join(outside, 'report.json'); await writeFile(original, JSON.stringify(report()));
    const link = join(root, 'report-link.json'); await symlink(original, link);
    const dirLink = join(root, 'rcl-link'); await symlink(outside, dirLink);
    const fifo = join(root, 'report-pipe.json'); execFileSync('mkfifo', [fifo]);
    const huge = join(root, 'report-huge.json'); await writeFile(huge, ''); await truncate(huge, MAX_REPORT_BYTES + 1);
    const invalid = join(root, 'report-invalid.json'); await writeFile(invalid, Buffer.from([0xc3, 0x28]));
    await expect(readStable(join(dirLink, 'report.json'))).rejects.toThrow('symlink_directory');
    const found = await inventoryRefutations({ roots: [root] });
    expect(found.reports).toEqual([]);
    expect(found.coverage.issues.map((i) => i.reason).sort()).toEqual(['invalid_utf8', 'not_regular', 'oversized', 'symlink_excluded', 'symlink_excluded'].sort());
  });

  it('keeps credential-shaped target metadata and identities out of the local inventory', async () => {
    const root = await directory(); const original = report(); const secret = 'sk-ant-abcdefghijklmnopqrstu';
    original.run!.target.url = 'https://github.com/owner/repo?secret=' + secret;
    original.findings[0]!.identity = secret;
    await writeFile(join(root, 'report.json'), JSON.stringify(original));
    const found = await inventoryRefutations({ roots: [root] });
    expect(found.reports[0]!.state).toBe('unsafe');
    expect(JSON.stringify(found)).not.toContain(secret);
  });

  it('publishes private artifacts exclusively without overwriting an existing source or reviewed manifest', async () => {
    const root = await directory(); const path = join(root, 'manifest.json');
    await writeRecoveryArtifact(path, { kind: 'first' });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(writeRecoveryArtifact(path, { kind: 'second' })).rejects.toThrow();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ kind: 'first' });
  });
});

describe('source normalization and original artifact safety', () => {
  it('accepts fractional verification timeouts from compatible reports', () => {
    const original = report();
    original.run!.gating.verification_timeout_ms = 12.5;
    original.run!.gating.verification_pass_timeout_ms = 37.5;

    expect(parseSource(JSON.stringify(original))).toMatchObject({ format: 'modern' });
  });

  it('retains long model identifiers while detecting secret values hidden by JSON escapes', () => {
    const original = report();
    const model = 'vendor/' + 'AbCd3fGhIjKlMnOp'.repeat(5);
    original.findings[0]!.gating!.verification!.model = model;
    const safe = parseSource(JSON.stringify(original));
    expect(safe.unsafe).toBe(false);
    expect(safe.refutations[0]!.model).toBe(model);
    original.findings[0]!.gating!.verification!.note = 'sk-ant-abcdefghijklmnopqrstu';
    const escaped = JSON.stringify(original).replace('sk-ant-', 'sk-\\u0061nt-');
    expect(parseSource(escaped).unsafe).toBe(true);
  });

  it('represents missing original notes without inventing an explanation', () => {
    const original = report(); delete original.findings[0]!.gating!.verification!.note;
    expect(parseSource(JSON.stringify(original)).refutations[0]).toMatchObject({ note: null, model: 'vendor/verifier' });
  });
  it('does not overlook shadowed JSON values or short sensitive assignments in an original artifact', () => {
    const bytes = JSON.stringify(report());
    const shadowed = bytes.replace('"reviews":', '"discarded":"sk-ant-abcdefghijklmnopqrstu","discarded":"safe","reviews":');
    expect(parseSource(shadowed).unsafe).toBe(true);
    const assignment = bytes.replace('"reviews":', '"token":"short passphrase","reviews":');
    expect(parseSource(assignment).unsafe).toBe(true);
  });

  it('does not exempt an escaped credential in a shadowed JSON value', () => {
    const bytes = JSON.stringify(report());
    const shadowed = bytes.replace('"reviews":', '"discarded":"sk-\\u0061nt-abcdefghijklmnopqrstu","discarded":"safe","reviews":');
    expect(parseSource(shadowed).unsafe).toBe(true);
  });

  it('rejects any duplicate-key artifact, including shadowed arrays and nested objects', () => {
    const bytes = JSON.stringify(report());
    const array = bytes.replace('"reviews":', '"discarded":["sk-\\u0061nt-abcdefghijklmnopqrstu"],"discarded":"safe","reviews":');
    const nested = bytes.replace('"reviews":', '"discarded":{"token":"short passphrase"},"discarded":"safe","reviews":');
    expect(parseSource(array).unsafe).toBe(true);
    expect(parseSource(nested).unsafe).toBe(true);
  });

});
