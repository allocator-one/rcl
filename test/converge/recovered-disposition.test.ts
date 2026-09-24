import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publicLoopback } from '../evidence/public-claim-loopback.js';
import { fixture, rebind } from '../evidence/recovery-validation/occurrence-fixtures.js';
import { sha, uuid } from '../evidence/recovery-validation/fixtures.js';
import { loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { recoveryProjectionFreshness } from '../../src/evidence/claim-recovery/validation/current-projection.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function recovered(options: { verdict?: 'fixed' | 'dismissed' | 'unresolved'; severity?: 'important' | 'critical' } = {}) {
  const input = fixture();
  input.report.findings[0].severity = options.severity ?? 'important';
  Object.assign(input.report.findings[1], { title: 'Cache stores transient failures',
    description: 'The cache stores transient upstream failures.',
    suggestedFix: 'Do not store upstream timeouts as authoritative missing records.' });
  input.report.findings[1].claimDescriptor = {
    version: 1, operation: 'cache.ts :: cache.write', invariant: 'The cache stores transient upstream failures.',
    evidence: ['Do not store upstream timeouts as authoritative missing records.'],
  };
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
  async function admit(round: number, severity: ConsensusFinding['severity'] = 'critical', independent = false, nativeSha?: string) {
    const runId = uuid(800 + round);
    const source = JSON.parse(f.source.reportJson).findings as ConsensusFinding[];
    const findings = (independent ? source : source.slice(0, 1)).map((finding, i) => ({
      ...finding, severity, identity: `report:${runId}:claim-${i}`,
    }));
    const reportJson = JSON.stringify({ run: { id: runId, converge: {
      target: before.target, round, recovery_source: { version: 1, native_sha256: nativeSha ?? sha(await readFile(f.statePath, 'utf8')) },
    }, gating: { bound_classification_protocol: 1 } }, findings });
    return processRoundReport({ gitCommonDir: common, target: before.target, round, runId, findings, evidence: { reportJson } });
  }
  return { ...f, common, before, admit };
}

describe('recovered disposition continuation', { timeout: 45000 }, () => {
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
