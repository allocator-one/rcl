import { retainedCycleFixture } from '../fixtures/parent123-retained-cycle.js';
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { validateNativeRecoveryState, verifyNativeRecoveryLineage } from '../../src/converge/recovery-state.js';
import { validateSemanticState } from '../../src/converge/semantic-state.js';
import { semanticFixture, sha, uuid } from '../evidence/recovery-validation/fixtures.js';

const { bundle, plan } = await retainedCycleFixture();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'native-cycle-parity-')));
  roots.push(directory); return directory;
}
async function retain(path: string, raw: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, raw, { mode: 0o600, flag: 'wx' });
}

it.each(['descriptor', 'pending', 'binding', 'sightings', 'migration', 'recovery'])
('native parser refuses released-cycle2 semantic hybrid: %s', field => {
  const state = structuredClone(bundle.native), semantic = semanticFixture(), key = Object.keys(state.findings)[0]!;
  if (field === 'descriptor') state.findings[key].claimDescriptor = semantic.state.findings[semantic.key]!.claimDescriptor;
  if (field === 'pending') state.findings[key].pendingRound = 1;
  if (field === 'binding') state.rounds[0].reportBinding = semantic.state.rounds[0]!.reportBinding;
  if (field === 'sightings') state.sightings = [];
  if (field === 'migration') state.migration = { sourceSha256: sha(bundle.nativeJson), snapshotPath: '/synthetic/snapshot' };
  if (field === 'recovery') state.recovery = { version: 1, operations: [] };
  expect(() => verifyNativeRecoveryLineage(JSON.stringify(state), state.target)).toThrow('native_recovery_lineage_conflict');
});

it('native parser preserves the actual released cycle2 bytes and original accounting', () => {
  const before = bundle.nativeJson;
  const result = verifyNativeRecoveryLineage(before, bundle.native.target);
  expect(result.state).toEqual(bundle.native);
  expect(result.original).toEqual(bundle.native);
  expect(result.state.cycle!.history).toEqual({ attempts: 3, rounds: 1 });
  expect(JSON.parse(bundle.attemptsJson).attemptsUsed).toBe(1);
  expect(bundle.nativeJson).toBe(before);
  for (const entry of Object.values(result.state.findings)) {
    expect(entry).not.toHaveProperty('claimDescriptor');
    expect(entry).not.toHaveProperty('pendingRound');
  }
});

// Later semantic membership is synthetic retained input, not public producer output.
// Original cycle/native/report bytes below are from the sealed actual producer.
async function extended(change?: string) {
  const directory = await root(), state = JSON.parse(plan.resultJson), original = JSON.parse(plan.sourceJson);
  const path = convergeRunStatePath(directory, state.target), semantic = semanticFixture();
  await retain(`${path}.recovery-sources/${sha(plan.sourceJson)}.json`, plan.sourceJson);
  for (const raw of plan.reports) await retain(`${path}.evidence/${sha(raw)}.json`, raw);
  const report: any = structuredClone(semantic.report);
  report.run.cycle_id = state.cycle.id;
  report.run.target.repo = state.cycle.repo;
  report.run.target.pr_number = state.cycle.prNumber;
  report.run.converge = { target: state.target, round: 2 };
  if (change === 'missing-cycle') delete report.run.cycle_id;
  if (change === 'wrong-cycle') report.run.cycle_id = uuid(991);
  if (change === 'wrong-repo') report.run.target.repo = 'unrelated/repository';
  if (change === 'wrong-pr') report.run.target.pr_number++;
  if (change === 'repo-case') report.run.target.repo = state.cycle.repo.toUpperCase();
  const reportJson = JSON.stringify(report), digest = sha(reportJson), reportPath = `${path}.evidence/${digest}.json`;
  await retain(reportPath, reportJson);
  const round = structuredClone(semantic.state.rounds[0]!);
  round.round = 2;
  Object.assign(round.reportBinding, { target: state.target, round: 2, reportSha256: digest, sourcePath: reportPath });
  state.rounds.push(round);
  state.findings[semantic.key] = { ...semantic.state.findings[semantic.key], firstRound: 2, lastRound: 2, pendingRound: 2 };
  state.sightings = [{ ...semantic.state.sightings[0], target: state.target, round: 2, reportSha256: digest, pendingRound: 2 }];
  state.lastAnnotations = { round: 2, identities: semantic.state.lastAnnotations.identities };
  expect(sha(await readFile(reportPath, 'utf8'))).toBe(state.rounds[1].reportBinding.reportSha256);
  expect(state.sightings[0].reportSha256).toBe(digest);
  return { directory, path, state, original, semantic, reportJson };
}

