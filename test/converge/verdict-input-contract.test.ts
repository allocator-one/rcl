import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { correctionAnchor } from '../../src/converge/correction-anchors.js';
import { deriveNativeRecovery } from '../../src/converge/recovery-state.js';
import { convergeRunStatePath, loadConvergeRunStateEvidence, prepareVerdicts, recordVerdicts } from '../../src/converge/run-state.js';
import { prepareClaimSplit } from '../../src/evidence/claim-recovery/validation/claim-split.js';
import { recoveredFixture, sha, uuid } from '../evidence/recovery-validation/fixtures.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(version: 1 | 3, bound = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-verdict-input-'))); roots.push(root);
  const f = recoveredFixture(); const target = f.selection.target;
  const path = convergeRunStatePath(root, target); const source = JSON.parse(f.sourceJson);
  const reportPath = `${path}.evidence/${sha(f.reportJson)}.json`;
  if (bound) source.rounds[0].reportBinding = { runId: f.report.run.id, target, round: 1,
    reportSha256: sha(f.reportJson), sourcePath: reportPath };
  const sourceJson = JSON.stringify(source);
  let raw = sourceJson;
  if (version === 3) {
    const selection = { ...f.selection, nativeJson: sourceJson };
    const event = prepareClaimSplit(selection).event;
    const anchor = correctionAnchor(selection, { ...selection.scope, ...event,
      actor_user_id: uuid(7), converge_target: target, round: 1, attempt: null }, uuid(7), uuid(8));
    raw = deriveNativeRecovery({ sourceJson, target, operationId: uuid(8), anchors: [anchor],
      reports: [f.reportJson], sourceReceipts: selection.sourceReceipts }).resultJson;
    await mkdir(`${path}.recovery-sources`, { recursive: true, mode: 0o700 });
    await writeFile(`${path}.recovery-sources/${sha(sourceJson)}.json`, sourceJson, { mode: 0o600 });
  }
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, f.reportJson, { mode: 0o600 });
  await writeFile(path, raw, { mode: 0o600 });
  expect((await loadConvergeRunStateEvidence(root, target))!.state.version).toBe(version);
  const options = { gitCommonDir: root, target, round: 1,
    verdicts: [{ key: f.key, verdict: 'dismissed' as const, reason: 'Synthetic source-backed triage.' }] };
  return { ...f, root, path, raw, reportPath, options };
}

it.each([1, 3] as const)('requires an original round binding when explicitly requested for v%i', async version => {
  const f = await fixture(version);
  await expect(recordVerdicts({ ...f.options, requireVerifiedBinding: true })).rejects.toThrow(/verified original report binding/);
  expect(await readFile(f.path, 'utf8')).toBe(f.raw);
  const result = await recordVerdicts({ ...f.options, requireVerifiedBinding: false });
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({ key: f.key, verdict: 'dismissed' });
});

it.each([1, 3] as const)('accepts an exact bound v%i verdict and refuses later report-byte drift', async version => {
  const f = await fixture(version, true);
  expect((await recordVerdicts({ ...f.options, requireVerifiedBinding: true })).entries).toHaveLength(1);
  const before = await readFile(f.path, 'utf8');
  await writeFile(f.reportPath, f.reportJson + '\n');
  await expect(recordVerdicts({ ...f.options, requireVerifiedBinding: true })).rejects.toThrow();
  expect(await readFile(f.path, 'utf8')).toBe(before);
});

it.each([[1, 'native'], [3, 'native'], [1, 'pure'], [3, 'pure']] as const)
('refuses duplicate verdict keys at the v%i %s boundary', async (version, boundary) => {
  const f = await fixture(version);
  const source = (await loadConvergeRunStateEvidence(f.root, f.options.target))!.state;
  const before = structuredClone(source);
  for (const verdict of ['fixed', 'dismissed'] as const) {
    const verdicts = [...f.options.verdicts, { key: f.key, verdict, reason: 'A second assertion for the same key.' }];
    if (boundary === 'pure') {
      expect(() => prepareVerdicts(source, { ...f.options, verdicts, recordedAt: '2026-09-24T12:00:00.000Z' }))
        .toThrow(/each finding identity only once/);
    } else {
      await expect(recordVerdicts({ ...f.options, verdicts })).rejects.toThrow(/each finding identity only once/);
    }
    expect(source).toEqual(before);
    expect(await readFile(f.path, 'utf8')).toBe(f.raw);
  }
  expect(prepareVerdicts(source, { ...f.options, recordedAt: '2026-09-24T12:00:00.000Z' }).result.entries).toHaveLength(1);
  expect((await recordVerdicts(f.options)).entries).toHaveLength(1);
});
