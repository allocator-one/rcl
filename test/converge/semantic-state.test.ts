import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describeClaim } from '../../src/consensus/claim-identity.js';
import { processRoundReport, recordVerdicts, loadConvergeRunState, convergeRunStatePath, migrateConvergeState } from '../../src/converge/run-state.js';
import { roundIdentities } from '../../src/telemetry/events.js';
import { sampleFinding } from '../telemetry/fixtures.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'semantic-state-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const f = (title: string, description: string, severity: ConsensusFinding['severity'] = 'important') => {
  const finding = sampleFinding({ title, description, suggestedFix: description, severity });
  return { ...finding, claimDescriptor: describeClaim(finding) };
};
async function round(n: number, findings: ConsensusFinding[], target = 'test') {
  const runId = `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const rows = findings.map((x, i) => ({ ...x, identity: `report:${runId}:${String(i).padStart(16, '0')}` }));
  const reportJson = JSON.stringify({ run: { id: runId, converge: { target, round: n } }, findings: rows });
  return processRoundReport({ gitCommonDir: dir, target, round: n, findings: rows, runId, evidence: { reportJson } });
}
describe('immutable semantic convergence state', () => {
  it('never lends a prior dismissal to a distinct same-location claim', async () => {
    const a = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
    const b = f('Cache stores transient failures', 'An upstream timeout is stored as an authoritative missing record.');
    const first = await round(1, [a]);
    await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 1, verdicts: [{ key: first.findings[0]!.identity, verdict: 'dismissed' }] });
    const next = await round(2, [b]);
    expect(next.findings[0]!.status).toBe('new');
    expect(next.findings[0]!.identity).not.toBe(first.findings[0]!.identity);
    const state = await loadConvergeRunState(dir, 'test');
    expect(state!.version).toBe(2);
    expect(state!.sightings).toHaveLength(2);
    const mapping = roundIdentities(next.findings)[0]!;
    expect(mapping).toMatchObject({ version: 1, finding_ref: 'f001', claim_descriptor: b.claimDescriptor, match_rationale: 'new_claim' });
    expect(mapping.report_json_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('allocates same-batch claims deterministically without sorting report refs', async () => {
    const a = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
    const b = f('Cache stores transient failures', 'An upstream timeout is stored as an authoritative missing record.');
    const ab = await round(1, [a, b], 'ab'); const ba = await round(1, [b, a], 'ba');
    expect(ab.findings.map(x => x.identity)).toEqual(ba.findings.map(x => x.identity).reverse());
    expect(roundIdentities(ab.findings).map(x => x.finding_ref)).toEqual(['f001', 'f002']);
  });
  it('retains original bindings and refuses changed bytes for an already bound round', async () => {
    const a = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
    await round(1, [a]); const path = convergeRunStatePath(dir, 'test'); const before = await readFile(path);
    await expect(round(1, [{ ...a, title: 'Different original bytes' }])).rejects.toThrow(/immutable|bound|different/i);
    expect(await readFile(path)).toEqual(before);
    await round(1, [a]); expect(await readFile(path)).toEqual(before);
  });
  it('keeps a never-triaged gating claim unresolved when a later report calls it repeat', async () => {
    const a = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
    const b = f('Cache stores transient failures', 'An upstream timeout is stored as an authoritative missing record.');
    const first = await round(1, [a]); const next = await round(2, [a, b]);
    const result = await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 2, verdicts: [{ key: next.findings[1]!.identity, verdict: 'dismissed' }] });
    expect(result.resolution).toMatchObject({ status: 'unresolved', unresolved: [first.findings[0]!.identity] });
  });
  it('requires explicit v1 migration and preserves exact original snapshot and caps', async () => {
    await processRoundReport({ gitCommonDir: dir, target: 'test', round: 1, findings: [sampleFinding()] });
    const path = convergeRunStatePath(dir, 'test'); const original = await readFile(path);
    await expect(round(2, [f('A new claim', 'Unrelated cache failures are stored as successful missing records')])).rejects.toThrow(/migrat/i);
    expect(await readFile(path)).toEqual(original);
    const preview = await migrateConvergeState({ gitCommonDir: dir, target: 'test' });
    expect(await readFile(path)).toEqual(original);
    const applied = await migrateConvergeState({ gitCommonDir: dir, target: 'test', apply: true });
    expect(applied.originalSha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(await readFile(applied.snapshotPath!)).toEqual(original);
    expect((await loadConvergeRunState(dir, 'test'))!.roundCap).toBe(JSON.parse(original.toString()).roundCap);
    expect(preview.applied).toBe(false);
  });
});

it('refuses ambiguous and transitive location candidates in both input orders', async () => {
  const claim = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
  const at = (line: number) => ({ ...claim, startLine: line, endLine: line });
  const a = await round(1, [at(10), at(20)], 'ambiguous');
  expect(new Set(a.findings.map(x => x.identity)).size).toBe(2);
  await recordVerdicts({ gitCommonDir: dir, target: 'ambiguous', round: 1, verdicts: a.findings.map(x => ({ key: x.identity, verdict: 'dismissed' })) });
  const b = await round(2, [at(15)], 'ambiguous');
  expect(b.findings[0]).toMatchObject({ status: 'new', sighting: { matchRationale: 'ambiguous' } });
  expect(a.findings.map(x => x.identity)).not.toContain(b.findings[0]!.identity);
  const abc = await round(1, [at(10), at(15), at(20)], 'abc');
  const cba = await round(1, [at(20), at(15), at(10)], 'cba');
  expect(new Set(abc.findings.map(x => x.identity)).size).toBe(3);
  expect(abc.findings.map(x => x.identity)).toEqual(cba.findings.map(x => x.identity).reverse());
  expect(abc.findings.every(x => x.sighting!.matchRationale === 'ambiguous')).toBe(true);
});
it('matches supported title and line drift, retaining highest incoming consensus severity in either order', async () => {
  const important = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
  const critical = { ...important, severity: 'critical' as const };
  for (const target of ['important-first', 'critical-first']) {
    const first = await round(1, [important], target);
    await recordVerdicts({ gitCommonDir: dir, target, round: 1, verdicts: [{ key: first.findings[0]!.identity, verdict: 'dismissed' }] });
    const rows = target === 'important-first' ? [important, critical] : [critical, important];
    const result = await round(2, rows, target);
    expect(result.findings.map(x => x.status)).toEqual(['regating', 'regating']);
    expect(new Set(result.findings.map(x => x.identity))).toEqual(new Set([first.findings[0]!.identity]));
    expect(roundIdentities(result.findings)).toHaveLength(2);
    expect((await loadConvergeRunState(dir, target))!.findings[first.findings[0]!.identity]!.severity).toBe('critical');
  }
  const drift = { ...important, suggestedFix: 'Check the expiry timestamp before returning a cached result.' };
  drift.claimDescriptor = describeClaim(drift);
  const prior = await round(1, [drift], 'drift');
  const shifted = { ...drift, title: 'Expired cache results persist' };
  shifted.claimDescriptor = describeClaim(shifted);
  shifted.startLine += 2; shifted.endLine += 2;
  const after = await round(2, [shifted], 'drift');
  expect(after.findings[0]!.identity).toBe(prior.findings[0]!.identity);
  expect(after.findings[0]!.sighting!.matchRationale).toBe('supported_paraphrase');
});
it('carries obligations through an empty later report and never gates an appendix-only claim', async () => {
  const claim = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
  const first = await round(1, [claim]);
  const empty = await round(2, []);
  expect(empty.actionableIdentities).toEqual([first.findings[0]!.identity]);
  expect((await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 2, verdicts: [] })).resolution!.status).toBe('unresolved');
  const target = 'appendix'; const runId = '00000000-0000-7000-8000-000000000099';
  const below = { ...claim, identity: `report:${runId}:appendix` };
  const reportJson = JSON.stringify({ run: { id: runId, converge: { target, round: 1 } }, findings: [], belowThresholdFindings: [below] });
  const result = await processRoundReport({ gitCommonDir: dir, target, round: 1, runId, findings: [below], evidence: { reportJson } });
  expect(result.actionableIdentities).toEqual([]);
  expect(result.findings[0]!.sighting).toMatchObject({ findingRef: 'f001', belowThreshold: true, gating: 'none' });
});
it('refuses original key/ref/descriptor substitution without native writes', async () => {
  const target = 'tamper'; const runId = '00000000-0000-7000-8000-000000000001';
  const claim = { ...f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.'), identity: `report:${runId}:one` };
  const reportJson = JSON.stringify({ run: { id: runId, converge: { target, round: 1 } }, findings: [claim] });
  await expect(processRoundReport({ gitCommonDir: dir, target, round: 1, runId, findings: [{ ...claim, identity: `report:${runId}:other` }], evidence: { reportJson } })).rejects.toThrow(/original|immutable/i);
  expect(await loadConvergeRunState(dir, target)).toBeUndefined();
  await expect(processRoundReport({ gitCommonDir: dir, target, round: 1, runId, findings: [claim, claim], evidence: { reportJson: JSON.stringify({ run: { id: runId, converge: { target, round: 1 } }, findings: [claim, claim] }) } })).rejects.toThrow(/distinct/);
  expect(await loadConvergeRunState(dir, target)).toBeUndefined();
});
it('migrates without lending legacy verdicts or changing original budgets and precision', async () => {
  await writeFile(join(dir, 'attempt-budget'), 'synthetic attempt cap bytes');
  await writeFile(join(dir, 'precision'), 'synthetic original precision bytes');
  const legacy = await processRoundReport({ gitCommonDir: dir, target: 'test', round: 3, maxRounds: 20, findings: [sampleFinding()] });
  await recordVerdicts({ gitCommonDir: dir, target: 'test', round: 3, verdicts: [{ key: legacy.findings[0]!.identity, verdict: 'dismissed', reason: 'old exact claim only' }] });
  const before = await loadConvergeRunState(dir, 'test');
  await migrateConvergeState({ gitCommonDir: dir, target: 'test', apply: true });
  const migrated = await loadConvergeRunState(dir, 'test');
  expect(migrated!.rounds).toEqual(before!.rounds);
  expect(migrated!.findings).toEqual(before!.findings);
  expect(migrated!.roundCap).toBe(20);
  const modern = await round(4, [f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.')]);
  expect(modern.findings[0]!.status).toBe('new');
  expect(modern.findings[0]!.identity).not.toBe(legacy.findings[0]!.identity);
  expect(await readFile(join(dir, 'attempt-budget'), 'utf8')).toBe('synthetic attempt cap bytes');
  expect(await readFile(join(dir, 'precision'), 'utf8')).toBe('synthetic original precision bytes');
});
it('does not use one broad prior claim as a bridge between disconnected current candidates', async () => {
  const claim = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
  for (const target of ['bridge-forward', 'bridge-reversed']) {
    const first = await round(1, [{ ...claim, startLine: 0, endLine: 50 }], target);
    await recordVerdicts({ gitCommonDir: dir, target, round: 1, verdicts: [{ key: first.findings[0]!.identity, verdict: 'dismissed' }] });
    const rows = [{ ...claim, startLine: 0, endLine: 0 }, { ...claim, startLine: 50, endLine: 50 }];
    const next = await round(2, target === 'bridge-forward' ? rows : rows.reverse(), target);
    expect(next.findings.map(x => x.status)).toEqual(['new', 'new']);
    expect(next.findings.every(x => x.sighting!.matchRationale === 'ambiguous')).toBe(true);
    expect(new Set(next.findings.map(x => x.identity)).size).toBe(2);
    expect(next.findings.map(x => x.identity)).not.toContain(first.findings[0]!.identity);
  }
});
it('preserves verified minor and unknown legacy gating obligations after explicit migration', async () => {
  for (const target of ['minor-verified', 'minor-unknown']) {
    await processRoundReport({ gitCommonDir: dir, target, round: 1, findings: [sampleFinding({ severity: 'minor', gating: { reason: 'verified' } })] });
    const state = (await loadConvergeRunState(dir, target))!;
    const key = Object.keys(state.findings)[0]!;
    delete state.findings[key]!.pendingRound; // actual pre-upgrade v1 did not store this field
    if (target === 'minor-unknown') delete state.lastAnnotations;
    await writeFile(convergeRunStatePath(dir, target), JSON.stringify(state));
    await migrateConvergeState({ gitCommonDir: dir, target, apply: true });
    const next = await round(2, [], target);
    expect(next.actionableIdentities).toEqual([key]);
    expect((await recordVerdicts({ gitCommonDir: dir, target, round: 2, verdicts: [] })).resolution!.unresolved).toEqual([key]);
  }
});
it('creates a pending obligation when an untriaged appendix or nongating claim first becomes gating', async () => {
  const claim = f('Cache entries never expire', 'The positive cache returns expired entries without testing their TTL.');
  for (const target of ['appendix-to-kept', 'nongating-to-gating']) {
    const runId = '00000000-0000-7000-8000-000000000001';
    const first = { ...claim, identity: `report:${runId}:first`, gating: { reason: 'none' as const } };
    const report = { run: { id: runId, converge: { target, round: 1 } }, findings: target === 'appendix-to-kept' ? [] : [first], belowThresholdFindings: target === 'appendix-to-kept' ? [first] : [] };
    await processRoundReport({ gitCommonDir: dir, target, round: 1, runId, findings: [first], evidence: { reportJson: JSON.stringify(report) } });
    const kept = await round(2, [{ ...claim, severity: 'critical', gating: { reason: 'critical' } }], target);
    expect(kept.findings[0]!.status).toBe('repeat');
    expect(kept.actionableIdentities).toEqual([kept.findings[0]!.identity]);
    expect((await recordVerdicts({ gitCommonDir: dir, target, round: 2, verdicts: [] })).resolution!.status).toBe('unresolved');
  }
});
