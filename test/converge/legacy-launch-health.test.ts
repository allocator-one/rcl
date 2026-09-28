import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardReviewLaunch, type GuardedLaunchOptions } from '../../src/converge/launch-guard.js';
import { convergeRunStatePath, loadConvergeRunState, processRoundReport, recordVerdicts } from '../../src/converge/run-state.js';
import { convergeAttemptStatePath, loadConvergeAttemptState } from '../../src/converge/attempt-budget.js';
import { configDigest, sha256Hex, type RosterEntry } from '../../src/report/run-header.js';
import { sampleFinding, sampleResult, sampleReview } from '../telemetry/fixtures.js';

async function fixture(cap = 35) {
  const common = await realpath(await mkdtemp(join(tmpdir(), 'rcl-legacy-health-')));
  onTestFinished(() => rm(common, { recursive: true, force: true }));
  const target = 'legacy-health';
  const prior = await processRoundReport({ gitCommonDir: common, target, round: 1, findings: [sampleFinding()], maxRounds: 30 });
  await recordVerdicts({ gitCommonDir: common, target, round: 1,
    verdicts: [{ key: prior.findings[0]!.identity, verdict: 'fixed', reason: 'Original fix verified.' }] });
  const config = { models: ['openai/fixture'], quorumFraction: 2 / 3 };
  const roster: RosterEntry[] = Array.from({ length: 17 }, (_, i) => ({ model: 'openai/fixture', role: `role-${i}`, provider: 'openai', lane: 'blocking' }));
  const report = sampleResult({ reviews: [...roster.map((seat, index) => sampleReview({ ...seat,
    status: index < 11 ? 'success' : 'timeout' })), sampleReview({ model: 'async/model', async: true })], findings: [] });
  report.run!.rcl_version = '4.1.12'; report.run!.roster = roster;
  report.run!.config_sha256 = configDigest(config);
  report.run!.converge = { target, round: 2, attempt: 1 };
  report.run!.target.head_sha = 'a'.repeat(40);
  report.stats.totalReviews = 18; report.stats.successfulReviews = 12;
  const reportPath = join(common, 'report.json');
  const text = JSON.stringify(report);
  await writeFile(reportPath, text);
  const run = vi.fn().mockResolvedValue({ runId: report.run!.id, reportJsonSha256: sha256Hex(text),
    successfulReviews: 12, totalReviews: 18, deliveryPending: false });
  const options: GuardedLaunchOptions = { gitCommonDir: common, target, headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64),
    maxAttempts: cap, maxRounds: 30, run, validate: vi.fn(async () => {}) };
  await guardReviewLaunch(options);
  run.mockClear();
  const retry: GuardedLaunchOptions = { ...options, retryReason: 'Original timeouts inspected; explicit bounded retry.',
    legacyRetry: { reportPath, config, roster } };
  const nativePath = convergeRunStatePath(common, target), attemptsPath = convergeAttemptStatePath(common, target);
  const bytes = () => Promise.all([nativePath, attemptsPath].map(path => readFile(path)));
  const mutate = async (change: (r: typeof report, native: Record<string, any>) => void, rebind = true) => {
    const native = JSON.parse(await readFile(nativePath, 'utf8'));
    change(report, native);
    const text = JSON.stringify(report);
    await writeFile(reportPath, text);
    if (rebind) native.lastLaunch.reportJsonSha256 = sha256Hex(text);
    await writeFile(nativePath, JSON.stringify(native));
  };
  return { common, target, report, options, retry, run, bytes, mutate, nativePath, attemptsPath };
}

