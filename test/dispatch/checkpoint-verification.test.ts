import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { appendVerificationRecord, appendVerificationRecordToValidatedRecords, decodeVerificationProof,
  validateVerificationRecordsForAppend } from '../../src/dispatch/checkpoint-verification.js';
import { planGating } from '../../src/consensus/gating.js';
import type { ConsensusFinding } from '../../src/consensus/types.js';
import { stableStringify } from '../../src/report/run-header.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';

const durability = vi.hoisted(() => ({ failPath: '', synced: [] as string[] }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), sync = handle.sync.bind(handle), path = String(args[0]);
    handle.sync = async () => { durability.synced.push(path); if (durability.failPath === path) {
      durability.failPath = ''; throw Object.assign(new Error('synthetic verification fsync failure'), { code: 'EIO' });
    } return sync(); }; return handle;
  } };
});
const roots: string[] = [];
afterEach(async () => { durability.failPath = ''; durability.synced = []; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = 'allocator-one/rcl#105', namespace = 'verification';
const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function planInput() {
  const findings: ConsensusFinding[] = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, file: 'a.ts', startLine: 1, endLine: 1, severity: 'important', category: 'correctness', title: `claim ${i}`, description: 'guard missing',
    consensus: { score: 1, total: 3, models: ['m1'], roles: ['general'], crossRole: false, crossModel: false, elevated: false, elevation: 'none', confidence: 0.5, confidenceLabel: 'Medium', tier: 'single' } }));
  const plan = planGating(findings, { minModels: 2, verificationModel: 'openai/verifier', verificationTimeoutMs: 100, verificationPassTimeoutMs: 600,
    diffFiles: [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+guard();', language: 'ts' }] });
  return { runId, gatingPlanBytes: stableStringify(plan), model: plan.model, provider: 'openai', batches: plan.batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })),
    startedAtMs: 200, expiresAtMs: 800, verificationTimeoutMs: plan.verificationTimeoutMs, verificationPassTimeoutMs: plan.verificationPassTimeoutMs, maxPhysicalCalls: 2 };
}

const intent = (batchIndex = 0) => ({ batchIndex, attemptId: `verifier-${batchIndex}`, startedAtMs: 210 + batchIndex });
const answer = (extra = {}) => JSON.stringify({ model: 'openai/verifier', provider: 'openai', status: 'success', text: '[{"id":"F1","refuted":false}]', durationMs: 10, ...extra }, null, 2) + '\n';
const outcome = (batchIndex = 0) => ({ batchIndex, attemptId: `verifier-${batchIndex}`, finishedAtMs: 300, answerBytes: answer() });
async function fixture(sealed = true) {
  const commonDir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-verification-'))); roots.push(commonDir);
  const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: 'c'.repeat(64), configSha256: 'd'.repeat(64), specSha256: 'e'.repeat(64), contextSha256: '3'.repeat(64), toolsSha256: '4'.repeat(64), parser: { name: 'findings-json', version: 1 },
    roster: [{ seat: 'general', model: 'openai/reviewer', role: 'general', route: 'openai' }], chunks: [{ index: 0, total: 1, digest: hash('chunk') }], prompts: [{ seat: 'general', chunk: 0, systemSha256: hash('system'), userSha256: hash('user') }] });
  const launch = createOriginalLaunch({ runId, target, planDigest: plan.digest, capturedInputsSha256: hash('opaque capture'), originalNativeClaim: { round: 1, attempt: 1 }, startedAtMs: 100, expiresAtMs: 1000, maxPhysicalCalls: 1, maxAttemptsPerCell: 1 });
  let journal!: CheckpointJournal, expired!: NativeTargetOwnership;
  await withNativeTarget(commonDir, target, async owner => {
    expired = owner; journal = await CheckpointJournal.create({ commonDir, namespace, plan, ownership: owner });
    await journal.bind('captured-inputs', 'opaque capture', owner); await journal.bind('launch', encodeOriginalLaunch(launch), owner);
    await journal.recordIntent('general:0', { id: 'reviewer-0', kind: 'unknown' }, owner);
    if (sealed) await journal.finalize(owner);
  });
  return { commonDir, journal, plan, expired, path: checkpointPath(commonDir, target, namespace) };
}
const runOwned = <T>(f: Awaited<ReturnType<typeof fixture>>, action: (owner: NativeTargetOwnership) => Promise<T>) => withNativeTarget(f.commonDir, target, action);

