import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, exportCheckpointProof, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { MAX_ARTIFACT_BYTES } from '../../src/telemetry/envelope-validation.js';

const io = vi.hoisted(() => ({ failPath: '', afterManifest: false, synced: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), sync = handle.sync.bind(handle), path = String(args[0]);
    handle.sync = async () => { io.synced.push(path); if (io.failPath === path) {
      const eligible = !io.afterManifest || await fs.lstat(join(path, 'manifest.json')).then(() => true, () => false);
      if (eligible) { io.failPath = ''; throw Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' }); }
    } return sync(); };
    return handle;
  } };
});
const roots: string[] = [];
afterEach(async () => { io.failPath = ''; io.afterManifest = false; io.synced = []; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function canonical(value: any): string { return value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
const target = 'allocator-one/rcl#105', namespace = 'retained-report';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const payload = () => ({ reportBytes: '\uFEFF{ "report": "opaque exact report bytes" }\n', reviewerArtifactBytes: '{\n  "rawFindings": ["private original concern"], "usage": 19\n}\n' });
const rawReview = JSON.stringify({ model: 'fake/model', provider: 'fake', role: 'general', status: 'success', durationMs: 1, findings: [] });
function plan() {
  return freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: sha('patch'), configSha256: sha('config'), specSha256: sha('spec'), contextSha256: sha('context'), toolsSha256: sha('tools'), parser: { name: 'findings-json', version: 1 },
    roster: [{ seat: 'general', model: 'fake/model', role: 'general', route: 'fake' }], chunks: [{ index: 0, total: 1, digest: sha('patch') }],
    prompts: [{ seat: 'general', chunk: 0, systemSha256: sha('system'), userSha256: sha('patch') }] });
}
async function fixture(sealed = true) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-retained-report-'))); roots.push(commonDir);
  const frozen = plan(); let journal!: CheckpointJournal, expired!: NativeTargetOwnership;
  await withNativeTarget(commonDir, target, async ownership => {
    expired = ownership; journal = await CheckpointJournal.create({ commonDir, namespace, plan: frozen, ownership });
    await journal.bind('launch', 'opaque launch', ownership);
    await journal.recordIntent('general:0', { id: 'paid', kind: 'paid' }, ownership);
    await journal.recordResult('general:0', { id: 'paid', kind: 'paid' }, { kind: 'success', chunk: 0, reviewBytes: rawReview }, ownership);
    if (sealed) await journal.finalize(ownership);
  });
  const path = checkpointPath(commonDir, target, namespace);
  return { commonDir, frozen, journal, expired, path, directory: join(path, 'terminal-report') };
}
async function mainFiles(path: string) {
  const names = ['plan.json', 'binding-launch.data', ...(await readdir(join(path, 'events'))).map(name => `events/${name}`), ...(await readdir(join(path, 'results'))).map(name => `results/${name}`)];
  return Promise.all(names.map(async name => ({ name, bytes: await readFile(join(path, name)), inode: (await lstat(join(path, name))).ino })));
}

