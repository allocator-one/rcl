import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describeClaim } from '../../src/consensus/claim-identity.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';
import {
  convergeRunStatePath, loadConvergeRunState, loadConvergeRunStateEvidence,
  migrateConvergeState, processRoundReport, recordVerdicts,
  type ConvergeRunState, type ProcessRoundOptions,
} from '../../src/converge/run-state.js';
import { sampleFinding } from '../telemetry/fixtures.js';

let dir: string;
const target = 'synthetic-native-integrity';
const runId = '00000000-0000-7000-8000-000000000001';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rcl-native-integrity-'));
  for (const name of ['attempts', 'precision', 'unrelated-outbox']) {
    await writeFile(join(dir, name), `synthetic ${name} must not change`);
  }
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function claim(described = false): ConsensusFinding {
  const finding = sampleFinding({
    identity: `report:${runId}:original`, title: 'Cache entries never expire',
    description: 'The positive cache returns expired entries without testing their TTL.',
  });
  return described ? { ...finding, claimDescriptor: describeClaim(finding) } : finding;
}
function options(round: number, findings: ConsensusFinding[], id = runId): ProcessRoundOptions {
  return { gitCommonDir: dir, target, round, runId: id, findings,
    evidence: { reportJson: JSON.stringify({ run: { id, converge: { target, round } }, findings }) } };
}
async function snapshot(path = dir): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (const name of (await readdir(path)).sort()) {
    const file = join(path, name); const info = await stat(file);
    if (info.isDirectory()) rows.push([name, await snapshot(file)]);
    else rows.push([name, info.mode, info.mtimeMs, createHash('sha256').update(await readFile(file)).digest('hex')]);
  }
  return rows;
}