describe('durable verifier phase in the existing checkpoint', () => {
  it('retains exact request and result bytes, reopens without paid callbacks and leaves the reviewer proof unchanged', async () => {
    const f = await fixture(), original = await f.journal.exportProof();
    expect(await f.journal.readVerification()).toBeUndefined();
    await runOwned(f, async owner => {
      await f.journal.beginVerification(planInput(), owner);
      for (const i of [0, 1]) { expect(await f.journal.recordVerificationIntent(intent(i), owner)).toBe(true); await f.journal.recordVerificationResult(outcome(i), owner); }
      await f.journal.finalizeVerification({ status: 'complete', finishedAtMs: 310 }, owner);
    });
    const reader = await CheckpointJournal.openRead(f.path, f.plan), phase = (await reader.readVerification())!;
    expect(phase.plan.gatingPlanBytes).toBe(planInput().gatingPlanBytes); expect(phase.outcomes.map(x => x.answerBytes)).toEqual([answer(), answer()]);
    expect(phase.uncertain).toEqual([]); expect(phase.terminal?.status).toBe('complete');
    expect(Object.isFrozen(phase.plan.batches)).toBe(true); expect(await reader.exportProof()).toEqual(original);
    const proof = await reader.exportVerificationProof(); expect(proof.digest).toBe(hash(proof.bytes));
    expect(JSON.parse(proof.bytes).records).toHaveLength(6);
  });

  it.each(['published', 'orphan'])('refuses a new verifier phase after %s terminal report bytes exist', async mode => {
    const f = await fixture(), report = { reportBytes: 'original report', reviewerArtifactBytes: 'original private artifact' };
    if (mode === 'published') await runOwned(f, owner => f.journal.retainTerminalReport(report, owner));
    else {
      durability.failPath = join(f.path, 'terminal-report', 'report.json');
      await expect(runOwned(f, owner => f.journal.retainTerminalReport(report, owner))).rejects.toMatchObject({ code: 'EIO' });
    }
    await expect(runOwned(f, owner => f.journal.beginVerification(planInput(), owner))).rejects.toThrow('checkpoint_verification_report_finalized');
    expect(await f.journal.readVerification()).toBeUndefined();
    expect(await readFile(join(f.path, 'terminal-report', 'report.json'), 'utf8')).toBe(report.reportBytes);
  });

  it('seals failed uncertain accounting before publishing a report and permits only exact phase replay afterward', async () => {
    const f = await fixture(), report = { reportBytes: 'failed verifier report', reviewerArtifactBytes: 'retained uncertain attempt' };
    await runOwned(f, async owner => { await f.journal.beginVerification(planInput(), owner); await f.journal.recordVerificationIntent(intent(), owner); });
    await expect(runOwned(f, owner => f.journal.retainTerminalReport(report, owner))).rejects.toThrow('checkpoint_terminal_report_verification_pending');
    expect(await readdir(f.path)).not.toContain('terminal-report');
    await runOwned(f, async owner => {
      await f.journal.finalizeVerification({ status: 'failed', finishedAtMs: 800, reason: 'unknown provider outcome' }, owner);
      await f.journal.retainTerminalReport(report, owner);
    });
    const before = await f.journal.exportVerificationProof();
    await runOwned(f, async owner => {
      await f.journal.retainTerminalReport(report, owner); await f.journal.beginVerification(planInput(), owner);
      expect(await f.journal.recordVerificationIntent(intent(), owner)).toBe(false);
    });
    await expect(runOwned(f, owner => f.journal.recordVerificationIntent(intent(1), owner))).rejects.toThrow();
    expect(await f.journal.exportVerificationProof()).toEqual(before); expect((await f.journal.readTerminalReport())!.reportBytes).toBe(report.reportBytes);
  });

  it('decodes a sealed proof only against matching operation context and rejects rehashed invalid history', async () => {
    const f = await fixture();
    await runOwned(f, async owner => {
      await f.journal.beginVerification(planInput(), owner); await f.journal.recordVerificationIntent(intent(), owner);
      await f.journal.finalizeVerification({ status: 'failed', finishedAtMs: 800, reason: 'interrupted request' }, owner);
    });
    const main = await f.journal.exportProof(), proof = await f.journal.exportVerificationProof();
    const context = { planDigest: main.plan.digest, finalizationDigest: main.state.records.at(-1)!.digest,
      capturedInputsSha256: hash(main.bindings['captured-inputs']!), operationSha256: hash(main.bindings.launch!),
      runId, startedAtMs: 100, expiresAtMs: 1000, reviewerAttemptIds: ['reviewer-0'] };
    expect(decodeVerificationProof(proof.bytes, context).uncertain).toHaveLength(1);
    for (const field of ['planDigest', 'finalizationDigest', 'capturedInputsSha256', 'operationSha256'] as const) {
      expect(() => decodeVerificationProof(proof.bytes, { ...context, [field]: '9'.repeat(64) })).toThrow();
    }
    function rechain(wire: { records: Array<Record<string, any>> }): string {
      let previous = context.finalizationDigest;
      for (const [i, record] of wire.records.entries()) {
        record.sequence = i + 1; record.previousDigest = previous; delete record.digest;
        record.digest = hash(stableStringify(record)); previous = record.digest;
      }
      return stableStringify(wire);
    }
    const unchanged = rechain(JSON.parse(proof.bytes));
    expect(unchanged).toBe(proof.bytes);
    expect(decodeVerificationProof(unchanged, context)).toEqual(decodeVerificationProof(proof.bytes, context));
    for (const [mutation, error] of [
      ['complete', 'checkpoint_verification_incomplete'],
      ['duplicate batch', 'checkpoint_verification_duplicate_or_unknown_intent'],
      ['out of bounds', 'checkpoint_verification_duplicate_or_unknown_intent'],
      ['extra key', 'checkpoint_verification_invalid_record'],
    ]) {
      const wire = JSON.parse(proof.bytes);
      if (mutation === 'complete') wire.records[2].event.terminal = { status: 'complete', finishedAtMs: 300 };
      else if (mutation === 'duplicate batch') wire.records.splice(2, 0, structuredClone(wire.records[1]));
      else if (mutation === 'out of bounds') wire.records[1].event.intent.batchIndex = 2;
      else wire.records[1].authority = true;
      expect(() => decodeVerificationProof(rechain(wire), context)).toThrow(error);
    }
  });

  it('never returns launch permission twice, including a new writer after an interrupted intent', async () => {
    const f = await fixture();
    await runOwned(f, async owner => { await f.journal.beginVerification(planInput(), owner); expect(await f.journal.recordVerificationIntent(intent(), owner)).toBe(true); });
    await runOwned(f, async owner => {
      const writer = await CheckpointJournal.openWrite({ commonDir: f.commonDir, namespace, plan: f.plan, ownership: owner });
      await writer.beginVerification(planInput(), owner);
      expect(await writer.recordVerificationIntent(intent(), owner)).toBe(false);
    });
    await expect(runOwned(f, owner => f.journal.recordVerificationIntent({ ...intent(), attemptId: 'resample' }, owner))).rejects.toThrow();
    const phase = (await f.journal.readVerification())!; expect(phase.intents).toHaveLength(1); expect(phase.uncertain).toHaveLength(1);
    await expect(f.journal.exportVerificationProof()).rejects.toThrow('checkpoint_verification_unsealed');
  });

  it('snapshots arguments before waiting for ownership and serializes simultaneous launch claims', async () => {
    const f = await fixture();
    await runOwned(f, async owner => {
      const input = planInput(), pending = f.journal.beginVerification(input, owner); input.batches[0]!.userPrompt = 'changed'; await pending;
      const a = intent(), first = f.journal.recordVerificationIntent(a, owner); a.attemptId = 'changed';
      expect(await Promise.all([first, f.journal.recordVerificationIntent(intent(), owner)])).toEqual([true, false]);
      const result = outcome(), pendingResult = f.journal.recordVerificationResult(result, owner); result.answerBytes = 'changed'; await pendingResult;
    });
    const phase = (await f.journal.readVerification())!; expect(phase.plan.batches[0]!.userPrompt).toBe(planInput().batches[0]!.userPrompt); expect(phase.outcomes[0]!.answerBytes).toBe(answer());
  });

  it('reuses the same-operation validated prefix when appending a verifier event', async () => {
    const f = await fixture(), saved = planInput();
    await runOwned(f, owner => f.journal.beginVerification(saved, owner));
    const parse = JSON.parse; let planParses = 0;
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((...args: Parameters<typeof JSON.parse>) => {
      if (args[0] === saved.gatingPlanBytes) planParses += 1;
      return parse(...args);
    });
    try {
      await runOwned(f, owner => f.journal.recordVerificationIntent(intent(), owner));
    } finally {
      spy.mockRestore();
    }
    expect(planParses).toBe(1);
    expect((await f.journal.readVerification())!.intents).toEqual([intent()]);
  });

  it('brands one verifier append snapshot, rejects forgery or stale reuse and preserves exact record bytes', async () => {
    const f = await fixture(); await runOwned(f, owner => f.journal.beginVerification(planInput(), owner));
    const main = await f.journal.exportProof(), phase = (await f.journal.readVerification())!;
    const context = { planDigest: main.plan.digest, finalizationDigest: main.state.records.at(-1)!.digest,
      capturedInputsSha256: hash(main.bindings['captured-inputs']!), operationSha256: hash(main.bindings.launch!),
      runId, startedAtMs: 100, expiresAtMs: 1000, reviewerAttemptIds: ['reviewer-0'] };
    const event = { type: 'intent' as const, intent: intent() };
    const expected = appendVerificationRecord(phase.records, event, context);
    const rawRecords = structuredClone(phase.records), mutableContext = structuredClone(context);
    const snapshot = validateVerificationRecordsForAppend(rawRecords, mutableContext);
    rawRecords[0]!.digest = '0'.repeat(64); mutableContext.operationSha256 = '9'.repeat(64);
    expect(appendVerificationRecordToValidatedRecords(snapshot, event, context)).toEqual(expected);
    expect(() => appendVerificationRecordToValidatedRecords(snapshot, event, context)).toThrow('unvalidated_state');
    expect(() => appendVerificationRecordToValidatedRecords(structuredClone(snapshot), event, context)).toThrow('unvalidated_state');
    const wrongContext = validateVerificationRecordsForAppend(phase.records, context);
    expect(() => appendVerificationRecordToValidatedRecords(wrongContext, event, { ...context, operationSha256: '9'.repeat(64) })).toThrow('unvalidated_state');
  });

  it('requires sealed bound reviewer evidence and live same-target writable ownership', async () => {
    const f = await fixture(false);
    await expect(runOwned(f, owner => f.journal.beginVerification(planInput(), owner))).rejects.toThrow('checkpoint_verification_requires_finalization');
    await expect(f.journal.beginVerification(planInput(), f.expired)).rejects.toThrow('native_target_not_owned');
    await expect(withNativeTarget(f.commonDir, 'foreign', owner => f.journal.beginVerification(planInput(), owner))).rejects.toThrow('native_target_not_owned');
    const reader = await CheckpointJournal.openRead(f.path, f.plan);
    await expect(runOwned(f, owner => reader.beginVerification(planInput(), owner))).rejects.toThrow('checkpoint_read_only');
    expect(await readdir(f.path)).not.toContain('verification');
  });

  it('refuses requests or configuration that differ from the retained deterministic gating plan', async () => {
    const f = await fixture();
    const saved = planInput();
    for (const changed of [
      { batches: [{ ...saved.batches[0]!, userPrompt: 'unrelated prompt' }, saved.batches[1]!] },
      { model: 'other' }, { verificationTimeoutMs: 99 }, { verificationPassTimeoutMs: 601 },
      { gatingPlanBytes: saved.gatingPlanBytes + ' ' }, { gatingPlanBytes: '{"version":2}' },
    ]) {
      await expect(runOwned(f, owner => f.journal.beginVerification({ ...saved, ...changed }, owner))).rejects.toThrow();
    }
    expect(await f.journal.readVerification()).toBeUndefined();
  });

  it('freezes the operation and phase deadline and refuses higher caps or changed prompts on resume', async () => {
    const f = await fixture();
    for (const changed of [{ expiresAtMs: 1001 }, { startedAtMs: 99 }, { runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { maxPhysicalCalls: 501 }]) {
      await expect(runOwned(f, owner => f.journal.beginVerification({ ...planInput(), ...changed }, owner))).rejects.toThrow();
    }
    await runOwned(f, owner => f.journal.beginVerification(planInput(), owner));
    for (const changed of [{ expiresAtMs: 801 }, { maxPhysicalCalls: 1 }, { gatingPlanBytes: 'changed' }]) {
      await expect(runOwned(f, owner => f.journal.beginVerification({ ...planInput(), ...changed }, owner))).rejects.toThrow();
    }
  });

  it('enforces a separate explicit verifier cap without reusing reviewer identities or renewing time', async () => {
    const f = await fixture();
    await runOwned(f, owner => f.journal.beginVerification({ ...planInput(), maxPhysicalCalls: 1 }, owner));
    for (const changed of [{ attemptId: 'reviewer-0' }, { startedAtMs: 199 }, { startedAtMs: 800 }]) {
      await expect(runOwned(f, owner => f.journal.recordVerificationIntent({ ...intent(), ...changed }, owner))).rejects.toThrow();
    }
    await runOwned(f, async owner => { await f.journal.recordVerificationIntent(intent(), owner); await f.journal.recordVerificationResult(outcome(), owner); });
    await expect(runOwned(f, owner => f.journal.recordVerificationIntent(intent(1), owner))).rejects.toThrow();
    expect(await runOwned(f, owner => f.journal.recordVerificationIntent(intent(), owner))).toBe(false);
  });

  it('accepts results only for the exact launched batch, model, route and immutable bytes', async () => {
    const f = await fixture();
    await runOwned(f, owner => f.journal.beginVerification(planInput(), owner));
    await expect(runOwned(f, owner => f.journal.recordVerificationResult(outcome(), owner))).rejects.toThrow();
    await runOwned(f, owner => f.journal.recordVerificationIntent(intent(), owner));
    for (const changed of [{ model: 'wrong' }, { provider: 'wrong' }, { durationMs: -1 }, { status: 'canceled' }, { extra: true }]) {
      await expect(runOwned(f, owner => f.journal.recordVerificationResult({ ...outcome(), answerBytes: answer(changed) }, owner))).rejects.toThrow();
    }
    for (const changed of [{ batchIndex: 1 }, { finishedAtMs: 209 }]) {
      await expect(runOwned(f, owner => f.journal.recordVerificationResult({ ...outcome(), ...changed }, owner))).rejects.toThrow();
    }
    await runOwned(f, async owner => { await f.journal.recordVerificationResult(outcome(), owner); await f.journal.recordVerificationResult(outcome(), owner); });
    await expect(runOwned(f, owner => f.journal.recordVerificationResult({ ...outcome(), answerBytes: answer({ text: 'changed' }) }, owner))).rejects.toThrow();
    expect((await f.journal.readVerification())!.outcomes).toHaveLength(1);
  });

  it('requires every completed result before successful terminal publication and retains uncertain failure accounting', async () => {
    const f = await fixture();
    await runOwned(f, async owner => { await f.journal.beginVerification(planInput(), owner); await f.journal.recordVerificationIntent(intent(), owner); });
    await expect(runOwned(f, owner => f.journal.finalizeVerification({ status: 'complete', finishedAtMs: 300 }, owner))).rejects.toThrow();
    await runOwned(f, async owner => {
      await f.journal.finalizeVerification({ status: 'failed', finishedAtMs: 800, reason: 'whole pass deadline' }, owner);
      await f.journal.finalizeVerification({ status: 'failed', finishedAtMs: 800, reason: 'whole pass deadline' }, owner);
    });
    await expect(runOwned(f, owner => f.journal.recordVerificationResult(outcome(), owner))).rejects.toThrow();
    await expect(runOwned(f, owner => f.journal.recordVerificationIntent(intent(1), owner))).rejects.toThrow();
    const phase = (await f.journal.readVerification())!; expect(phase.uncertain).toHaveLength(1); expect(phase.terminal?.status).toBe('failed');
    expect((await f.journal.exportVerificationProof()).bytes).toContain('whole pass deadline');
  });

  it('counts interpretation in the frozen deadline and preserves an observed late answer without claiming completion', async () => {
    const f = await fixture();
    await runOwned(f, async owner => {
      await f.journal.beginVerification(planInput(), owner);
      for (const i of [0, 1]) { await f.journal.recordVerificationIntent(intent(i), owner); await f.journal.recordVerificationResult({ ...outcome(i), finishedAtMs: 800 }, owner); }
    });
    await expect(runOwned(f, owner => f.journal.finalizeVerification({ status: 'complete', finishedAtMs: 800 }, owner))).rejects.toThrow();
    await runOwned(f, owner => f.journal.finalizeVerification({ status: 'failed', finishedAtMs: 801, reason: 'deadline during interpretation' }, owner));
    expect((await f.journal.readVerification())!.outcomes).toHaveLength(2);
  });

  it('reestablishes durability after a visible intent fsync failure without authorizing a duplicate launch', async () => {
    const f = await fixture();
    await runOwned(f, async owner => {
      await f.journal.beginVerification(planInput(), owner);
      durability.failPath = join(f.path, 'verification', 'events', '00000002.json');
    });
    await expect(runOwned(f, owner => f.journal.recordVerificationIntent(intent(), owner))).rejects.toMatchObject({ code: 'EIO' });
    durability.synced = [];
    await runOwned(f, async owner => {
      const writer = await CheckpointJournal.openWrite({ commonDir: f.commonDir, namespace, plan: f.plan, ownership: owner });
      expect(await writer.recordVerificationIntent(intent(), owner)).toBe(false);
    });
    expect(durability.synced).toContain(join(f.path, 'verification', 'events', '00000002.json'));
    expect((await f.journal.readVerification())!.intents).toHaveLength(1);
  });

  it.each(['permissions', 'symlink', 'unknown', 'modified', 'gap'])('fails closed on %s in retained verification evidence', async mutation => {
    const f = await fixture(); await runOwned(f, owner => f.journal.beginVerification(planInput(), owner));
    const events = join(f.path, 'verification', 'events'), file = join(events, '00000001.json');
    if (mutation === 'permissions') await chmod(file, 0o644);
    else if (mutation === 'symlink') { const bytes = await readFile(file); await rm(file); const other = join(f.commonDir, 'other'); await writeFile(other, bytes, { mode: 0o600 }); await symlink(other, file); }
    else if (mutation === 'unknown') await writeFile(join(events, 'unexpected'), 'unknown', { mode: 0o600 });
    else if (mutation === 'gap') { await writeFile(join(events, '00000002.json'), await readFile(file), { mode: 0o600 }); await rm(file); }
    else await writeFile(file, (await readFile(file, 'utf8')).replace('claim 0', 'changed'));
    await expect(f.journal.readVerification()).rejects.toThrow();
  });
});