describe('sealed checkpoint terminal report retention', () => {
  it('retains exact opaque bytes privately, bound to plan/finalization, without changing main proof or counts', async () => {
    const { commonDir, journal, path, directory } = await fixture(), original = await mainFiles(path), state = await journal.read(), proof = await exportCheckpointProof(journal);
    expect(await journal.readTerminalReport()).toBeUndefined(); expect(await readdir(path)).not.toContain('terminal-report');
    await withNativeTarget(commonDir, target, ownership => journal.retainTerminalReport(payload(), ownership));
    const retained = await journal.readTerminalReport(); expect(retained).toEqual({ ...payload(), reportSha256: sha(payload().reportBytes), reviewerArtifactSha256: sha(payload().reviewerArtifactBytes) });
    expect(Object.isFrozen(retained)).toBe(true);
    expect((await lstat(directory)).mode & 0o7777).toBe(0o700);
    expect((await readdir(directory)).sort()).toEqual(['manifest.json', 'report.json', 'reviewer-artifact.json']);
    for (const name of await readdir(directory)) expect((await lstat(join(directory, name))).mode & 0o7777).toBe(0o600);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: 1, planDigest: journal.getPlan().digest, finalizationDigest: state.records.at(-1)!.digest,
      reportSha256: retained!.reportSha256, reviewerArtifactSha256: retained!.reviewerArtifactSha256,
      reportByteLength: Buffer.byteLength(payload().reportBytes), reviewerArtifactByteLength: Buffer.byteLength(payload().reviewerArtifactBytes) });
    expect(await journal.read()).toEqual(state); expect(await exportCheckpointProof(journal)).toEqual(proof); expect(await mainFiles(path)).toEqual(original);
  });

  it('snapshots queued input and reflushes concurrent identical replay without replacing any file', async () => {
    const { commonDir, journal, directory } = await fixture();
    await withNativeTarget(commonDir, target, async ownership => {
      const input = payload(), first = journal.retainTerminalReport(input, ownership); input.reportBytes = 'changed after call';
      await Promise.all([first, journal.retainTerminalReport(payload(), ownership)]);
      const before = await Promise.all((await readdir(directory)).map(async name => ({ name, inode: (await lstat(join(directory, name))).ino, bytes: await readFile(join(directory, name)) })));
      io.synced = []; await journal.retainTerminalReport(payload(), ownership);
      for (const file of before) { expect((await lstat(join(directory, file.name))).ino).toBe(file.inode); expect(await readFile(join(directory, file.name))).toEqual(file.bytes); expect(io.synced).toContain(join(directory, file.name)); }
      expect(io.synced).toContain(directory);
    });
    expect((await journal.readTerminalReport())?.reportBytes).toBe(payload().reportBytes);
  });

  it.each(['reportBytes', 'reviewerArtifactBytes'] as const)('refuses conflicting %s under the same ownership', async field => {
    const { commonDir, journal } = await fixture();
    await expect(withNativeTarget(commonDir, target, async ownership => {
      const results = await Promise.allSettled([journal.retainTerminalReport(payload(), ownership), journal.retainTerminalReport({ ...payload(), [field]: 'different' }, ownership)]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    })).rejects.toThrow('checkpoint_terminal_report_conflict');
    expect(await journal.readTerminalReport()).toMatchObject(payload());
  });

  it('requires a sealed journal and preserves stale, wrong-target and read-only refusal', async () => {
    const { commonDir, journal, path, expired, frozen } = await fixture(false);
    await expect(withNativeTarget(commonDir, target, ownership => journal.retainTerminalReport(payload(), ownership))).rejects.toThrow('checkpoint_terminal_report_requires_finalization');
    await expect(journal.retainTerminalReport(payload(), expired)).rejects.toThrow('native_target_not_owned');
    await expect(withNativeTarget(commonDir, 'foreign', ownership => journal.retainTerminalReport(payload(), ownership))).rejects.toThrow('native_target_not_owned');
    const readOnly = await CheckpointJournal.openRead(path, frozen);
    await expect(withNativeTarget(commonDir, target, ownership => readOnly.retainTerminalReport(payload(), ownership))).rejects.toThrow('checkpoint_read_only');
    expect(await readdir(path)).not.toContain('terminal-report'); expect(await journal.readTerminalReport()).toBeUndefined();
  });

  it.each(['reportBytes', 'reviewerArtifactBytes'] as const)('accepts exactly the real artifact byte cap for %s', async field => {
    const { commonDir, journal } = await fixture(), input = { ...payload(), [field]: 'x'.repeat(MAX_ARTIFACT_BYTES) };
    await withNativeTarget(commonDir, target, ownership => journal.retainTerminalReport(input, ownership));
    const retained = await journal.readTerminalReport(); expect(retained?.[field]).toBe(input[field]); expect(Buffer.byteLength(retained![field])).toBe(25_000_000);
  });

  it.each(['oversized report', 'oversized reviewer', 'empty report', 'empty reviewer', 'invalid unicode', 'unknown input key'])(
    'refuses %s before publishing a directory', async kind => {
      const { commonDir, journal, path } = await fixture(); let input: any = payload();
      if (kind === 'oversized report') input.reportBytes = 'é'.repeat(MAX_ARTIFACT_BYTES / 2) + '!';
      else if (kind === 'oversized reviewer') input.reviewerArtifactBytes = 'x'.repeat(MAX_ARTIFACT_BYTES + 1);
      else if (kind === 'empty report') input.reportBytes = '';
      else if (kind === 'empty reviewer') input.reviewerArtifactBytes = '';
      else if (kind === 'invalid unicode') input.reportBytes = '\ud800';
      else input.authority = 'attested';
      await expect(withNativeTarget(commonDir, target, ownership => journal.retainTerminalReport(input, ownership))).rejects.toThrow();
      expect(await readdir(path)).not.toContain('terminal-report');
    },
  );

  it.each(['manifest file', 'manifest directory'] as const)('replays a complete publication after uncertain %s fsync', async point => {
    const { commonDir, journal, directory } = await fixture();
    await expect(withNativeTarget(commonDir, target, async ownership => {
      io.failPath = point === 'manifest file' ? join(directory, 'manifest.json') : directory;
      io.afterManifest = point === 'manifest directory';
      await journal.retainTerminalReport(payload(), ownership);
    })).rejects.toThrow('synthetic fsync failure');
    expect(await journal.readTerminalReport()).toMatchObject(payload());
    const before = await Promise.all((await readdir(directory)).map(async name => ({ name, bytes: await readFile(join(directory, name)), inode: (await lstat(join(directory, name))).ino })));
    expect(before).toHaveLength(3);
    io.synced = [];
    await withNativeTarget(commonDir, target, async ownership => {
      const reopened = await CheckpointJournal.openWrite({ commonDir, namespace, plan: journal.getPlan(), ownership });
      await reopened.retainTerminalReport(payload(), ownership);
    });
    for (const file of before) { expect(await readFile(join(directory, file.name))).toEqual(file.bytes); expect((await lstat(join(directory, file.name))).ino).toBe(file.inode); expect(io.synced).toContain(join(directory, file.name)); }
    expect(await journal.readTerminalReport()).toMatchObject(payload());
  });

  it.each(['directory', 'report', 'reviewer artifact'] as const)('resumes exact complete payloads after interruption at %s before the manifest', async point => {
    const { commonDir, journal, directory, path } = await fixture(), proof = await exportCheckpointProof(journal);
    await expect(withNativeTarget(commonDir, target, async ownership => {
      io.failPath = point === 'directory' ? path : join(directory, point === 'report' ? 'report.json' : 'reviewer-artifact.json');
      await journal.retainTerminalReport(payload(), ownership);
    })).rejects.toThrow('synthetic fsync failure');
    const before = await Promise.all((await readdir(directory)).map(async name => ({ name, bytes: await readFile(join(directory, name)), inode: (await lstat(join(directory, name))).ino })));
    await expect(journal.readTerminalReport()).rejects.toThrow('checkpoint_terminal_report_incomplete');
    await withNativeTarget(commonDir, target, async ownership => {
      const reopened = await CheckpointJournal.openWrite({ commonDir, namespace, plan: journal.getPlan(), ownership });
      await reopened.retainTerminalReport(payload(), ownership);
    });
    for (const file of before) { expect(await readFile(join(directory, file.name))).toEqual(file.bytes); expect((await lstat(join(directory, file.name))).ino).toBe(file.inode); }
    expect(await journal.readTerminalReport()).toMatchObject(payload()); expect(await exportCheckpointProof(journal)).toEqual(proof);
  });

  it.each(['truncated orphan', 'different replay bytes'] as const)('refuses %s without repairing or extending an unpublished partial set', async kind => {
    const { commonDir, journal, directory } = await fixture(), proof = await exportCheckpointProof(journal);
    await expect(withNativeTarget(commonDir, target, async ownership => { io.failPath = join(directory, 'report.json'); await journal.retainTerminalReport(payload(), ownership); })).rejects.toThrow('synthetic fsync failure');
    const file = join(directory, 'report.json'); if (kind === 'truncated orphan') await writeFile(file, '{');
    const before = await readFile(file), input = kind === 'different replay bytes' ? { ...payload(), reportBytes: 'different identity' } : payload();
    await expect(withNativeTarget(commonDir, target, ownership => journal.retainTerminalReport(input, ownership))).rejects.toThrow('checkpoint_terminal_report_conflict');
    await expect(journal.readTerminalReport()).rejects.toThrow('checkpoint_terminal_report_incomplete');
    expect(await readFile(file)).toEqual(before); expect(await readdir(directory)).toEqual(['report.json']); expect(await exportCheckpointProof(journal)).toEqual(proof);
  });

  it.each(['report bytes', 'reviewer bytes', 'partial report', 'missing published report', 'unknown entry', 'wrong plan', 'wrong finalization', 'wrong hash', 'wrong length', 'unknown manifest key', 'partial manifest', 'manifest symlink', 'report symlink', 'report hardlink', 'artifact hardlink', 'manifest hardlink', 'unsafe file mode', 'directory symlink', 'unsafe directory mode'])(
    'refuses %s while the main proof remains unchanged', async kind => {
      const { commonDir, journal, directory } = await fixture(), proof = await exportCheckpointProof(journal);
      await withNativeTarget(commonDir, target, ownership => journal.retainTerminalReport(payload(), ownership));
      const report = join(directory, 'report.json'), artifact = join(directory, 'reviewer-artifact.json'), manifest = join(directory, 'manifest.json');
      if (kind === 'report bytes') await writeFile(report, payload().reportBytes + '!');
      else if (kind === 'reviewer bytes') await writeFile(artifact, payload().reviewerArtifactBytes + '!');
      else if (kind === 'partial report') await writeFile(report, '{');
      else if (kind === 'missing published report') await unlink(report);
      else if (kind === 'unknown entry') await writeFile(join(directory, 'unexpected'), 'x', { mode: 0o600 });
      else if (kind.startsWith('wrong') || kind === 'unknown manifest key') {
        const value = JSON.parse(await readFile(manifest, 'utf8'));
        if (kind === 'wrong plan') value.planDigest = sha('foreign plan');
        else if (kind === 'wrong finalization') value.finalizationDigest = sha('foreign finalization');
        else if (kind === 'wrong hash') value.reportSha256 = sha('foreign report');
        else if (kind === 'wrong length') value.reportByteLength++;
        else value.authority = 'attested';
        await writeFile(manifest, canonical(value) + '\n');
      } else if (kind === 'partial manifest') await writeFile(manifest, '{');
      else if (kind === 'report symlink' || kind === 'manifest symlink') {
        const file = kind === 'report symlink' ? report : manifest, copy = join(commonDir, 'alias'); await writeFile(copy, await readFile(file), { mode: 0o600 }); await unlink(file); await symlink(copy, file);
      } else if (kind.endsWith('hardlink')) await link(kind === 'artifact hardlink' ? artifact : kind === 'manifest hardlink' ? manifest : report, join(commonDir, 'extra-link'));
      else if (kind === 'unsafe file mode') await chmod(report, 0o644);
      else if (kind === 'unsafe directory mode') await chmod(directory, 0o755);
      else { await rm(directory, { recursive: true }); const alias = join(commonDir, 'alias-dir'); await mkdir(alias, { mode: 0o700 }); await symlink(alias, directory); }
      await expect(journal.readTerminalReport()).rejects.toThrow();
      await expect(withNativeTarget(commonDir, target, ownership => journal.retainTerminalReport(payload(), ownership))).rejects.toThrow();
      expect(await exportCheckpointProof(journal)).toEqual(proof);
    },
  );
});

