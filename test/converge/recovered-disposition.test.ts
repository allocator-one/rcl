import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicLoopback } from '../evidence/public-claim-loopback.js';
import { fixture, rebind } from '../evidence/recovery-validation/occurrence-fixtures.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { recoveryProjectionFreshness } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import { effectivePendingIdentities, validateNativeRecoveryState } from '../../src/converge/recovery-state.js';
import { loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';
import { recordHealthyRecoveredLaunch } from '../fixtures/guarded-recovered-production.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function recovered(options: { verdict?: 'fixed' | 'dismissed' | 'unresolved';
  severity?: 'important' | 'critical'; noAppendix?: boolean } = {}) {
  const input = fixture();
  input.report.findings[0].severity = options.severity ?? 'important';
  Object.assign(input.report.findings[1], { title: 'Cache stores transient failures',
    description: 'The cache stores transient upstream failures.',
    suggestedFix: 'Do not store upstream timeouts as authoritative missing records.' });
  input.report.findings[1].claimDescriptor = {
    version: 1, operation: 'cache.ts :: cache.write', invariant: 'The cache stores transient upstream failures.',
    evidence: ['Do not store upstream timeouts as authoritative missing records.'],
  };
  if (options.noAppendix) input.report.belowThresholdFindings = [];
  rebind(input.disposition, input.report);
  const f = await publicLoopback(input);
  cleanups.push(f.cleanup);
  await writeFile(f.selectionPath, JSON.stringify({ ...f.selection,
    disposition: options.verdict === 'unresolved' ? undefined : {
      ...f.selection.disposition, verdict: options.verdict ?? 'dismissed', severity: options.severity ?? 'important',
    },
  }));
  const preview = await f.preview();
  expect(preview, preview.stdout + preview.stderr).toMatchObject({ exit: 0 });
  const apply = await f.execute();
  expect(apply, apply.stdout + apply.stderr).toMatchObject({ exit: 0 });
  const common = join(f.repo, '.git');
  const before = (await loadConvergeRunState(common, f.selection.source.target))!;
  let latestAdmission: { runId: string; findings: ConsensusFinding[]; reportJson: string } | undefined;
  async function admit(round: number, severity: ConsensusFinding['severity'] = 'critical', independent = false,
    nativeSha?: string, options: { extraFindings?: ConsensusFinding[]; appendixFindings?: ConsensusFinding[];
      keptCount?: number; reverse?: boolean } = {}) {
    const runId = uuid(800 + round);
    const source = JSON.parse(f.source.reportJson).findings as ConsensusFinding[];
    const selected = [...(independent ? source : source.slice(0, 1)), ...(options.extraFindings ?? [])];
    if (options.reverse) selected.reverse();
    const defaultKeptCount = selected.length;
    selected.push(...(options.appendixFindings ?? []));
    const findings = selected.map((finding, i) => ({
      ...finding, severity, identity: `report:${runId}:${i.toString(16).padStart(16, '0')}`,
    }));
    const keptCount = options.keptCount ?? defaultKeptCount;
    const reportJson = JSON.stringify({ run: { id: runId, converge: {
      target: before.target, round, recovery_source: { version: 1, native_sha256: nativeSha ?? sha(await readFile(f.statePath, 'utf8')) },
    }, gating: { bound_classification_protocol: 1 } }, findings: findings.slice(0, keptCount),
    ...(keptCount < findings.length ? { belowThresholdFindings: findings.slice(keptCount) } : {}) });
    latestAdmission = { runId, findings, reportJson };
    await recordHealthyRecoveredLaunch({ gitCommonDir: common, target: before.target, round, runId, reportJson });
    return processRoundReport({ gitCommonDir: common, target: before.target, round, runId, findings,
      reportSha256: sha(reportJson), evidence: { reportJson } });
  }
  return { ...f, common, before, admit, latestAdmission: () => latestAdmission! };
}