describe('legacy original bindings', () => {
  it.each([null, 2])('refuses unsupported declared protocol %s before any native write', async protocol => {
    const empty = options(1, []);
    const report = JSON.parse(empty.evidence!.reportJson);
    report.run.gating = { bound_classification_protocol: protocol };
    empty.evidence!.reportJson = JSON.stringify(report);
    const before = await snapshot();
    await expect(processRoundReport(empty)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a declared bound empty round on v1 until explicit migration without changing any retained bytes', async () => {
    await processRoundReport(options(1, [claim()]));
    const empty = options(2, [], '00000000-0000-7000-8000-000000000002');
    const report = JSON.parse(empty.evidence!.reportJson);
    report.run.gating = { bound_classification_protocol: 1 };
    empty.evidence!.reportJson = JSON.stringify(report);
    const source = join(dir, 'declared-original.json');
    await writeFile(source, empty.evidence!.reportJson);
    const before = await snapshot();
    await expect(processRoundReport(empty)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
    expect(await snapshot()).toEqual(before);
    await migrateConvergeState({ gitCommonDir: dir, target, apply: true });
    expect(await processRoundReport(empty)).toMatchObject({ classificationVersion: 1, reportBinding: { round: 2 } });
    expect(await readFile(source, 'utf8')).toBe(empty.evidence!.reportJson);
  });

  it('refuses newly attaching report bytes to a historical unbound current round', async () => {
    const original = claim();
    const first = await processRoundReport({ gitCommonDir: dir, target, round: 1, runId, findings: [original] });
    const verdict = { gitCommonDir: dir, target, round: 1, requireVerifiedBinding: true,
      verdicts: [{ key: first.findings[0]!.identity, verdict: 'dismissed' as const }] };
    await expect(recordVerdicts(verdict)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
    const before = await snapshot();
    await expect(processRoundReport(options(1, [{ ...original, description: 'A replacement explanation is not original evidence.' }])))
      .rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
    expect(await snapshot()).toEqual(before);
    await expect(recordVerdicts(verdict)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
  });

  it('accepts an already-bound v1 replay and rejects a changed or omitted binding', async () => {
    const bound = options(1, [claim()]);
    const first = await processRoundReport(bound);
    expect((await processRoundReport(bound)).findings).toEqual(first.findings);
    for (const replay of [{ ...bound, evidence: undefined }, options(1, [{ ...claim(), description: 'Changed bytes' }])]) {
      const before = await snapshot();
      await expect(processRoundReport(replay)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
      expect(await snapshot()).toEqual(before);
    }
  });

  it('keeps a bound empty next round on v1 without clearing pending obligations', async () => {
    const first = await processRoundReport({ ...options(1, [claim()]), maxRounds: 20 });
    const empty = options(2, [], '00000000-0000-7000-8000-000000000002');
    const processed = await processRoundReport(empty);
    expect(processed.actionableIdentities).toEqual([first.findings[0]!.identity]);
    const state = (await loadConvergeRunState(dir, target))!;
    expect(state).toMatchObject({ version: 1, roundCap: 20 });
    expect(state.rounds[1]).toMatchObject({ round: 2, runId: empty.runId,
      reportBinding: { reportSha256: createHash('sha256').update(empty.evidence!.reportJson).digest('hex') } });
    expect(state.findings[first.findings[0]!.identity]!.pendingRound).toBe(1);
    expect((await recordVerdicts({ gitCommonDir: dir, target, round: 2, verdicts: [], requireVerifiedBinding: true }))
      .resolution?.status).toBe('unresolved');
  });

  it('uses v2 for a new empty target and its next bound empty round', async () => {
    await processRoundReport(options(1, []));
    await processRoundReport(options(2, [], '00000000-0000-7000-8000-000000000002'));
    expect(await loadConvergeRunState(dir, target)).toMatchObject({ version: 2, sightings: [], rounds: [{ round: 1 }, { round: 2 }] });
  });
});

describe('shared semantic ledger validation', () => {
  it('keeps a critical obligation when only a nongating later sighting is dismissed as important', async () => {
    const critical = { ...claim(true), severity: 'critical' as const };
    const first = await processRoundReport(options(1, [critical]));
    const key = first.findings[0]!.identity;
    const id = '00000000-0000-7000-8000-000000000002';
    await processRoundReport(options(2, [{ ...claim(true), identity: `report:${id}:original`, gating: { reason: 'none' } }], id));
    const verdict = await recordVerdicts({ gitCommonDir: dir, target, round: 2, requireVerifiedBinding: true,
      verdicts: [{ key, verdict: 'dismissed' }] });
    expect(verdict.entries[0]).toMatchObject({ verdictRound: 2, verdictSeverity: 'important', pendingRound: 1 });
    expect(verdict.resolution!.unresolved).toEqual([key]);
    const empty = await processRoundReport(options(3, [], '00000000-0000-7000-8000-000000000003'));
    expect(empty.actionableIdentities).toEqual([key]);
    expect((await loadConvergeRunState(dir, target))!.findings[key]!.pendingRound).toBe(1);
  });

  it('advances a still-unresolved obligation on the next gated batch despite an insufficient earlier verdict', async () => {
    const first = await processRoundReport(options(1, [{ ...claim(true), severity: 'critical' }]));
    const key = first.findings[0]!.identity;
    const secondId = '00000000-0000-7000-8000-000000000002';
    await processRoundReport(options(2, [{ ...claim(true), identity: `report:${secondId}:original`, gating: { reason: 'none' } }], secondId));
    await recordVerdicts({ gitCommonDir: dir, target, round: 2, verdicts: [{ key, verdict: 'dismissed' }] });
    const thirdId = '00000000-0000-7000-8000-000000000003';
    const next = await processRoundReport(options(3, [{ ...claim(true), identity: `report:${thirdId}:original` }], thirdId));
    expect(next.findings[0]!.sighting!.pendingRound).toBe(3);
    expect(next.actionableIdentities).toEqual([key]);
    expect((await loadConvergeRunState(dir, target))!.findings[key]).toMatchObject({
      pendingRound: 3, verdictRound: 2, verdictSeverity: 'important',
    });
    const verdict = await recordVerdicts({ gitCommonDir: dir, target, round: 3, verdicts: [{ key, verdict: 'dismissed' }] });
    expect(verdict.resolution!.unresolved).toEqual([]);
    expect((await loadConvergeRunState(dir, target))!.findings[key]!.pendingRound).toBeUndefined();
  });

  it('uses the new gated batch severity when a critical claim recurs as important', async () => {
    const first = await processRoundReport(options(1, [{ ...claim(true), severity: 'critical' }]));
    const key = first.findings[0]!.identity;
    const id = '00000000-0000-7000-8000-000000000002';
    const repeated = await processRoundReport(options(2, [{ ...claim(true), identity: `report:${id}:original` }], id));
    expect(repeated.findings[0]!.sighting!.pendingRound).toBe(2);
    const verdict = await recordVerdicts({ gitCommonDir: dir, target, round: 2, requireVerifiedBinding: true,
      verdicts: [{ key, verdict: 'dismissed' }] });
    expect(verdict.entries[0]).toMatchObject({ verdictRound: 2, verdictSeverity: 'important' });
    expect(verdict.resolution!.unresolved).toEqual([]);
    expect((await processRoundReport(options(3, [], '00000000-0000-7000-8000-000000000003'))).actionableIdentities).toEqual([]);
  });

  for (const migrated of [false, true]) {
    for (const corruption of ['missing pending', 'incorrect pending', 'missing entry'] as const) {
      it(`refuses ${corruption} in ${migrated ? 'migrated' : 'semantic'} state before every consumer`, async () => {
        const first = await processRoundReport(options(1, [claim(!migrated)]));
        const secondId = '00000000-0000-7000-8000-000000000002';
        const second = options(2, [{ ...claim(!migrated), identity: `report:${secondId}:original` }], secondId);
        await processRoundReport(second);
        if (migrated) await migrateConvergeState({ gitCommonDir: dir, target, apply: true });
        const path = convergeRunStatePath(dir, target);
        const state: ConvergeRunState = JSON.parse(await readFile(path, 'utf8'));
        const key = first.findings[0]!.identity;
        expect(state.findings[key]!.pendingRound).toBe(migrated ? 1 : 2);
        if (corruption === 'missing entry') delete state.findings[key];
        else if (corruption === 'missing pending') delete state.findings[key]!.pendingRound;
        else state.findings[key]!.pendingRound = migrated ? 2 : 1;
        await writeFile(path, JSON.stringify(state));
        const before = await snapshot();
        for (const action of [
          () => loadConvergeRunState(dir, target),
          () => processRoundReport(options(3, [], '00000000-0000-7000-8000-000000000003')),
          () => recordVerdicts({ gitCommonDir: dir, target, round: 2, verdicts: [] }),
          () => migrateConvergeState({ gitCommonDir: dir, target, apply: true }),
        ]) {
          await expect(action()).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
          expect(await snapshot()).toEqual(before);
        }
      });
    }
  }

  it('records the difference between a standing fix and a delayed old verdict across a repeat', async () => {
    for (const disposition of ['fixed', 'dismissed'] as const) {
      for (const delayed of [false, true]) {
        const scoped = `${target}-${disposition}-${delayed}`;
        const input = (round: number, findings: ConsensusFinding[]) => {
          const id = `00000000-0000-7000-8000-${String(round).padStart(12, '0')}`;
          const rows = findings.map(f => ({ ...f, identity: `report:${id}:original` }));
          return { ...options(round, rows, id), target: scoped,
            evidence: { reportJson: JSON.stringify({ run: { id, converge: { target: scoped, round } }, findings: rows }) } };
        };
        const first = await processRoundReport(input(1, [claim(true)]));
        const verdict = () => recordVerdicts({ gitCommonDir: dir, target: scoped, round: 1,
          verdicts: [{ key: first.findings[0]!.identity, verdict: disposition }], requireVerifiedBinding: true });
        if (!delayed) await verdict();
        const repeated = await processRoundReport(input(2, [claim(true)]));
        expect(repeated.findings[0]!.sighting).toMatchObject({ pendingRound: delayed ? 2 : null });
        if (delayed) await verdict();
        const empty = await processRoundReport(input(3, []));
        expect(empty.actionableIdentities).toEqual(delayed ? [first.findings[0]!.identity] : []);
        expect(await loadConvergeRunState(dir, scoped)).toBeDefined();
      }
    }
  });

  it.each(['missing', 'future', 'cleared gated'] as const)('refuses a %s immutable pending snapshot', async corruption => {
    await processRoundReport(options(1, [claim(true)]));
    const path = convergeRunStatePath(dir, target);
    const state: ConvergeRunState = JSON.parse(await readFile(path, 'utf8'));
    const sighting = state.sightings![0]! as unknown as Record<string, unknown>;
    if (corruption === 'missing') delete sighting.pendingRound;
    else sighting.pendingRound = corruption === 'future' ? 2 : null;
    await writeFile(path, JSON.stringify(state));
    const before = await snapshot();
    await expect(loadConvergeRunState(dir, target)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
    expect(await snapshot()).toEqual(before);
  });

  it('does not lose an untriaged obligation through a nongating followup snapshot', async () => {
    await processRoundReport(options(1, [claim(true)]));
    const id = '00000000-0000-7000-8000-000000000002';
    const second = await processRoundReport(options(2, [{ ...claim(true), identity: `report:${id}:original`, gating: { reason: 'none' } }], id));
    expect(second.findings[0]!.sighting!.pendingRound).toBe(1);
    const path = convergeRunStatePath(dir, target);
    const state: ConvergeRunState = JSON.parse(await readFile(path, 'utf8'));
    state.sightings![1]!.pendingRound = null;
    delete state.findings[second.findings[0]!.identity]!.pendingRound;
    await writeFile(path, JSON.stringify(state));
    const before = await snapshot();
    await expect(loadConvergeRunState(dir, target)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
    expect(await snapshot()).toEqual(before);
  });

  it('preserves an unchanged legacy verdict with implicit severity through migration', async () => {
    const first = await processRoundReport(options(1, [claim()]));
    const key = first.findings[0]!.identity;
    await recordVerdicts({ gitCommonDir: dir, target, round: 1, verdicts: [{ key, verdict: 'dismissed' }] });
    const path = convergeRunStatePath(dir, target);
    const state: ConvergeRunState = JSON.parse(await readFile(path, 'utf8'));
    delete state.findings[key]!.verdictSeverity;
    await writeFile(path, JSON.stringify(state));
    await migrateConvergeState({ gitCommonDir: dir, target, apply: true });
    expect((await loadConvergeRunState(dir, target))!.findings[key]).toMatchObject({ verdict: 'dismissed', verdictRound: 1 });
  });

  it('keeps migrated and semantic evidence valid across aliases of the same git common directory', async () => {
    const aliases = await mkdtemp(join(tmpdir(), 'rcl-native-alias-'));
    try {
      const alias = join(aliases, 'common');
      await symlink(await realpath(dir), alias, 'dir');
      await processRoundReport({ ...options(1, [claim()]), gitCommonDir: alias });
      const migration = await migrateConvergeState({ gitCommonDir: alias, target, apply: true });
      const original = await readFile(migration.snapshotPath!);
      const canonical = await realpath(dir);
      expect(await loadConvergeRunState(canonical, target)).toMatchObject({ version: 2, sightings: [] });
      const empty = { ...options(2, [], '00000000-0000-7000-8000-000000000002'), gitCommonDir: canonical };
      const result = await processRoundReport(empty);
      expect(result.legacyPendingIdentities).toHaveLength(1);
      const beforeReplay = await snapshot();
      const replay = await processRoundReport({ ...empty, gitCommonDir: alias });
      expect(replay).toEqual({ ...result, reportBinding: { ...result.reportBinding!, sourcePath: replay.reportBinding!.sourcePath } });
      expect(await realpath(replay.reportBinding!.sourcePath)).toBe(await realpath(result.reportBinding!.sourcePath));
      expect(await snapshot()).toEqual(beforeReplay);
      expect(await readFile(migration.snapshotPath!)).toEqual(original);
    } finally { await rm(aliases, { recursive: true, force: true }); }
  });

  it.each(['migration', 'report'] as const)('refuses a copied %s outside its retained path even with identical bytes', async kind => {
    await processRoundReport(options(1, [claim(kind === 'report')]));
    if (kind === 'migration') await migrateConvergeState({ gitCommonDir: dir, target, apply: true });
    const path = convergeRunStatePath(dir, target);
    const state: ConvergeRunState = JSON.parse(await readFile(path, 'utf8'));
    const retained = kind === 'migration' ? state.migration!.snapshotPath : state.rounds[0]!.reportBinding!.sourcePath;
    const substitute = join(dir, 'copied-source.json');
    await writeFile(substitute, await readFile(retained));
    if (kind === 'migration') state.migration!.snapshotPath = substitute;
    else state.rounds[0]!.reportBinding!.sourcePath = substitute;
    await writeFile(path, JSON.stringify(state));
    const before = await snapshot();
    await expect(loadConvergeRunState(dir, target)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses omitting a described original appendix before creating native membership', async () => {
    const input = options(1, []);
    input.evidence!.reportJson = JSON.stringify({ run: { id: runId, converge: { target, round: 1 } },
      findings: [], belowThresholdFindings: [claim(true)] });
    const before = await snapshot();
    await expect(processRoundReport(input)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
    expect(await snapshot()).toEqual(before);
  });

  for (const corruption of ['missing sightings', 'null sighting', 'substituted binding'] as const) {
    for (const operation of ['load', 'replay', 'verdict', 'migration'] as const) {
      it(`refuses ${corruption} before ${operation} can mutate any retained state`, async () => {
        const input = options(1, [claim(true)]);
        const first = await processRoundReport(input);
        const path = convergeRunStatePath(dir, target);
        const state: ConvergeRunState = JSON.parse(await readFile(path, 'utf8'));
        if (corruption === 'missing sightings') delete state.sightings;
        else if (corruption === 'null sighting') state.sightings = [null as never];
        else Object.assign(state.sightings![0]!, { findingRef: 'f999', reportSha256: 'f'.repeat(64), canonicalIdentity: 'ffffffffffffffff' });
        await writeFile(path, JSON.stringify(state));
        const before = await snapshot();
        const action = () => operation === 'load' ? loadConvergeRunStateEvidence(dir, target)
          : operation === 'replay' ? processRoundReport(input)
            : operation === 'migration' ? migrateConvergeState({ gitCommonDir: dir, target, apply: true })
              : recordVerdicts({ gitCommonDir: dir, target, round: 1, requireVerifiedBinding: true,
                verdicts: [{ key: first.findings[0]!.identity, verdict: 'dismissed' }] });
        await expect(action()).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
        expect(await snapshot()).toEqual(before);
      });
    }
  }

  it('retains valid semantic sightings through bound replay and verdict', async () => {
    const input = options(1, [claim(true)]); const first = await processRoundReport(input);
    expect(first).toMatchObject({ classificationVersion: 1, reportBinding: {
      runId, target, round: 1, reportSha256: createHash('sha256').update(input.evidence!.reportJson).digest('hex'),
    } });
    const before = (await loadConvergeRunState(dir, target))!.sightings;
    expect(await processRoundReport(input)).toEqual(first);
    expect((await recordVerdicts({ gitCommonDir: dir, target, round: 1, requireVerifiedBinding: true,
      verdicts: [{ key: first.findings[0]!.identity, verdict: 'dismissed' }] })).resolution?.status).toBe('converged-dismissal-only');
    expect((await loadConvergeRunState(dir, target))!.sightings).toEqual(before);
  });

  it('accepts explicitly migrated legacy sightings[] and preserves the exact v1 snapshot', async () => {
    const first = await processRoundReport({ ...options(1, [claim()]), maxRounds: 20 });
    const path = convergeRunStatePath(dir, target); const original = await readFile(path);
    const before = JSON.parse(original.toString()) as ConvergeRunState;
    const migration = await migrateConvergeState({ gitCommonDir: dir, target, apply: true });
    expect(await readFile(migration.snapshotPath!)).toEqual(original);
    const state = (await loadConvergeRunState(dir, target))!;
    expect(state).toMatchObject({ version: 2, sightings: [], roundCap: 20, rounds: before.rounds });
    expect(await migrateConvergeState({ gitCommonDir: dir, target, apply: true })).toMatchObject({ status: 'already-current', applied: false });
    expect((await recordVerdicts({ gitCommonDir: dir, target, round: 1, requireVerifiedBinding: true,
      verdicts: [{ key: first.findings[0]!.identity, verdict: 'dismissed' }] })).resolution?.status).toBe('converged-dismissal-only');
  });

  it('reports pending migrated legacy identities through empty v2 rounds until their scoped verdict', async () => {
    const legacy = await processRoundReport(options(1, [claim()]));
    const key = legacy.findings[0]!.identity;
    await migrateConvergeState({ gitCommonDir: dir, target, apply: true });
    const empty = options(2, [], '00000000-0000-7000-8000-000000000002');
    const processed = await processRoundReport(empty);
    expect(processed).toMatchObject({ classificationVersion: 1, legacyPendingIdentities: [key], actionableIdentities: [key],
      reportBinding: { round: 2, runId: empty.runId } });
    expect(await processRoundReport(empty)).toEqual(processed);
    expect((await loadConvergeRunState(dir, target))!.sightings).toEqual([]);
    await recordVerdicts({ gitCommonDir: dir, target, round: 1, requireVerifiedBinding: true,
      verdicts: [{ key, verdict: 'dismissed' }] });
    const resolved = await processRoundReport(empty);
    expect(resolved.actionableIdentities).toEqual([]);
    expect(resolved.legacyPendingIdentities).toBeUndefined();
  });

  it.each(['missing member', 'reordered members', 'unrelated canonical identity'] as const)(
    'refuses %s even when the round binding itself is intact', async corruption => {
      const one = claim(true);
      const other = { ...claim(), identity: `report:${runId}:unrelated`, title: 'Cache stores transient failures',
        description: 'An upstream timeout is stored as an authoritative missing record.' };
      const two = { ...other, claimDescriptor: describeClaim(other) };
      const input = options(1, [one, two]);
      await processRoundReport(input);
      const path = convergeRunStatePath(dir, target);
      const state: ConvergeRunState = JSON.parse(await readFile(path, 'utf8'));
      if (corruption === 'missing member') state.sightings!.pop();
      else if (corruption === 'reordered members') state.sightings!.reverse();
      else state.sightings![0]!.canonicalIdentity = state.sightings![1]!.canonicalIdentity;
      await writeFile(path, JSON.stringify(state));
      const before = await snapshot();
      await expect(processRoundReport(input)).rejects.toMatchObject({ code: 'RCL_CONVERGE_RUN_STATE' });
      expect(await snapshot()).toEqual(before);
    });
});