describe('checkpoint structural inspection', () => {
  it('validates stored plan/history without claiming freshness and produces a read-only handle', async () => {
    const { commonDir, journal, path, frozen } = await fixture();
    const inspected = await CheckpointJournal.inspectRead(path);
    expect(inspected.getPlan()).toEqual(frozen); expect(await inspected.read()).toEqual(await journal.read());
    const changed = freezeCheckpointPlan({ ...frozen, headSha: '9'.repeat(40) });
    await expect(CheckpointJournal.openRead(path, changed)).rejects.toThrow('checkpoint_plan_mismatch');
    await expect(withNativeTarget(commonDir, target, ownership => inspected.retainTerminalReport(payload(), ownership))).rejects.toThrow('checkpoint_read_only');
  });

  it('supports structurally valid unsealed state without inventing finalization or retained report', async () => {
    const { journal, path } = await fixture(false), inspected = await CheckpointJournal.inspectRead(path);
    expect(await inspected.read()).toEqual(await journal.read()); expect((await inspected.read()).finalized).toBe(false);
    expect(await inspected.readTerminalReport()).toBeUndefined(); await expect(exportCheckpointProof(inspected)).rejects.toThrow('checkpoint_proof_unsealed');
  });

  it.each(['plan', 'history', 'result', 'directory alias'] as const)('refuses corrupt %s using the existing decoder', async kind => {
    const { commonDir, journal, path } = await fixture(); let source = path;
    if (kind === 'plan') await writeFile(join(path, 'plan.json'), '{');
    else if (kind === 'history') await writeFile(join(path, 'events', '00000002.json'), '{}');
    else if (kind === 'result') {
      const row = (await journal.read()).records.find(row => row.type === 'result')!;
      await writeFile(join(path, 'results', row.result!.resultFile), rawReview + ' ');
    } else { source = join(commonDir, 'alias'); await symlink(path, source); }
    await expect(CheckpointJournal.inspectRead(source)).rejects.toThrow(kind === 'plan' ? 'checkpoint_invalid_plan' : kind === 'history' ? 'checkpoint_invalid_record' : kind === 'result' ? 'checkpoint_result_tampered' : 'checkpoint_unsafe_directory');
  });
});
