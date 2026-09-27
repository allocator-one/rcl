import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withNativeTarget, type NativeTargetOwnership } from '../../src/converge/target-ownership.js';
import { CheckpointJournal, checkpointPath, freezeCheckpointPlan } from '../../src/dispatch/checkpoint.js';
import { stableStringify } from '../../src/report/run-header.js';
import { createOriginalLaunch, encodeOriginalLaunch } from '../../src/dispatch/original-launch.js';
import { createVerificationLateAudit, type VerificationLateAudit } from '../../src/dispatch/verification-late-audit.js';
const durability = vi.hoisted(() => ({ failPath: '', synced: [] as string[] }));
vi.mock('node:fs/promises', async (original) => {
    const fs = await original<typeof import('node:fs/promises')>();
    return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
            const handle = await fs.open(...args), sync = handle.sync.bind(handle), path = String(args[0]);
            handle.sync = async () => {
                durability.synced.push(path);
                if (durability.failPath === path) {
                    durability.failPath = '';
                    throw Object.assign(new Error('synthetic verifier fsync failure'), { code: 'EIO' });
                }
                return sync();
            };
            return handle;
        } };
});
const roots: string[] = [];
afterEach(async () => { durability.failPath = ''; durability.synced = []; await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const target = 'allocator-one/rcl#105', runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', hash = (v: string) => createHash('sha256').update(v).digest('hex');
async function fixture(terminal = true, intents = 1) { const dir = await realpath(await mkdtemp(join(tmpdir(), 'rcl-vlate-'))); roots.push(dir); const plan = freezeCheckpointPlan({ target, headSha: 'a'.repeat(40), mergeBaseSha: 'b'.repeat(40), patchSha256: 'c'.repeat(64), configSha256: 'd'.repeat(64), specSha256: 'e'.repeat(64), contextSha256: '3'.repeat(64), toolsSha256: '4'.repeat(64), parser: { name: 'p', version: 1 }, roster: [{ seat: 's', model: 'm', role: 'r', route: 'openai' }], chunks: [{ index: 0, total: 1, digest: hash('c') }], prompts: [{ seat: 's', chunk: 0, systemSha256: hash('s'), userSha256: hash('u') }] }); let journal!: CheckpointJournal; await withNativeTarget(dir, target, async (owner) => { journal = await CheckpointJournal.create({ commonDir: dir, namespace: 'vlate', plan, ownership: owner }); const launch = createOriginalLaunch({ runId, target, originalNativeClaim: { attempt: 1, round: 1 }, capturedInputsSha256: hash('capture'), planDigest: plan.digest, startedAtMs: 1, expiresAtMs: 1000, maxPhysicalCalls: 1, maxAttemptsPerCell: 1 }); await journal.bind('captured-inputs', 'capture', owner); await journal.bind('launch', encodeOriginalLaunch(launch), owner); await journal.recordIntent('s:0', { id: 'review', kind: 'unknown' }, owner); await journal.finalize(owner); const batches = Array.from({ length: intents }, (_, i) => ({ findingIndices: [i], systemPrompt: 'sys', userPrompt: `usr ${i}` })); const gating = { version: 1, findings: [], initialGating: [], candidateIndices: batches.map((_, i) => i), model: 'm', verificationTimeoutMs: 10, verificationPassTimeoutMs: 10, batches }; await journal.beginVerification({ runId, gatingPlanBytes: stableStringify(gating), model: 'm', provider: 'openai', batches: batches.map(({ systemPrompt, userPrompt }) => ({ systemPrompt, userPrompt })), startedAtMs: 2, expiresAtMs: 12, verificationTimeoutMs: 10, verificationPassTimeoutMs: 10, maxPhysicalCalls: intents }, owner); for (let i = 0; i < intents; i++)
    await journal.recordVerificationIntent({ batchIndex: i, attemptId: `verify-${i}`, startedAtMs: 3 }, owner); if (terminal)
    await journal.finalizeVerification({ status: 'failed', finishedAtMs: 12, reason: 'timeout' }, owner); }); return { dir, journal }; }
const result = (text = 'ok', batchIndex = 0) => ({ batchIndex, attemptId: `verify-${batchIndex}`, finishedAtMs: 13, answerBytes: JSON.stringify({ model: 'm', provider: 'openai', text, status: 'success', durationMs: 1 }) });
const owned = <T>(f: Awaited<ReturnType<typeof fixture>>, work: (owner: NativeTargetOwnership) => Promise<T>) => withNativeTarget(f.dir, target, work);
const events = (f: Awaited<ReturnType<typeof fixture>>) => join(checkpointPath(f.dir, target, 'vlate'), 'verification-late-audit', 'events');
describe('late verifier audit regressions', () => {
    it('refuses malformed, extra, nonfinite, fractional, unknown-intent and wrong-model inputs before writing', async () => {
        const f = await fixture();
        const bad = [{ ...result(), finishedAtMs: NaN }, { ...result(), finishedAtMs: 1.5 }, { ...result(), attemptId: 'unknown' },
            { ...result(), answerBytes: JSON.stringify({ model: 'wrong', provider: 'openai', text: 'x', status: 'success', durationMs: 1 }) }, { ...result(), extra: true }];
        for (const value of bad)
            await expect(owned(f, owner => f.journal.recordLateVerificationResult(value, owner))).rejects.toThrow();
        expect(await f.journal.readLateVerificationAudit()).toEqual([]);
    });
    it('refuses expired, foreign and read-only owners', async () => {
        const f = await fixture();
        let expired!: NativeTargetOwnership;
        await owned(f, async (owner) => { expired = owner; });
        await expect(f.journal.recordLateVerificationResult(result(), expired)).rejects.toThrow('native_target_not_owned');
        await expect(withNativeTarget(f.dir, 'foreign', owner => f.journal.recordLateVerificationResult(result(), owner))).rejects.toThrow('native_target_not_owned');
        const reader = await CheckpointJournal.openRead(checkpointPath(f.dir, target, 'vlate'), f.journal.getPlan());
        await expect(owned(f, owner => reader.recordLateVerificationResult(result(), owner))).rejects.toThrow('checkpoint_read_only');
    });
    it.each(['noncanonical', 'symlink', 'unknown root'])('rejects %s evidence', async (mode) => {
        const f = await fixture();
        await owned(f, owner => f.journal.recordLateVerificationResult(result(), owner));
        const file = join(events(f), '00000001.json');
        if (mode === 'noncanonical')
            await writeFile(file, (await readFile(file, 'utf8')) + ' ');
        else if (mode === 'unknown root')
            await writeFile(join(events(f), '..', 'unknown'), 'x', { mode: 0o600 });
        else {
            const other = join(f.dir, 'other');
            await writeFile(other, await readFile(file), { mode: 0o600 });
            await rm(file);
            await symlink(other, file);
        }
        await expect(f.journal.readLateVerificationAudit()).rejects.toThrow();
    });
    it('reflushes a surviving audit event after lost fsync acknowledgment', async () => {
        const f = await fixture(), file = join(events(f), '00000001.json');
        durability.failPath = file;
        await expect(owned(f, owner => f.journal.recordLateVerificationResult(result(), owner))).rejects.toMatchObject({ code: 'EIO' });
        const bytes = await readFile(file, 'utf8');
        durability.synced = [];
        await owned(f, owner => f.journal.recordLateVerificationResult(result(), owner));
        expect(durability.synced).toContain(file);
        expect(await readFile(file, 'utf8')).toBe(bytes);
        expect(await f.journal.readLateVerificationAudit()).toHaveLength(1);
    });
    it('enforces the aggregate byte cap before publishing an unreadable record', async () => {
        const f = await fixture(true, 4), text = 'x'.repeat(7 * 1024 * 1024);
        await owned(f, async (owner) => { for (let i = 0; i < 3; i++)
            await f.journal.recordLateVerificationResult(result(text, i), owner); });
        await expect(owned(f, owner => f.journal.recordLateVerificationResult(result(text, 3), owner))).rejects.toThrow('checkpoint_verification_late_too_large');
        expect(await readdir(events(f))).toHaveLength(3);
        expect(await f.journal.readLateVerificationAudit()).toHaveLength(3);
    }, 30000);
    it('buffers until sealing, persists active callbacks and reports callbacks after ownership closes', async () => {
        const f = await fixture(false, 2), errors: unknown[] = [];
        let audit!: VerificationLateAudit;
        await owned(f, async (owner) => {
            audit = createVerificationLateAudit({ commonDir: f.dir, journal: f.journal, ownership: owner, onError: error => errors.push(error) });
            await expect(audit.flushAfterFinalization()).rejects.toThrow('late_verification_audit_requires_terminal');
            const row = result();
            const accepted = audit.accept(row);
            row.answerBytes = 'mutated';
            await accepted;
            await expect(audit.drain()).rejects.toThrow('late_verification_audit_requires_terminal');
            await f.journal.finalizeVerification({ status: 'failed', finishedAtMs: 12, reason: 'timeout' }, owner);
            await audit.flushAfterFinalization();
            await audit.accept(result('second', 1));
            await audit.drain();
            const rows = await f.journal.readLateVerificationAudit();
            expect(rows.map(x => x.result.answerBytes)).toEqual([result().answerBytes, result('second', 1).answerBytes]);
            expect(Object.isFrozen(rows[0]!.result)).toBe(true);
        });
        await expect(audit.accept(result())).rejects.toThrow('native_target_not_owned');
        await expect(audit.drain()).rejects.toThrow('native_target_not_owned');
        expect(errors).toHaveLength(1);
    });
    it('rejects nonfinite results before buffering and surfaces persistence failure through drain', async () => {
        const f = await fixture(), errors: unknown[] = [];
        await owned(f, async (owner) => {
            const audit = createVerificationLateAudit({ commonDir: f.dir, journal: f.journal, ownership: owner, onError: error => errors.push(error) });
            await expect(audit.accept({ ...result(), finishedAtMs: NaN })).rejects.toThrow();
            await expect(audit.drain()).rejects.toThrow();
        });
        expect(errors).toHaveLength(1);
        expect(await f.journal.readLateVerificationAudit()).toEqual([]);
    });
});