describe('bound legacy launch health recovery', () => {
  async function mixedFixture(admitted = false) {
    const f = await fixture();
    await f.mutate((report, native) => {
      const roster: RosterEntry[] = Array.from({ length: 14 }, (_, index) => ({
        model: 'openai/fixture', role: `role-${index}`, provider: 'openai',
        lane: index < 10 ? 'blocking' : 'secondary',
      }));
      report.run!.roster = roster;
      report.reviews = [...roster.map((seat, index) => sampleReview({ ...seat,
        status: index >= 6 && index < 10 ? 'timeout' : 'success' })),
      sampleReview({ model: 'async/model', async: true })];
      report.stats.totalReviews = native.lastLaunch.totalReviews = 15;
      report.stats.successfulReviews = native.lastLaunch.successfulReviews = 11;
    });
    f.retry.legacyRetry!.roster = f.report.run!.roster;
    if (admitted) await processRoundReport({ gitCommonDir: f.common, target: f.target,
      round: 2, runId: f.report.run!.id, findings: [], maxRounds: 30 });
    return f;
  }

  it.each([false, true])('uses only 6/10 blocking seats when the legacy mixed-lane source is admitted=%s', async admitted => {
    const f = await mixedFixture(admitted);
    const before = await loadConvergeRunState(f.common, f.target);
    const claims = await loadConvergeAttemptState(f.common, f.target);
    await guardReviewLaunch(f.retry);
    expect(f.run).toHaveBeenCalledWith({ target: f.target, round: admitted ? 3 : 2, attempt: 2 });
    const after = await loadConvergeRunState(f.common, f.target);
    expect(after?.rounds).toEqual(before?.rounds);
    expect(after?.findings).toEqual(before?.findings);
    expect(after?.lastAnnotations).toEqual(before?.lastAnnotations);
    const attempts = await loadConvergeAttemptState(f.common, f.target);
    expect(attempts?.attempts.slice(0, 1)).toEqual(claims?.attempts);
    expect(attempts?.attempts[1]?.retrySource).toMatchObject({ round: 2, attempt: 1,
      reviewerHealth: { successfulSeats: 6, policy: { seatCount: 10, minimumSuccessful: 7 } } });
  });

  it.each(['nonlatest', 'healthy', 'mismatched report', 'duplicate admitted round'])('refuses %s admitted legacy evidence before spending', async mode => {
    const f = await mixedFixture(true);
    if (mode === 'nonlatest') await processRoundReport({ gitCommonDir: f.common, target: f.target,
      round: 3, runId: 'a1111111-1111-4111-8111-111111111111', findings: [], maxRounds: 30 });
    else await f.mutate((report, native) => {
      if (mode === 'healthy') {
        report.reviews[6]!.status = 'success';
        report.stats.successfulReviews++;
        native.lastLaunch.successfulReviews++;
      }
      if (mode === 'mismatched report') report.run!.target.head_sha = 'f'.repeat(40);
      if (mode === 'duplicate admitted round') native.rounds.push({ ...native.rounds[1] });
    });
    const before = await f.bytes();
    await expect(guardReviewLaunch(f.retry)).rejects.toThrow('retry_report_invalid');
    expect(f.run).not.toHaveBeenCalled();
    expect(await f.bytes()).toEqual(before);
  });

  it('allows an ordinary changed-input review after an admitted legacy round without transferring retry proof', async () => {
    const f = await mixedFixture(true);
    const before = await loadConvergeRunState(f.common, f.target);
    const claims = await loadConvergeAttemptState(f.common, f.target);
    await guardReviewLaunch({ ...f.retry, legacyRetry: undefined,
      headSha: 'e'.repeat(40), inputSha256: 'f'.repeat(64) });
    expect(f.run).toHaveBeenCalledWith({ target: f.target, round: 3, attempt: 2 });
    const after = await loadConvergeRunState(f.common, f.target);
    expect(after?.rounds).toEqual(before?.rounds);
    expect(after?.findings).toEqual(before?.findings);
    const spent = await loadConvergeAttemptState(f.common, f.target);
    expect(spent?.attempts.slice(0, 1)).toEqual(claims?.attempts);
    expect(spent?.attempts[1]?.retrySource).toBeUndefined();
  });

  it('charges exactly one same-round attempt and preserves old rounds, findings, cap and claims', async () => {
    const f = await fixture();
    const before = await loadConvergeRunState(f.common, f.target);
    const spent = await loadConvergeAttemptState(f.common, f.target);
    await guardReviewLaunch(f.retry);
    const after = await loadConvergeRunState(f.common, f.target);
    const attempts = await loadConvergeAttemptState(f.common, f.target);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledWith({ target: f.target, round: 2, attempt: 2 });
    expect(after?.rounds).toEqual(before?.rounds);
    expect(after?.findings).toEqual(before?.findings);
    expect(after?.roundCap).toBe(30);
    expect(attempts).toMatchObject({ attemptsUsed: 2, cap: 35 });
    expect(attempts?.attempts.slice(0, 1)).toEqual(spent?.attempts);
    const source = attempts!.attempts[1]!.retrySource!;
    const original = JSON.parse(await readFile(join(f.common, 'rcl-converge-attempts', 'sources', source.nativeStateSha256), 'utf8'));
    expect(original.lastLaunch).toMatchObject({ successfulReviews: 12, totalReviews: 18 });
    expect(original.lastLaunch.reviewerHealth).toBeUndefined();
  });

  it.each([
    ['report digest', (r: any) => { r.stats.durationMs++; }, false],
    ['run', (r: any) => { r.run.id = '01a0e4ac-58d9-7cc5-a722-0b50ed087b7a'; }],
    ['target', (r: any) => { r.run.converge.target = 'foreign'; }],
    ['head', (r: any) => { r.run.target.head_sha = 'f'.repeat(40); }],
    ['round', (r: any) => { r.run.converge.round++; }],
    ['round beyond admitted history', (r: any, n: any) => { r.run.converge.round++; n.lastLaunch.round++; }],
    ['attempt', (r: any) => { r.run.converge.attempt++; }],
    ['claim owner', (_r: any, n: any) => { n.lastLaunch.pid++; }],
    ['cycle', (r: any) => { r.run.cycle_id = '01a0e4ac-58d9-7cc5-a722-0b50ed087b7a'; }],
    ['config', (r: any) => { r.run.config_sha256 = 'f'.repeat(64); }],
    ['roster', (r: any) => { r.run.roster[0].provider = 'foreign'; }],
    ['missing seat', (r: any, n: any) => { r.reviews.splice(16, 1); r.stats.totalReviews--; n.lastLaunch.totalReviews--; }],
    ['duplicate seat', (r: any) => { r.reviews[1] = r.reviews[0]; }],
    ['foreign seat', (r: any) => { r.reviews[1].role = 'foreign'; }],
    ['unknown producer', (r: any) => { r.run.rcl_version = '1.0.0'; }],
    ['backfill', (r: any) => { r.run.provenance = 'backfill'; }],
    ['healthy', (r: any, n: any) => { r.reviews[11].status = 'success'; r.stats.successfulReviews++; n.lastLaunch.successfulReviews++; }],
  ] as const)('refuses %s even when other recorded digests are rebound', async (_label, mutate, rebind) => {
    const f = await fixture();
    await f.mutate(mutate, rebind !== false);
    const before = await f.bytes();
    await expect(guardReviewLaunch(f.retry)).rejects.toThrow('retry_report_invalid');
    expect(f.run).not.toHaveBeenCalled();
    expect(await f.bytes()).toEqual(before);
  });

  it('uses validated original proof for one changed-input attempt without transferring its findings or approval', async () => {
    const f = await fixture();
    const before = await loadConvergeRunState(f.common, f.target);
    const claims = await loadConvergeAttemptState(f.common, f.target);
    const changed = { ...f.retry, headSha: 'f'.repeat(40), inputSha256: 'e'.repeat(64) };

    await guardReviewLaunch(changed);

    expect(f.run).toHaveBeenCalledWith({ target: f.target, round: 2, attempt: 2 });
    const after = await loadConvergeRunState(f.common, f.target);
    expect(after?.rounds).toEqual(before?.rounds);
    expect(after?.findings).toEqual(before?.findings);
    expect(after?.lastLaunch).toMatchObject({ headSha: 'f'.repeat(40), inputSha256: 'e'.repeat(64) });
    const attempts = await loadConvergeAttemptState(f.common, f.target);
    expect(attempts?.attempts.slice(0, 1)).toEqual(claims?.attempts);
    expect(attempts?.attempts[1]?.retrySource).toMatchObject({
      headSha: 'a'.repeat(40), inputSha256: 'b'.repeat(64), attempt: 1, round: 2,
      reviewerHealth: { successfulSeats: 11, policy: { seatCount: 17, minimumSuccessful: 12 } },
    });
  });

  it.each([
    ['no reason', { retryReason: undefined }],
    ['start over', { startOver: true }],
    ['delivery intent', { intent: 'retry-delivery' as const }],
  ])('refuses %s before spending or dispatch', async (_label, override) => {
    const f = await fixture(); const before = await f.bytes();
    await expect(guardReviewLaunch({ ...f.retry, ...override })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled(); expect(await f.bytes()).toEqual(before);
  });

  it.each(['pending delivery', 'unknown dispatch', 'wrong attempt', 'missing report', 'stricter unbound config'])('refuses %s without changing state', async mode => {
    const f = await fixture();
    if (mode === 'missing report') f.retry.legacyRetry!.reportPath = join(f.common, 'absent');
    else if (mode === 'stricter unbound config') f.retry.legacyRetry!.config = { ...f.retry.legacyRetry!.config, quorumFraction: 1 };
    else await f.mutate((_r, n) => {
      if (mode === 'pending delivery') n.lastLaunch.deliveryPending = true;
      if (mode === 'unknown dispatch') n.lastLaunch.status = 'pending';
      if (mode === 'wrong attempt') n.lastLaunch.attempt++;
    });
    const before = await f.bytes();
    await expect(guardReviewLaunch(f.retry)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled(); expect(await f.bytes()).toEqual(before);
  });

  it('keeps the original cap exhausted without storing a source or refunding claims', async () => {
    const f = await fixture(1); const before = await f.bytes();
    await expect(guardReviewLaunch(f.retry)).rejects.toThrow(/budget exhausted/i);
    expect(f.run).not.toHaveBeenCalled(); expect(await f.bytes()).toEqual(before);
    await expect(readFile(join(f.common, 'rcl-converge-attempts', 'sources', 'x'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not infer an unhealthy blocking quorum from diluted legacy aggregate counts', async () => {
    const f = await fixture();
    await f.mutate((_r, n) => { n.lastLaunch.totalReviews = 50; });
    const before = await f.bytes();
    await expect(guardReviewLaunch({ ...f.retry, legacyRetry: undefined })).rejects.toThrow('legacy_health_unknown');
    expect(f.run).not.toHaveBeenCalled(); expect(await f.bytes()).toEqual(before);
  });

  it('refuses a legacy duplicate assignment instance even when the selected roster matches', async () => {
    const f = await fixture();
    await f.mutate(r => { r.run!.roster[1] = { ...r.run!.roster[0]! }; });
    f.retry.legacyRetry!.roster = f.report.run!.roster;
    const before = await f.bytes();
    await expect(guardReviewLaunch(f.retry)).rejects.toThrow('retry_report_invalid');
    expect(f.run).not.toHaveBeenCalled(); expect(await f.bytes()).toEqual(before);
  });

  it('does not infer a missing original quorum fraction from today’s defaults', async () => {
    const f = await fixture();
    f.retry.legacyRetry!.config = { models: ['openai/fixture'] };
    await f.mutate(r => { r.run!.config_sha256 = configDigest(f.retry.legacyRetry!.config); });
    const before = await f.bytes();
    await expect(guardReviewLaunch(f.retry)).rejects.toThrow('retry_report_invalid');
    expect(f.run).not.toHaveBeenCalled(); expect(await f.bytes()).toEqual(before);
  });

  it('serializes concurrent source replay into one charged claim', async () => {
    const f = await fixture();
    f.run.mockResolvedValue({ runId: '01a0e4ac-58d9-7cc5-a722-0b50ed087b7a', reportJsonSha256: 'f'.repeat(64),
      successfulReviews: 11, totalReviews: 17, deliveryPending: false,
      reviewerHealth: { version: 1, policy: { version: 1, fraction: 2 / 3, seatCount: 17, minimumSuccessful: 12 }, successfulSeats: 11 } });
    const outcomes = await Promise.allSettled([guardReviewLaunch(f.retry), guardReviewLaunch(f.retry)]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(f.run).toHaveBeenCalledOnce();
    expect((await loadConvergeAttemptState(f.common, f.target))?.attemptsUsed).toBe(2);
  });

  it('refuses an externally changed native snapshot after source validation', async () => {
    const f = await fixture();
    f.retry.validate = async () => { const state = JSON.parse(await readFile(f.nativePath, 'utf8'));
      state.updatedAt = new Date().toISOString(); await writeFile(f.nativePath, JSON.stringify(state)); };
    const attempts = await readFile(f.attemptsPath);
    await expect(guardReviewLaunch(f.retry)).rejects.toThrow('retry_report_state_changed');
    expect(f.run).not.toHaveBeenCalled(); expect(await readFile(f.attemptsPath)).toEqual(attempts);
  });
});
