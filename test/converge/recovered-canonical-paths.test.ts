import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { installRecoveredProduction } from '../fixtures/recovered-production.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';

const fault = vi.hoisted(() => ({ path: '', afterRead: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await fs.readFile(...args);
    if (String(args[0]) === fault.path && fault.afterRead) {
      const afterRead = fault.afterRead;
      fault.afterRead = undefined;
      await afterRead();
    }
    return bytes;
  } };
});

const roots: string[] = [];
afterEach(async () => {
  fault.path = ''; fault.afterRead = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-recovered-canonical-')));
  roots.push(root);
  const canonical = join(root, 'canonical'), diverted = join(root, 'diverted'), alias = join(root, 'alias');
  await mkdir(canonical); await mkdir(diverted); await symlink(canonical, alias);
  const recovered = await installRecoveredProduction(canonical);
  const runId = uuid(801);
  const findings = recovered.report.findings.slice(0, 1).map(finding => ({
    ...finding, identity: `report:${runId}:claim-1`, claimDescriptor: recovered.selection.descriptor,
  }));
  const reportJson = JSON.stringify({ run: { id: runId, converge: {
    target: recovered.plan.target, round: 2, recovery_source: { version: 1, native_sha256: sha(recovered.plan.resultJson) },
  }, gating: { bound_classification_protocol: 1 } }, findings });
  const options = { gitCommonDir: alias, target: recovered.plan.target, round: 2, runId, findings, evidence: { reportJson } };
  function retargetAfterOwnedRead() {
    fault.path = recovered.path;
    fault.afterRead = async () => { await unlink(alias); await symlink(diverted, alias); };
  }
  return { canonical, diverted, alias, recovered, options, reportJson, retargetAfterOwnedRead };
}

it('retains a recovered report in its owned canonical directory when the caller alias moves after the state read', async () => {
  const f = await fixture();
  f.retargetAfterOwnedRead();
  const admitted = await processRoundReport(f.options);
  const retainedPath = `${f.recovered.path}.evidence/${sha(f.reportJson)}.json`;
  expect(await realpath(f.alias)).toBe(f.diverted);
  expect(admitted.reportBinding?.sourcePath).toBe(retainedPath);
  expect(await readFile(retainedPath, 'utf8')).toBe(f.reportJson);
  expect(await readdir(f.diverted)).toEqual([]);
  const state = await loadConvergeRunState(f.canonical, f.options.target);
  expect(state?.rounds.at(-1)?.reportBinding?.sourcePath).toBe(retainedPath);
  expect(state?.sightings).toHaveLength(f.options.findings.length);
});

it('writes a recovered verdict in its owned canonical directory when the caller alias moves after the state read', async () => {
  const f = await fixture();
  const admitted = await processRoundReport({ ...f.options, gitCommonDir: f.canonical });
  const key = admitted.findings[0]!.identity;
  const before = await loadConvergeRunState(f.canonical, f.options.target);
  f.retargetAfterOwnedRead();
  await recordVerdicts({ gitCommonDir: f.alias, target: f.options.target, round: 2,
    verdicts: [{ key, verdict: 'dismissed', reason: 'Synthetic source-backed adjudication.' }] });
  expect(await realpath(f.alias)).toBe(f.diverted);
  expect(await readdir(f.diverted)).toEqual([]);
  const state = await loadConvergeRunState(f.canonical, f.options.target);
  expect(state?.findings[key]).toMatchObject({ verdict: 'dismissed', verdictRound: 2 });
  expect(state?.recovery).toEqual(before?.recovery);
  expect(state?.rounds).toEqual(before?.rounds);
});

it('rejects invalid immutable reports before creating target coordination files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-invalid-recovered-report-'));
  roots.push(root);
  await expect(processRoundReport({ gitCommonDir: root, target: 'synthetic-preflight', round: 1,
    findings: [], evidence: { reportJson: 'invalid JSON' } })).rejects.toThrow('Invalid immutable report JSON.');
  expect(await readdir(root)).toEqual([]);
});
