import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { installRecoveredProduction } from '../fixtures/recovered-production.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { recordHealthyRecoveredLaunch } from '../fixtures/guarded-recovered-production.js';

const fault = vi.hoisted(() => ({ path: '', afterRead: undefined as (() => Promise<void>) | undefined,
  syncFile: '', syncDirectory: '' }));
vi.mock('../../src/telemetry/recovery/files.js', async original => {
  const files = await original<typeof import('../../src/telemetry/recovery/files.js')>();
  return { ...files, readOrdinaryNativeFile: async (...args: Parameters<typeof files.readOrdinaryNativeFile>) => {
    const bytes = await files.readOrdinaryNativeFile(...args);
    if (args[0] === fault.path && fault.afterRead) {
      const afterRead = fault.afterRead;
      fault.afterRead = undefined;
      await afterRead();
    }
    return bytes;
  } };
});
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]) !== fault.syncFile && !String(args[0]).startsWith(`${fault.syncFile}.`)) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === 'sync') return async () => { throw new Error('synthetic_report_file_sync_failure'); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await fs.readFile(...args);
    if (String(args[0]) === fault.path && fault.afterRead) {
      const afterRead = fault.afterRead;
      fault.afterRead = undefined;
      await afterRead();
    }
    return bytes;
  } };
});
vi.mock('../../src/converge/native-lock.js', async original => {
  const locks = await original<typeof import('../../src/converge/native-lock.js')>();
  return { ...locks, syncNativeDirectory: async (path: string) => {
    if (path === fault.syncDirectory) throw new Error('synthetic_report_directory_sync_failure');
    await locks.syncNativeDirectory(path);
  } };
});

const roots: string[] = [];
afterEach(async () => {
  fault.path = ''; fault.afterRead = undefined; fault.syncFile = ''; fault.syncDirectory = '';
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['file', 'directory'] as const)('does not publish native state when retained report %s sync fails', async kind => {
  const f = await fixture();
  const reportPath = `${f.recovered.path}.evidence/${sha(f.reportJson)}.json`;
  if (kind === 'file') fault.syncFile = reportPath;
  else fault.syncDirectory = dirname(reportPath);
  const before = await readFile(f.recovered.path, 'utf8');
  await expect(processRoundReport(f.options)).rejects.toThrow(`synthetic_report_${kind}_sync_failure`);
  expect(await readFile(f.recovered.path, 'utf8')).toBe(before);
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rcl-recovered-canonical-')));
  roots.push(root);
  const canonical = join(root, 'canonical'), diverted = join(root, 'diverted'), alias = join(root, 'alias');
  await mkdir(canonical); await mkdir(diverted); await symlink(canonical, alias);
  const recovered = await installRecoveredProduction(canonical);
  const runId = uuid(801);
  const findings = recovered.report.findings.slice(0, 1).map(finding => ({
    ...finding, identity: `report:${runId}:0000000000000001`, claimDescriptor: recovered.selection.descriptor,
  }));
  const reportJson = JSON.stringify({ run: { id: runId, converge: {
    target: recovered.plan.target, round: 2, recovery_source: { version: 1, native_sha256: sha(recovered.plan.resultJson) },
  }, gating: { bound_classification_protocol: 1 } }, findings });
  await recordHealthyRecoveredLaunch({ gitCommonDir: canonical, target: recovered.plan.target, round: 2, runId, reportJson });
  const options = { gitCommonDir: alias, target: recovered.plan.target, round: 2, runId, findings,
    reportSha256: sha(reportJson), evidence: { reportJson } };
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

it('snapshots caller findings before queued ownership work can observe mutation', async () => {
  const f = await fixture();
  const original = structuredClone(f.options.findings);
  const pending = processRoundReport(f.options);
  f.options.findings[0]!.title = 'Caller mutation after dispatch';
  const admitted = await pending;
  expect(admitted.findings[0]!.finding).toEqual(original[0]);
  expect((await loadConvergeRunState(f.canonical, f.options.target))!.sightings![0]!.reportKey)
    .toBe(original[0]!.identity);
});

it('refuses an unbounded semantic finding batch before allocating the relation graph', async () => {
  const f = await fixture();
  const findings = Array.from({ length: 2_001 }, (_, index) => ({
    ...structuredClone(f.options.findings[0]!),
    identity: `report:${f.options.runId}:${String(index).padStart(16, '0')}`,
  }));
  const report = JSON.parse(f.reportJson); report.findings = findings;
  const reportJson = JSON.stringify(report);
  await recordHealthyRecoveredLaunch({ gitCommonDir: f.canonical, target: f.options.target,
    round: 2, runId: f.options.runId, reportJson });
  await expect(processRoundReport({ ...f.options, findings, reportSha256: sha(reportJson), evidence: { reportJson } }))
    .rejects.toThrow(/at most 2000 findings/);
});

it('writes a recovered verdict in its owned canonical directory when the caller alias moves after the state read', async () => {
  const f = await fixture();
  const admitted = await processRoundReport({ ...f.options, gitCommonDir: f.canonical });
  const key = admitted.findings[0]!.identity;
  const before = await loadConvergeRunState(f.canonical, f.options.target);
  f.retargetAfterOwnedRead();
  await recordVerdicts({ gitCommonDir: f.alias, target: f.options.target, round: 2,
    runId: f.options.runId,
    verdicts: [{ key, verdict: 'dismissed', reason: 'Synthetic source-backed adjudication.' }] });
  expect(await realpath(f.alias)).toBe(f.diverted);
  expect(await readdir(f.diverted)).toEqual([]);
  const state = await loadConvergeRunState(f.canonical, f.options.target);
  expect(state?.findings[key]).toMatchObject({ verdict: 'dismissed', verdictRound: 2 });
  expect(state?.recovery).toEqual(before?.recovery);
  expect(state?.rounds).toEqual(before?.rounds);
});

it('rejects invalid immutable reports under target ownership and releases coordination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rcl-invalid-recovered-report-'));
  roots.push(root);
  await expect(processRoundReport({ gitCommonDir: root, target: 'synthetic-preflight', round: 1,
    findings: [], evidence: { reportJson: 'invalid JSON' } })).rejects.toThrow('Invalid immutable report JSON.');
  expect(await readdir(root)).toEqual(['rcl-native-target-locks']);
  const coordination = await readdir(join(root, 'rcl-native-target-locks'));
  expect(coordination).toEqual([]);
});