it.each([undefined, 'repo-case'])('physical recovered3 validates exact original and later semantic membership (%s)', async change => {
  const f = await extended(change), raw = JSON.stringify(f.state);
  await expect(validateNativeRecoveryState(f.state, f.directory, Buffer.from(raw))).resolves.toBeUndefined();
  expect(f.state.rounds[0]).toEqual(bundle.native.rounds[0]);
  expect(f.state.cycle).toEqual(bundle.native.cycle);
  expect(f.state.findings[f.semantic.key].pendingRound).toBe(2);
  expect(await readFile(`${f.path}.recovery-sources/${sha(plan.sourceJson)}.json`, 'utf8')).toBe(plan.sourceJson);
  expect(JSON.stringify(f.state)).toBe(raw);
});

it.each(['missing-cycle', 'wrong-cycle', 'wrong-repo', 'wrong-pr'])
('native semantic validator refuses recomputed later report membership: %s', async change => {
  const f = await extended(change), raw = JSON.stringify(f.state);
  // Direct native entry avoids an already-fixed pure validator masking this guard.
  await expect(validateSemanticState(f.state, f.directory, f.original)).rejects.toThrow('immutable membership');
  await expect(validateNativeRecoveryState(f.state, f.directory, Buffer.from(raw))).rejects.toThrow('native_recovery_state_invalid');
  expect(await readFile(`${f.path}.recovery-sources/${sha(plan.sourceJson)}.json`, 'utf8')).toBe(plan.sourceJson);
  expect(JSON.stringify(f.state)).toBe(raw);
});

it.each(['missing-member', 'invented-original-member', 'counts', 'pending'])
('physical recovered3 preserves full later semantic validation: %s', async change => {
  const f = await extended();
  if (change === 'missing-member') f.state.sightings = [];
  if (change === 'invented-original-member') f.state.sightings.push({ ...f.state.sightings[0], round: 1 });
  if (change === 'counts') f.state.rounds[1].counts.new++;
  if (change === 'pending') delete f.state.findings[f.semantic.key].pendingRound;
  await expect(validateNativeRecoveryState(f.state, f.directory, Buffer.from(JSON.stringify(f.state)))).rejects.toThrow('native_recovery_state_invalid');
});

it.each([false, true])('native non-cycle semantic snapshot requires matching absent cycle (%s)', async unexpected => {
  const directory = await root(), f = semanticFixture(), report: any = structuredClone(f.report);
  if (unexpected) report.run.cycle_id = uuid(992);
  const raw = JSON.stringify(report), digest = sha(raw), path = convergeRunStatePath(directory, f.state.target);
  Object.assign(f.state.rounds[0]!.reportBinding, { reportSha256: digest, sourcePath: `${path}.evidence/${digest}.json` });
  f.state.sightings[0]!.reportSha256 = digest;
  await retain(`${path}.evidence/${digest}.json`, raw);
  expect(sha(await readFile(f.state.rounds[0]!.reportBinding.sourcePath, 'utf8'))).toBe(f.state.sightings[0]!.reportSha256);
  expect(f.state).not.toHaveProperty('cycle');
  if (unexpected) await expect(validateSemanticState(f.state as any, directory)).rejects.toThrow('immutable membership');
  else await expect(validateSemanticState(f.state as any, directory)).resolves.toBeUndefined();
});