describe('recovered disposition continuation', { timeout: 45000 }, () => {
  it('admits only the current critical sightings after recovery cleared every predecessor obligation', async () => {
    const f = await recovered({ noAppendix: true });
    const source = JSON.parse(f.source.reportJson);
    const selectionPath = join(f.root, 'operation', 'secondary-selection.json');
    const manifestPath = join(f.root, 'operation', 'secondary-manifest.json');
    const secondaryIdentity = sha('independent recovered upper bound').slice(0, 16);
    await writeFile(selectionPath, JSON.stringify({
      ...f.selection,
      findingRef: 'f002',
      identity: secondaryIdentity,
      descriptor: source.findings[1].claimDescriptor,
      disposition: {
        mode: 'fresh', verdict: 'dismissed', severity: 'important',
        reason: 'Synthetic adjudication of the remaining independent source occurrence.',
      },
    }));
    const preview = await f.command(['--preview', '--selection', selectionPath, '--manifest', manifestPath, '--json']);
    expect(preview, preview.stdout + preview.stderr).toMatchObject({ exit: 0 });
    const apply = await f.command(['--apply', '--manifest', manifestPath,
      '--manifest-sha256', sha(await readFile(manifestPath, 'utf8')), '--json']);
    expect(apply, apply.stdout + apply.stderr).toMatchObject({ exit: 0 });
    const predecessor = (await loadConvergeRunState(f.common, f.before.target))!;
    const predecessorJson = await readFile(f.statePath, 'utf8');
    expect(recoveryProjectionFreshness(predecessor)?.validForNative).toBe(true);
    expect(effectivePendingIdentities(predecessor)).toEqual([]);

    const unrelated = {
      ...source.findings[0], file: 'fresh-worker.ts', category: 'correctness', startLine: 40, endLine: 44,
      title: 'Fresh worker drops a committed result',
      description: 'A newly committed worker result can be lost before publication.',
      suggestedFix: 'Persist the committed result before acknowledging the worker.',
      claimDescriptor: { version: 1 as const, operation: 'fresh-worker.ts :: publish',
        invariant: 'Every committed worker result is published exactly once.',
        evidence: ['Persist the committed result before acknowledging the worker.'] },
    } satisfies ConsensusFinding;
    const appendix = {
      ...unrelated, file: 'appendix.ts', startLine: 70, endLine: 71,
      title: 'Appendix observation', description: 'A below-threshold observation remains advisory.',
      suggestedFix: 'Keep the observation below the gating threshold.',
      claimDescriptor: { version: 1 as const, operation: 'appendix.ts :: observe',
        invariant: 'Below-threshold observations do not create gating obligations.',
        evidence: ['Keep the observation below the gating threshold.'] },
    } satisfies ConsensusFinding;
    const admitted = await f.admit(2, 'critical', true, undefined,
      { extraFindings: [unrelated], appendixFindings: [appendix], reverse: true });

    expect(admitted.findings).toHaveLength(4);
    expect(admitted.counts).toEqual({ new: 2, repeat: 0, suppressed: 0, regating: 2 });
    const currentGated = admitted.findings
      .filter(row => row.sighting?.gating !== 'none' && row.status !== 'suppressed')
      .map(row => row.identity).sort();
    expect(admitted.actionableIdentities).toEqual(currentGated);
    expect(admitted.actionableIdentities).toEqual([...new Set(admitted.actionableIdentities)].sort());
    expect(admitted.findings.filter(row => row.status === 'regating')).toHaveLength(2);
    expect(admitted.findings.find(row => row.finding.file === 'appendix.ts')).toMatchObject({
      status: 'new', sighting: { gating: 'none', pendingRound: null },
    });
    expect(admitted.actionableIdentities).not.toContain(
      admitted.findings.find(row => row.finding.file === 'appendix.ts')!.identity,
    );
    expect(admitted.actionableIdentities).not.toContain(f.selection.previousIdentity);
    expect(admitted.legacyPendingIdentities).toBeUndefined();

    const state = (await loadConvergeRunState(f.common, f.before.target))!;
    const round = state.rounds.find(row => row.round === 2)!;
    expect(round.admission).toMatchObject({
      version: 1,
      recoveryOperationCount: predecessor.recovery!.operations.length,
      sourceStateSha256: sha(predecessorJson),
      actionableIdentities: admitted.actionableIdentities,
    });
    expect(state.lastAnnotations?.actionableBeforeTriage).toEqual(admitted.actionableIdentities);
    expect(state.rounds[0]).toEqual(predecessor.rounds[0]);
    expect(state.recovery).toEqual(predecessor.recovery);
    expect(await readFile(`${f.statePath}.recovery-sources/${sha(predecessorJson)}.json`, 'utf8')).toBe(predecessorJson);
    const attempts = (await loadConvergeAttemptState(f.common, f.before.target))!;
    expect(attempts).toMatchObject({ attemptsUsed: 1, lastLaunch: {
      status: 'completed', attempt: 1, round: 2, runId: f.latestAdmission().runId,
      reportJsonSha256: sha(f.latestAdmission().reportJson),
    } });
    const raw = await readFile(f.statePath, 'utf8');
    await expect(validateNativeRecoveryState(state, f.common, Buffer.from(raw))).resolves.toBeUndefined();

    const triaged = admitted.findings.find(row => row.finding.file === 'fresh-worker.ts')!;
    await recordVerdicts({ gitCommonDir: f.common, target: f.before.target, round: 2,
      verdicts: [{ key: triaged.identity, verdict: 'dismissed', reason: 'The publication write is already durable.' }] });
    const replay = await processRoundReport({ gitCommonDir: f.common, target: f.before.target, round: 2,
      runId: f.latestAdmission().runId, findings: f.latestAdmission().findings,
      reportSha256: sha(f.latestAdmission().reportJson), evidence: { reportJson: f.latestAdmission().reportJson } });
    expect(replay.actionableIdentities).toEqual(admitted.actionableIdentities);
    expect(replay.legacyPendingIdentities).toBeUndefined();
    expect((await loadConvergeAttemptState(f.common, f.before.target))!).toEqual(attempts);
  });

  it('re-gates a recovered important dismissal on critical evidence without lending it to an independent claim', async () => {
    const f = await recovered();
    const originalReport = f.source.reportJson;
    const next = await f.admit(2, 'critical', true);
    expect(next.findings[0]).toMatchObject({ identity: f.selection.identity, status: 'regating', sighting: { pendingRound: 2 } });
    expect(next.findings[1]!.identity).not.toBe(f.selection.identity);
    expect(next.findings[1]!.status).toBe('new');
    expect(next.counts).toEqual({ new: 1, repeat: 0, suppressed: 0, regating: 1 });
    expect(next.actionableIdentities).toEqual(expect.arrayContaining([f.selection.previousIdentity, ...next.findings.map(row => row.identity)]));
    const after = (await loadConvergeRunState(f.common, f.before.target))!;
    expect(after.rounds[0]).toEqual(f.before.rounds[0]);
    expect(after.findings[f.selection.previousIdentity]).toEqual(f.before.findings[f.selection.previousIdentity]);
    expect(after.recovery).toEqual(f.before.recovery);
    expect(after.roundCap).toBe(f.before.roundCap);
    expect(after.findings[f.selection.identity]!.verdict).toBeUndefined();
    expect(f.source.reportJson).toBe(originalReport);
    expect(recoveryProjectionFreshness(after)?.validForNative).toBe(false);
    // The retained dismissal remains attributable after an ordinary write;
    // stale remote standing is never used to clear the pending obligation.
    expect((await f.admit(3)).findings[0]!.status).toBe('regating');
    const retriaged = await recordVerdicts({ gitCommonDir: f.common, target: f.before.target, round: 3,
      verdicts: [{ key: f.selection.identity, verdict: 'dismissed', reason: 'Explicit critical re-triage.' }] });
    // Ordinary triage is recorded, but it does not impersonate an authenticated
    // recovery refresh or clear the independent and residual obligations.
    expect(retriaged.resolution).toMatchObject({ status: 'unresolved',
      unresolved: expect.arrayContaining([f.selection.identity, f.selection.previousIdentity, next.findings[1]!.identity]) });
    const triaged = (await loadConvergeRunState(f.common, f.before.target))!;
    expect(triaged.findings[f.selection.identity]).toMatchObject({ verdict: 'dismissed', verdictSeverity: 'critical' });
    expect(triaged.findings[f.selection.identity]!.pendingRound).toBeUndefined();
    expect(recoveryProjectionFreshness(triaged)?.validForNative).toBe(false);
    expect((await f.admit(4)).findings[0]!.status).toBe('suppressed');
  });

  it.each([
    { verdict: 'dismissed', severity: 'important', incoming: 'important' },
    { verdict: 'dismissed', severity: 'critical', incoming: 'critical' },
    { verdict: 'fixed', severity: 'important', incoming: 'critical' },
    { verdict: 'unresolved', severity: 'important', incoming: 'critical' },
  ] as const)('does not infer suppression or escalation from $verdict/$severity followed by $incoming', async ({ verdict, severity, incoming }) => {
    const f = await recovered({ verdict, severity });
    const next = await f.admit(2, incoming);
    expect(next.findings[0]).toMatchObject({ identity: f.selection.identity, status: 'repeat' });
    expect(next.actionableIdentities).toContain(f.selection.identity);
    expect((await loadConvergeRunState(f.common, f.before.target))!.findings[f.selection.identity]!.verdict).toBeUndefined();
  });

  it.each(['material', 'predecessor'] as const)('refuses changed %s proof without admission', async damage => {
    const f = await recovered();
    const original = await readFile(f.statePath, 'utf8');
    if (damage === 'material') {
      const root = f.before.recovery!.operations.at(-1)!.material!.rootSha256;
      await writeFile(`${f.statePath}.recovery-materials/${root}`, 'changed proof');
    }
    await expect(f.admit(2, 'critical', false, damage === 'predecessor' ? 'a'.repeat(64) : undefined))
      .rejects.toThrow(damage === 'material' ? /native_recovery/ : /changed during review/);
    expect(await readFile(f.statePath, 'utf8')).toBe(original);
  });
});
