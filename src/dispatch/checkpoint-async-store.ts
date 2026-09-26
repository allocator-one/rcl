import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { CheckpointJournal, checkpointPath, freezeCheckpointPlan, type FrozenCheckpointPlan } from './checkpoint.js';
import { CAPTURED_INPUT_LIMITS, decodeCapturedInputs } from './captured-inputs.js';
import { decodeOriginalLaunch } from './original-launch.js';
import { withOwnedNativeOperation, type NativeTargetOwnership } from '../converge/target-ownership.js';
import { syncNativeDirectory, withNativeLock } from '../converge/native-lock.js';
import { readStable } from '../telemetry/recovery/files.js';
import { writeExclusiveBytes } from '../evidence/original-run/journal.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';
import { sha256Hex, stableStringify } from '../report/run-header.js';
import { appendAsyncRecord, asyncRefuse, decodeAsyncProof, encodeAsyncProof, freezeAsync, parseAsyncReview,
  validateAsyncPlan, validateAsyncRecords, validateAsyncResult, type AsyncCall, type AsyncContext, type AsyncIntent,
  type AsyncPlan, type AsyncProof, type AsyncRecord, type AsyncResult, type AsyncState } from './checkpoint-async.js';

interface LocationInput { commonDir: string; namespace: string; plan: FrozenCheckpointPlan }
interface Location { commonDir: string; namespace: string; checkpointPath: string; phasePath: string; plan: FrozenCheckpointPlan }
export interface InitializeAsyncInput extends LocationInput { ownership: NativeTargetOwnership; calls: readonly AsyncCall[]; maxPhysicalCalls: number; maxAttemptsPerCall: number; expiresAtMs: number }
export interface AsyncDelegate { version: 1; commonDir: string; namespace: string; target: string; checkpointPath: string; planDigest: string; callIndex: number; token: string }
export interface AsyncWriter { claim(prompts: { systemPrompt: string; userPrompt: string }): Promise<AsyncIntent | undefined>; recordResult(attemptId: string, reviewBytes: string, possiblyBilled: boolean): Promise<'observed' | 'late'> }
interface Metadata { version: 1; plan: AsyncPlan; grants: string[] }
interface Phase { plan: AsyncPlan; state: AsyncState }
export interface AsyncLateRecord { sequence: number; previousDigest: string; digest: string; sealedProofSha256: string; result: AsyncResult }
const delegateSchema = z.object({ version: z.literal(1), commonDir: z.string().min(1), namespace: z.string().min(1), target: z.string().min(1),
  checkpointPath: z.string().min(1), planDigest: z.string().regex(/^[a-f0-9]{64}$/), callIndex: z.number().int().nonnegative().safe(), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const metadataSchema = z.object({ version: z.literal(1), plan: z.unknown(), grants: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(8) }).strict();
const filename = (index: number) => `${String(index).padStart(8, '0')}.json`;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path); asyncRefuse(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(path) === path &&
    (stat.mode & 0o7777) === 0o700 && (!process.geteuid || stat.uid === process.geteuid()), 'unsafe_directory');
}
async function child(parent: string, name: string): Promise<string> {
  await privateDirectory(parent); const path = join(parent, name);
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privateDirectory(path); await syncNativeDirectory(parent); return path;
}
async function safeRead(path: string): Promise<string> {
  await privateDirectory(dirname(path)); const before = await lstat(path);
  asyncRefuse(before.isFile() && !before.isSymbolicLink() && (before.mode & 0o7777) === 0o600 && (!process.geteuid || before.uid === process.geteuid()), 'unsafe_file');
  const { raw } = await readStable(path, MAX_ARTIFACT_BYTES), after = await lstat(path);
  asyncRefuse(before.ino === after.ino && before.dev === after.dev && before.ctimeMs === after.ctimeMs && before.mtimeMs === after.mtimeMs && before.size === after.size, 'changing_file');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
}
async function resync(path: string, bytes: string): Promise<void> {
  asyncRefuse(await safeRead(path) === bytes, 'conflict'); const before = await lstat(path), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); asyncRefuse(stat.ino === before.ino && stat.dev === before.dev && stat.size === before.size && stat.ctimeMs === before.ctimeMs, 'changing_file'); await handle.sync(); }
  finally { await handle.close(); }
  asyncRefuse(await safeRead(path) === bytes, 'changing_file'); await syncNativeDirectory(dirname(path));
}
/** Stage, fsync, then link exclusively; readers never observe a partially written event. */
async function publish(phase: string, destination: string, bytes: string): Promise<void> {
  asyncRefuse(Buffer.byteLength(bytes, 'utf8') <= MAX_ARTIFACT_BYTES, 'too_large');
  try { await lstat(destination); await resync(destination, bytes); return; } catch (error) { if (!isMissing(error)) throw error; }
  const staging = await child(phase, '.staging'), temporary = join(staging, `${randomUUID()}.pending`);
  await writeExclusiveBytes(temporary, Buffer.from(bytes));
  try { await link(temporary, destination); await syncNativeDirectory(dirname(destination)); }
  finally { await unlink(temporary); await syncNativeDirectory(staging); }
  await resync(destination, bytes);
}
function snapshotLocation(input: LocationInput): Location {
  const plan = freezeCheckpointPlan(input.plan); asyncRefuse(stableStringify(plan) === stableStringify(input.plan), 'plan');
  const commonDir = resolve(input.commonDir), path = checkpointPath(commonDir, plan.target, input.namespace);
  return { commonDir, namespace: input.namespace, checkpointPath: path, phasePath: join(path, 'async'), plan };
}
async function contextAt(location: Location): Promise<{ context: AsyncContext; journal: CheckpointJournal }> {
  asyncRefuse(await realpath(location.commonDir) === location.commonDir, 'alias');
  const journal = await CheckpointJournal.openRead(location.checkpointPath, location.plan), bindings = await journal.readBindings();
  asyncRefuse(bindings.launch && bindings['captured-inputs'] && !bindings.source && !bindings.operation, 'original_required');
  const captured = decodeCapturedInputs(bindings['captured-inputs'], location.plan), launch = decodeOriginalLaunch(bindings.launch);
  asyncRefuse(launch.runId === location.namespace && launch.target === location.plan.target && launch.planDigest === location.plan.digest && launch.capturedInputsSha256 === captured.digest, 'parent_binding');
  return { journal, context: { runId: launch.runId, target: launch.target, planDigest: launch.planDigest,
    capturedInputsSha256: captured.digest, launchSha256: sha256Hex(bindings.launch), startedAtMs: launch.startedAtMs,
    expiresAtMs: launch.expiresAtMs, reviewerReservedCalls: launch.maxPhysicalCalls } };
}
async function metadataAt(location: Location): Promise<Metadata> {
  const bytes = await safeRead(join(location.phasePath, 'phase.json')); let raw: unknown;
  try { raw = JSON.parse(bytes); } catch { throw new Error('checkpoint_async_invalid_metadata'); }
  const parsed = metadataSchema.safeParse(raw); asyncRefuse(parsed.success && stableStringify(parsed.data) + '\n' === bytes, 'invalid_metadata');
  const plan = validateAsyncPlan(parsed.data.plan), { context } = await contextAt(location);
  asyncRefuse(stableStringify(plan.context) === stableStringify(context) && parsed.data.grants.length === plan.calls.length && new Set(parsed.data.grants).size === plan.calls.length, 'parent_binding');
  for (const call of plan.calls) asyncRefuse(location.plan.chunks[call.chunk]?.digest === call.chunkSha256, 'call');
  return { version: 1, plan, grants: parsed.data.grants };
}
async function recordsAt(location: Location, plan: AsyncPlan): Promise<AsyncState> {
  const directory = join(location.phasePath, 'events'); await privateDirectory(directory); const names = (await readdir(directory)).sort(); asyncRefuse(names.length <= 1001, 'too_many_records');
  let total = 0; const records: unknown[] = [];
  for (const [index, name] of names.entries()) {
    asyncRefuse(name === filename(index + 1), 'sequence'); const bytes = await safeRead(join(directory, name)); total += Buffer.byteLength(bytes); asyncRefuse(total <= MAX_ARTIFACT_BYTES, 'too_large');
    let record: unknown; try { record = JSON.parse(bytes); } catch { throw new Error('checkpoint_async_invalid_record'); }
    asyncRefuse(stableStringify(record) + '\n' === bytes, 'noncanonical_record'); records.push(record);
  }
  return validateAsyncRecords(records, plan);
}
async function locked<T>(location: Location, work: (metadata: Metadata, state: AsyncState) => Promise<T>): Promise<T> {
  await privateDirectory(location.phasePath);
  return withNativeLock(join(location.phasePath, 'locks'), 'phase', async () => {
    const metadata = await metadataAt(location), state = await recordsAt(location, metadata.plan);
    return work(metadata, state);
  });
}
async function append(location: Location, state: AsyncState, plan: AsyncPlan, event: Parameters<typeof appendAsyncRecord>[1]): Promise<AsyncRecord> {
  const record = appendAsyncRecord(state.records, event, plan); await publish(location.phasePath, join(location.phasePath, 'events', filename(record.sequence)), stableStringify(record) + '\n'); return record;
}
/** Only initialization under live native ownership may create restricted per-call delegations. */
export function initializeAsyncPhase(input: InitializeAsyncInput): Promise<{ delegates: readonly AsyncDelegate[]; plan: AsyncPlan }> {
  const location = snapshotLocation(input), calls = structuredClone(input.calls), { ownership, maxPhysicalCalls, maxAttemptsPerCall, expiresAtMs } = input;
  return withOwnedNativeOperation(ownership, location.commonDir, location.plan.target, async () => {
    const { journal, context } = await contextAt(location), state = await journal.read();
    asyncRefuse(!state.finalized && !state.records.some(row => row.type === 'intent'), 'initialization_closed');
    try { await lstat(join(location.checkpointPath, 'terminal-report')); throw new Error('checkpoint_async_initialization_closed'); } catch (error) { if (!isMissing(error)) throw error; }
    const plan = validateAsyncPlan({ version: 1, context, calls, maxPhysicalCalls, maxAttemptsPerCall, expiresAtMs });
    asyncRefuse(Date.now() >= context.startedAtMs && Date.now() < plan.expiresAtMs, 'deadline');
    for (const call of plan.calls) asyncRefuse(location.plan.chunks[call.chunk]?.digest === call.chunkSha256, 'call');
    try { await lstat(location.phasePath); throw new Error('checkpoint_async_already_initialized'); } catch (error) { if (!isMissing(error)) throw error; }
    await child(location.checkpointPath, 'async'); await child(location.phasePath, 'events'); await child(location.phasePath, 'late');
    const tokens = calls.map(() => randomBytes(32).toString('hex')); const metadata: Metadata = { version: 1, plan, grants: tokens.map(sha256Hex) };
    await publish(location.phasePath, join(location.phasePath, 'phase.json'), stableStringify(metadata) + '\n');
    const delegates = tokens.map((token, callIndex): AsyncDelegate => ({ version: 1, commonDir: location.commonDir, namespace: location.namespace,
      target: location.plan.target, checkpointPath: location.checkpointPath, planDigest: sha256Hex(stableStringify(plan)), callIndex, token }));
    return freezeAsync({ delegates, plan });
  });
}
async function delegatedLocation(input: AsyncDelegate): Promise<{ location: Location; delegate: AsyncDelegate }> {
  const parsed = delegateSchema.safeParse(input); asyncRefuse(parsed.success, 'invalid_delegate'); const delegate = freezeAsync(parsed.data);
  asyncRefuse(resolve(delegate.commonDir) === delegate.commonDir && checkpointPath(delegate.commonDir, delegate.target, delegate.namespace) === delegate.checkpointPath, 'delegate_path');
  const journal = await CheckpointJournal.inspectRead(delegate.checkpointPath);
  asyncRefuse(journal.getPlan().target === delegate.target, 'delegate_target');
  return { location: snapshotLocation({ commonDir: delegate.commonDir, namespace: delegate.namespace, plan: journal.getPlan() }), delegate };
}
function authorize(metadata: Metadata, delegate: AsyncDelegate): void {
  const expected = metadata.grants[delegate.callIndex];
  asyncRefuse(expected && sha256Hex(stableStringify(metadata.plan)) === delegate.planDigest &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sha256Hex(delegate.token), 'hex')), 'invalid_delegate');
}
/** Delegates cannot mutate native state, reviewer history, phase plan, cutoff or another call. */
export async function openAsyncDelegate(input: AsyncDelegate): Promise<AsyncWriter> {
  const snapshot = structuredClone(input), { location, delegate } = await delegatedLocation(snapshot);
  await locked(location, async metadata => authorize(metadata, delegate));
  return Object.freeze({
    claim: async (prompts: { systemPrompt: string; userPrompt: string }): Promise<AsyncIntent | undefined> => {
      const system = prompts.systemPrompt, user = prompts.userPrompt;
      return locked(location, async (metadata, state) => {
        authorize(metadata, delegate); const call = metadata.plan.calls[delegate.callIndex]!;
        asyncRefuse([system, user].every(value => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= CAPTURED_INPUT_LIMITS.bytes &&
          Buffer.from(value, 'utf8').toString('utf8') === value) && sha256Hex(system) === call.systemPromptSha256 && sha256Hex(user) === call.userPromptSha256, 'prompt_mismatch');
        const now = Date.now(); asyncRefuse(Number.isSafeInteger(now) && now >= metadata.plan.context.startedAtMs, 'clock');
        const prior = state.intents.filter(row => row.callIndex === delegate.callIndex), last = prior.at(-1), outcome = last && state.outcomes.find(row => row.attemptId === last.attemptId);
        if (state.cutoffMs !== undefined || now >= metadata.plan.expiresAtMs || state.intents.length >= metadata.plan.maxPhysicalCalls || prior.length >= metadata.plan.maxAttemptsPerCall ||
          last && (!outcome || parseAsyncReview(outcome.reviewBytes, call).status === 'success')) return undefined;
        const intent = { callIndex: delegate.callIndex, attemptId: `async-${randomUUID()}`, startedAtMs: now };
        await append(location, state, metadata.plan, { type: 'intent', intent }); return freezeAsync(intent);
      });
    },
    recordResult: async (attemptId: string, reviewBytes: string, possiblyBilled: boolean): Promise<'observed' | 'late'> => {
      const finishedAtMs = Date.now();
      return locked(location, async (metadata, state) => {
        authorize(metadata, delegate); const existing = state.outcomes.find(row => row.attemptId === attemptId);
        const result = validateAsyncResult({ callIndex: delegate.callIndex, attemptId, reviewBytes, reviewSha256: sha256Hex(reviewBytes), possiblyBilled,
          finishedAtMs: existing?.finishedAtMs ?? finishedAtMs }, metadata.plan, state.intents);
        if (existing) {
          asyncRefuse(stableStringify(existing) === stableStringify(result), 'result_conflict');
          const record = state.records.find(row => row.event.type === 'result' && row.event.result.attemptId === attemptId)!;
          await resync(join(location.phasePath, 'events', filename(record.sequence)), stableStringify(record) + '\n'); return 'observed';
        }
        if (state.cutoffMs === undefined) { await append(location, state, metadata.plan, { type: 'result', result }); return 'observed'; }
        await appendLate(location, encodeAsyncProof(metadata.plan, state.records), result); return 'late';
      });
    },
  });
}
/** Parent-only cutoff is atomic with all delegated intent/retry admission. */
export function sealAsyncPhase(input: LocationInput & { ownership: NativeTargetOwnership }): Promise<AsyncProof> {
  const location = snapshotLocation(input);
  return withOwnedNativeOperation(input.ownership, location.commonDir, location.plan.target, () => locked(location, async (metadata, state) => {
    let records = state.records;
    if (state.cutoffMs === undefined) records = [...records, await append(location, state, metadata.plan, { type: 'seal', cutoffMs: Date.now() })];
    for (const record of records) await resync(join(location.phasePath, 'events', filename(record.sequence)), stableStringify(record) + '\n');
    return decodeAsyncProof(encodeAsyncProof(metadata.plan, records).bytes, metadata.plan.context);
  }));
}
/** Structural local read; this does not authenticate capture matrix, producer or server authority. */
export function readAsyncPhase(input: LocationInput): Promise<Phase> {
  const location = snapshotLocation(input); return locked(location, async (metadata, state) => freezeAsync({ plan: metadata.plan, state }));
}
async function lateAt(location: Location, proof: AsyncProof): Promise<AsyncLateRecord[]> {
  const directory = join(location.phasePath, 'late'); await privateDirectory(directory); const names = (await readdir(directory)).sort();
  asyncRefuse(names.length <= proof.state.uncertain.length, 'late_cap'); const rows: AsyncLateRecord[] = []; const seen = new Set<string>(); let previous = proof.digest, total = 0;
  for (const [index, name] of names.entries()) {
    asyncRefuse(name === filename(index + 1), 'late_sequence'); const bytes = await safeRead(join(directory, name)); total += Buffer.byteLength(bytes); asyncRefuse(total <= MAX_ARTIFACT_BYTES, 'late_too_large');
    let row: AsyncLateRecord; try { row = JSON.parse(bytes); } catch { throw new Error('checkpoint_async_invalid_late'); }
    asyncRefuse(row && typeof row === 'object' && Object.keys(row).sort().join(',') === 'digest,previousDigest,result,sealedProofSha256,sequence', 'invalid_late');
    const { digest, ...unsigned } = row;
    asyncRefuse(stableStringify(row) + '\n' === bytes && row.sequence === index + 1 && row.previousDigest === previous && row.sealedProofSha256 === proof.digest && sha256Hex(stableStringify(unsigned)) === digest, 'invalid_late');
    validateAsyncResult(row.result, proof.plan, proof.state.uncertain); asyncRefuse(!seen.has(row.result.attemptId), 'duplicate_late'); seen.add(row.result.attemptId); rows.push(row); previous = digest;
  }
  return freezeAsync(rows);
}
async function appendLate(location: Location, proof: AsyncProof, result: AsyncResult): Promise<void> {
  const rows = await lateAt(location, proof), existing = rows.find(row => row.result.attemptId === result.attemptId);
  if (existing) {
    asyncRefuse(stableStringify(existing.result) === stableStringify({ ...result, finishedAtMs: existing.result.finishedAtMs }), 'late_conflict');
    await resync(join(location.phasePath, 'late', filename(existing.sequence)), stableStringify(existing) + '\n'); return;
  }
  validateAsyncResult(result, proof.plan, proof.state.uncertain);
  const unsigned = { sequence: rows.length + 1, previousDigest: rows.at(-1)?.digest ?? proof.digest, sealedProofSha256: proof.digest, result };
  const record = { ...unsigned, digest: sha256Hex(stableStringify(unsigned)) };
  asyncRefuse(Buffer.byteLength(stableStringify([...rows, record])) <= MAX_ARTIFACT_BYTES, 'late_too_large');
  await publish(location.phasePath, join(location.phasePath, 'late', filename(record.sequence)), stableStringify(record) + '\n');
}
export function readAsyncLateAudit(input: LocationInput): Promise<readonly AsyncLateRecord[]> {
  const location = snapshotLocation(input); return locked(location, (metadata, state) => lateAt(location, encodeAsyncProof(metadata.plan, state.records)));
}
