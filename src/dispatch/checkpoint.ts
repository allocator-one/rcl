import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, basename } from 'node:path';
import { z } from 'zod';
import { originalRawFindingSchema } from '../telemetry/recovery/source.js';
import { syncNativeDirectory } from '../converge/native-lock.js';
import {
  assertNativeTargetOwnership,
  ownedNativeTargetCommonDir,
  withOwnedNativeOperation,
  type NativeTargetOwnership,
} from '../converge/target-ownership.js';

const VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const integer = z.number().int().nonnegative().safe();
const attemptSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/), kind: z.enum(['paid', 'unknown']) }).strict();
const rawFindingSchema = originalRawFindingSchema.extend({
  locationProvenance: z.object({
    version: z.literal(1), source: z.literal('parser'), reason: z.literal('reversed_range'),
    originalStartLine: integer, originalEndLine: integer,
  }).strict().optional(),
}).strict().refine(finding => finding.endLine >= finding.startLine && (!finding.locationProvenance ||
  finding.locationProvenance.originalStartLine > finding.locationProvenance.originalEndLine &&
  finding.startLine === finding.locationProvenance.originalEndLine && finding.endLine === finding.locationProvenance.originalStartLine));
const reviewSchema = z.object({
  model: z.string().min(1), role: z.string().min(1), provider: z.string().min(1),
  findings: z.array(rawFindingSchema), durationMs: z.number().finite().nonnegative(),
  status: z.enum(['success', 'timeout', 'error', 'parse_failed', 'canceled']),
  usage: z.object({ inputTokens: integer.optional(), outputTokens: integer.optional(), reasoningTokens: integer.optional() }).strict().optional(),
  error: z.string().optional(), droppedFindings: integer.optional(), warnings: z.array(z.string()).optional(),
  async: z.literal(false).optional(),
}).strict();
const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success'), chunk: integer, reviewBytes: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('failure'), chunk: integer, reviewBytes: z.string().min(1), possiblyBilled: z.boolean() }).strict(),
]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface CheckpointPlanInput {
  target: string; headSha: string; mergeBaseSha: string; patchSha256: string; configSha256: string; specSha256: string;
  contextSha256: string; toolsSha256: string; parser: { name: string; version: number };
  roster: Array<{ seat: string; model: string; role: string; route: string }>;
  chunks: Array<{ index: number; total: number; digest: string }>;
  prompts: Array<{ seat: string; chunk: number; systemSha256: string; userSha256: string }>;
}
export interface CheckpointCell {
  id: string; seat: string; chunk: number; route: string; model: string; role: string;
  chunkDigest: string; systemPromptSha256: string; userPromptSha256: string;
}
export interface FrozenCheckpointPlan extends CheckpointPlanInput { version: 1; cells: CheckpointCell[]; digest: string }
export interface PaidAttempt { id: string; kind: 'paid' | 'unknown' }
export type CheckpointResult = { kind: 'success'; chunk: number; reviewBytes: string } | { kind: 'failure'; chunk: number; reviewBytes: string; possiblyBilled: boolean };
export interface JournalRecord { sequence: number; previousDigest: string; digest: string; type: 'intent' | 'result' | 'uncertain' | 'finalization'; cell?: string; paidAttempt?: PaidAttempt; result?: { kind: 'success' | 'failure'; chunk: number; reviewSha256: string; resultFile: string; possiblyBilled?: boolean }; reason?: string; finalizedDigest?: string }
export interface CheckpointState { records: JournalRecord[]; outcomes: Array<{ cell: string; paidAttempt: PaidAttempt; result: CheckpointResult }>; successes: Array<{ cell: string; paidAttempt: PaidAttempt; reviewBytes: string }>; uncertain: Array<{ cell: string; paidAttempt: PaidAttempt }>; finalized: boolean }

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
function recordDigest(value: Omit<JournalRecord, 'digest'>): string { return sha256(canonical(value as unknown as Json)); }
function requireText(value: string, name: string): string { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(`checkpoint_invalid_${name}`); return value; }
function requireDigest(value: string, name: string): string { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`checkpoint_invalid_${name}`); return value; }
function directoryKey(target: string): string { return sha256(target).slice(0, 32); }
export function checkpointPath(commonDir: string, target: string, namespace: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(namespace)) throw new Error('checkpoint_invalid_namespace');
  return join(resolve(commonDir), 'rcl-checkpoints', directoryKey(target), namespace);
}
function planPayload(plan: CheckpointPlanInput, cells: CheckpointCell[]): Omit<FrozenCheckpointPlan, 'digest'> {
  return { version: VERSION, target: plan.target, headSha: plan.headSha, mergeBaseSha: plan.mergeBaseSha, patchSha256: plan.patchSha256, configSha256: plan.configSha256, specSha256: plan.specSha256, contextSha256: plan.contextSha256, toolsSha256: plan.toolsSha256, parser: { ...plan.parser }, roster: plan.roster.map(item => ({ ...item })), chunks: plan.chunks.map(item => ({ ...item })), prompts: plan.prompts.map(item => ({ ...item })), cells };
}
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as object)) deepFreeze(child); } return value; }

export function freezeCheckpointPlan(input: CheckpointPlanInput): FrozenCheckpointPlan {
  requireText(input.target, 'target');
  for (const [name, value] of Object.entries({ head: input.headSha, merge_base: input.mergeBaseSha })) if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`checkpoint_invalid_${name}`);
  for (const [name, value] of Object.entries({ patch: input.patchSha256, config: input.configSha256, spec: input.specSha256, context: input.contextSha256, tools: input.toolsSha256 })) requireDigest(value, name);
  if (!Number.isSafeInteger(input.parser.version) || input.parser.version < 1) throw new Error('checkpoint_invalid_parser');
  requireText(input.parser.name, 'parser');
  if (!input.roster.length) throw new Error('checkpoint_missing_roster');
  const seats = new Set<string>();
  for (const item of input.roster) { requireText(item.seat, 'seat'); requireText(item.model, 'model'); requireText(item.role, 'role'); requireText(item.route, 'route'); if (seats.has(item.seat)) throw new Error('checkpoint_duplicate_cell'); seats.add(item.seat); }
  const chunks = [...input.chunks].sort((a, b) => a.index - b.index); if (!chunks.length) throw new Error('checkpoint_missing_chunks');
  const total = chunks[0]!.total;
  if (!Number.isSafeInteger(total) || total < 1 || chunks.length !== total || chunks.some((chunk, index) => chunk.index !== index || chunk.total !== total)) throw new Error('checkpoint_incomplete_chunks');
  const prompts = new Map<string, { systemSha256: string; userSha256: string }>();
  for (const prompt of input.prompts) { if (!seats.has(prompt.seat) || !Number.isSafeInteger(prompt.chunk) || prompt.chunk < 0 || prompt.chunk >= total) throw new Error('checkpoint_invalid_prompt'); const key = `${prompt.seat}:${prompt.chunk}`; if (prompts.has(key)) throw new Error('checkpoint_duplicate_cell'); requireDigest(prompt.systemSha256, 'system_prompt'); requireDigest(prompt.userSha256, 'user_prompt'); prompts.set(key, { systemSha256: prompt.systemSha256, userSha256: prompt.userSha256 }); }
  const cells: CheckpointCell[] = [];
  for (const chunk of chunks) { requireDigest(chunk.digest, 'chunk_digest'); for (const seat of input.roster) { const id = `${seat.seat}:${chunk.index}`, prompt = prompts.get(id); if (!prompt) throw new Error('checkpoint_missing_prompt'); cells.push({ id, seat: seat.seat, chunk: chunk.index, route: seat.route, model: seat.model, role: seat.role, chunkDigest: chunk.digest, systemPromptSha256: prompt.systemSha256, userPromptSha256: prompt.userSha256 }); } }
  if (prompts.size !== cells.length) throw new Error('checkpoint_extra_prompt');
  const payload = planPayload(input, cells); return deepFreeze({ ...payload, digest: sha256(canonical(payload as unknown as Json)) });
}

async function inspectDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path || (stat.mode & 0o7777) !== 0o700 || (process.geteuid && stat.uid !== process.geteuid())) throw new Error('checkpoint_unsafe_directory');
}
async function ensurePrivateChild(parent: string, child: string): Promise<string> {
  if (await realpath(parent) !== parent) throw new Error('checkpoint_ancestor_alias');
  const path = join(parent, child);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await inspectDirectory(path); await syncNativeDirectory(parent); return path;
}
async function readSafe(path: string): Promise<string> {
  const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_FILE_BYTES || (entry.mode & 0o7777) !== 0o600 || (process.geteuid && entry.uid !== process.geteuid())) throw new Error('checkpoint_symlink');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const before = await handle.stat(); if (!before.isFile() || before.size !== entry.size || before.ino !== entry.ino || before.dev !== entry.dev || before.mtimeMs !== entry.mtimeMs || before.ctimeMs !== entry.ctimeMs) throw new Error('checkpoint_changing_source'); const bytes = Buffer.alloc(before.size); let offset = 0; while (offset < bytes.length) { const next = await handle.read(bytes, offset, bytes.length - offset, offset); if (!next.bytesRead) break; offset += next.bytesRead; } const after = await handle.stat(), current = await lstat(path); if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs || current.isSymbolicLink()) throw new Error('checkpoint_changing_source'); return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } finally { await handle.close(); }
}

async function writeExclusive(path: string, bytes: string): Promise<void> {
  boundedBytes(bytes);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncNativeDirectory(resolve(path, '..'));
}
function boundedBytes(bytes: string): void {
  if (Buffer.byteLength(bytes, 'utf8') > MAX_FILE_BYTES) throw new Error('checkpoint_file_too_large');
}

/** An identical visible file is not proof that a previous fsync succeeded. */
async function syncExisting(path: string, expected?: string): Promise<void> {
  await inspectDirectory(resolve(path, '..'));
  const entry = await lstat(path);
  const bytes = await readSafe(path);
  if (expected !== undefined && bytes !== expected) throw new Error('checkpoint_changing_source');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev || opened.size !== entry.size ||
      opened.mtimeMs !== entry.mtimeMs || opened.ctimeMs !== entry.ctimeMs) throw new Error('checkpoint_changing_source');
    await handle.sync();
    const current = await lstat(path);
    if (current.ino !== opened.ino || current.dev !== opened.dev || current.mtimeMs !== opened.mtimeMs ||
      current.ctimeMs !== opened.ctimeMs || current.isSymbolicLink()) throw new Error('checkpoint_changing_source');
  } finally { await handle.close(); }
  await syncNativeDirectory(resolve(path, '..'));
}
function decodePlan(text: string): FrozenCheckpointPlan {
  let plan: FrozenCheckpointPlan; try { plan = JSON.parse(text) as FrozenCheckpointPlan; } catch { throw new Error('checkpoint_invalid_plan'); }
  const recalculated = freezeCheckpointPlan(plan);
  if (plan.version !== VERSION || plan.digest !== recalculated.digest || canonical(plan as unknown as Json) !== canonical(recalculated as unknown as Json)) throw new Error('checkpoint_invalid_plan');
  return recalculated;
}
function matchingPlan(actual: FrozenCheckpointPlan, expected: FrozenCheckpointPlan): boolean { return actual.digest === expected.digest && canonical(actual as unknown as Json) === canonical(expected as unknown as Json); }
function eventFile(sequence: number): string { return `${String(sequence).padStart(8, '0')}.json`; }

function validAttempt(value: PaidAttempt): boolean { return attemptSchema.safeParse(value).success; }
function snapshotAttempt(value: PaidAttempt): PaidAttempt {
  const parsed = attemptSchema.safeParse(value);
  if (!parsed.success) throw new Error('checkpoint_invalid_attempt');
  return parsed.data;
}
function snapshotResult(value: CheckpointResult): CheckpointResult {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) throw new Error('checkpoint_invalid_result');
  boundedBytes(parsed.data.reviewBytes);
  return parsed.data;
}
function resultFileFor(cell: string, attempt: PaidAttempt): string { return `${sha256(cell).slice(0, 16)}-${sha256(attempt.id).slice(0, 16)}.json`; }
function validResultReference(value: NonNullable<JournalRecord['result']>, cell: string, attempt: PaidAttempt): boolean { return Number.isSafeInteger(value.chunk) && value.chunk >= 0 && (value.kind === 'success' || value.kind === 'failure') && /^[a-f0-9]{64}$/.test(value.reviewSha256) && value.resultFile === resultFileFor(cell, attempt) && basename(value.resultFile) === value.resultFile && (value.kind !== 'failure' || typeof value.possiblyBilled === 'boolean'); }
function validateResult(result: CheckpointResult, cell: CheckpointCell): void {
  if (!Number.isSafeInteger(result.chunk) || result.chunk !== cell.chunk || typeof result.reviewBytes !== 'string' || !result.reviewBytes) throw new Error('checkpoint_result_cell_mismatch');
  boundedBytes(result.reviewBytes);
  let review: unknown; try { review = JSON.parse(result.reviewBytes); } catch { throw new Error('checkpoint_invalid_result'); }
  const parsed = reviewSchema.safeParse(review);
  if (!parsed.success) throw new Error('checkpoint_invalid_result');
  const item = parsed.data;
  if (item.model !== cell.model || item.role !== cell.role || item.provider !== cell.route) throw new Error('checkpoint_result_cell_mismatch');
  if ((result.kind === 'success') !== (item.status === 'success')) throw new Error('checkpoint_result_cell_mismatch');
}


export class CheckpointJournal {
  private needsResync = false;
  private constructor(private readonly path: string, private readonly plan: FrozenCheckpointPlan, private readonly commonDir?: string) {}

  static async create(input: { commonDir: string; namespace: string; plan: FrozenCheckpointPlan; ownership: NativeTargetOwnership }): Promise<CheckpointJournal> {
    const { namespace, ownership, commonDir: requestedCommonDir } = input;
    const plan = freezeCheckpointPlan(input.plan);
    if (canonical(plan as unknown as Json) !== canonical(input.plan as unknown as Json)) throw new Error('checkpoint_invalid_plan');
    const planBytes = `${canonical(plan as unknown as Json)}\n`;
    boundedBytes(planBytes);
    checkpointPath(requestedCommonDir, plan.target, namespace);
    const commonDir = await ownedNativeTargetCommonDir(ownership, requestedCommonDir, plan.target);
    return withOwnedNativeOperation(ownership, commonDir, plan.target, async active => {
      await assertNativeTargetOwnership(active, commonDir, plan.target);
      const path = checkpointPath(commonDir, plan.target, namespace);
      if (relative(commonDir, path).startsWith('..')) throw new Error('checkpoint_root_outside_common_dir');
      const root = await ensurePrivateChild(commonDir, 'rcl-checkpoints'); const targetRoot = await ensurePrivateChild(root, directoryKey(plan.target));
      if (relative(targetRoot, path).startsWith('..')) throw new Error('checkpoint_root_outside_common_dir');
      await ensurePrivateChild(targetRoot, namespace);
      await ensurePrivateChild(path, 'events'); await ensurePrivateChild(path, 'results');
      await writeExclusive(join(path, 'plan.json'), planBytes);
      return new CheckpointJournal(path, plan, commonDir);
    });
  }

  static async openRead(path: string, expected: FrozenCheckpointPlan): Promise<CheckpointJournal> {
    const frozenExpected = freezeCheckpointPlan(expected);
    if (canonical(frozenExpected as unknown as Json) !== canonical(expected as unknown as Json)) throw new Error('checkpoint_invalid_plan');
    const canonicalPath = resolve(path);
    await inspectDirectory(canonicalPath); await inspectDirectory(join(canonicalPath, 'events')); await inspectDirectory(join(canonicalPath, 'results'));
    const actual = decodePlan((await readSafe(join(canonicalPath, 'plan.json'))).trim());
    if (!matchingPlan(actual, frozenExpected)) throw new Error('checkpoint_plan_mismatch');
    const journal = new CheckpointJournal(canonicalPath, actual);
    await journal.read();
    return journal;
  }
  static async openWrite(input: { commonDir: string; namespace: string; plan: FrozenCheckpointPlan; ownership: NativeTargetOwnership }): Promise<CheckpointJournal> {
    const { namespace, ownership, commonDir: requestedCommonDir } = input;
    const plan = freezeCheckpointPlan(input.plan);
    if (canonical(plan as unknown as Json) !== canonical(input.plan as unknown as Json)) throw new Error('checkpoint_invalid_plan');
    const commonDir = await ownedNativeTargetCommonDir(ownership, requestedCommonDir, plan.target);
    return withOwnedNativeOperation(ownership, commonDir, plan.target, async active => {
      await assertNativeTargetOwnership(active, commonDir, plan.target);
      const journal = await CheckpointJournal.openRead(checkpointPath(commonDir, plan.target, namespace), plan);
      const writable = new CheckpointJournal(journal.path, plan, commonDir);
      await writable.syncHistory(await writable.read());
      return writable;
    });
  }

  getPlan(): FrozenCheckpointPlan { return this.plan; }

  async read(): Promise<CheckpointState> {
    await inspectDirectory(this.path); await inspectDirectory(join(this.path, 'events')); await inspectDirectory(join(this.path, 'results'));
    const actual = decodePlan((await readSafe(join(this.path, 'plan.json'))).trim());
    if (!matchingPlan(actual, this.plan)) throw new Error('checkpoint_plan_mismatch');
    const names = (await readdir(join(this.path, 'events'))).sort();
    let previous = this.plan.digest; const records: JournalRecord[] = [];
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== eventFile(i + 1)) throw new Error('checkpoint_sequence_gap');
      let record: JournalRecord; try { record = JSON.parse(await readSafe(join(this.path, 'events', names[i]!))) as JournalRecord; } catch (error) { if (error instanceof Error && error.message === 'checkpoint_symlink') throw error; throw new Error('checkpoint_invalid_record'); }
      const { digest, ...unsigned } = record;
      if (record.sequence !== i + 1 || record.previousDigest !== previous || digest !== recordDigest(unsigned) || !['intent', 'result', 'uncertain', 'finalization'].includes(record.type)) throw new Error('checkpoint_invalid_record');
      previous = digest; records.push(record);
    }
    const cells = new Set(this.plan.cells.map(cell => cell.id));
    const intents = new Map<string, PaidAttempt>(), terminalAttempts = new Map<string, JournalRecord>(), outcomes: Array<{ cell: string; paidAttempt: PaidAttempt; result: CheckpointResult }> = [], successes: Array<{ cell: string; paidAttempt: PaidAttempt; reviewBytes: string }> = [];
    const successfulCells = new Set<string>(), attemptIds = new Set<string>(); let finalized = false;
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (record.type === 'finalization') { if (finalized || !record.finalizedDigest || index !== records.length - 1 || record.finalizedDigest !== sha256(canonical(records.slice(0, -1) as unknown as Json))) throw new Error('checkpoint_invalid_finalization'); finalized = true; continue; }
      if (finalized || !record.cell || !record.paidAttempt || !cells.has(record.cell) || !validAttempt(record.paidAttempt)) throw new Error('checkpoint_invalid_record');
      const key = `${record.cell}\0${record.paidAttempt.id}`;
      if (record.type === 'intent') { if (intents.has(key) || attemptIds.has(record.paidAttempt.id)) throw new Error('checkpoint_duplicate_attempt'); intents.set(key, record.paidAttempt); attemptIds.add(record.paidAttempt.id); continue; }
      if (!intents.has(key) || intents.get(key)!.kind !== record.paidAttempt.kind) throw new Error('checkpoint_missing_intent');
      if (record.type === 'uncertain') continue;
      if (record.type === 'result') {
        if (!record.result || terminalAttempts.has(key) || successfulCells.has(record.cell) || !validResultReference(record.result, record.cell, record.paidAttempt)) throw new Error('checkpoint_invalid_record');
        terminalAttempts.set(key, record);
        const bytes = await readSafe(join(this.path, 'results', record.result.resultFile));
        if (sha256(bytes) !== record.result.reviewSha256) throw new Error('checkpoint_result_tampered');
        const cell = this.plan.cells.find(candidate => candidate.id === record.cell)!; const result: CheckpointResult = record.result.kind === 'success' ? { kind: 'success', chunk: record.result.chunk, reviewBytes: bytes } : { kind: 'failure', chunk: record.result.chunk, reviewBytes: bytes, possiblyBilled: record.result.possiblyBilled === true }; validateResult(result, cell); outcomes.push({ cell: record.cell, paidAttempt: record.paidAttempt, result }); if (record.result.kind === 'success') { successfulCells.add(record.cell); successes.push({ cell: record.cell, paidAttempt: record.paidAttempt, reviewBytes: bytes }); }
      }
    }
    const uncertain = [...intents.entries()].filter(([key]) => !terminalAttempts.has(key)).map(([key, paidAttempt]) => ({ cell: key.split('\0')[0]!, paidAttempt }));
    return { records, outcomes, successes, uncertain, finalized };
  }

  private async write<T>(ownership: NativeTargetOwnership, operation: () => Promise<T>): Promise<T> {
    if (!this.commonDir) throw new Error('checkpoint_read_only');
    return withOwnedNativeOperation(ownership, this.commonDir, this.plan.target, async active => {
      await assertNativeTargetOwnership(active, this.commonDir!, this.plan.target);
      try {
        if (this.needsResync) {
          await this.syncHistory(await this.read());
          this.needsResync = false;
        }
        return await operation();
      } catch (error) { this.needsResync = true; throw error; }
    });
  }
  private async syncRecord(record: JournalRecord): Promise<void> {
    if (record.result) {
      const path = join(this.path, 'results', record.result.resultFile), bytes = await readSafe(path);
      if (sha256(bytes) !== record.result.reviewSha256) throw new Error('checkpoint_result_tampered');
      await syncExisting(path, bytes);
    }
    await syncExisting(join(this.path, 'events', eventFile(record.sequence)), `${canonical(record as unknown as Json)}\n`);
  }
  private async syncHistory(state: CheckpointState): Promise<void> {
    await syncExisting(join(this.path, 'plan.json'), `${canonical(this.plan as unknown as Json)}\n`);
    for (const record of state.records) await this.syncRecord(record);
  }
  private async append(record: Omit<JournalRecord, 'sequence' | 'previousDigest' | 'digest'>): Promise<void> {
    const state = await this.read();
    const previousDigest = state.records.at(-1)?.digest ?? this.plan.digest;
    const unsigned = { ...record, sequence: state.records.length + 1, previousDigest } as Omit<JournalRecord, 'digest'>;
    const complete = { ...unsigned, digest: recordDigest(unsigned) };
    await writeExclusive(join(this.path, 'events', eventFile(complete.sequence)), `${canonical(complete as unknown as Json)}\n`);
  }
  private cell(cell: string): void { if (!this.plan.cells.some(candidate => candidate.id === cell)) throw new Error('checkpoint_unknown_cell'); }

  async recordIntent(cell: string, paidAttempt: PaidAttempt, ownership: NativeTargetOwnership): Promise<void> {
    const attempt = snapshotAttempt(paidAttempt);
    return this.write(ownership, async () => {
      this.cell(cell);
      const state = await this.read();
      if (state.finalized) throw new Error('checkpoint_finalized');
      const prior = state.records.find(record => record.type === 'intent' && record.paidAttempt?.id === attempt.id);
      if (prior) {
        if (prior.cell !== cell || prior.paidAttempt?.kind !== attempt.kind) throw new Error('checkpoint_duplicate_attempt');
        await this.syncRecord(prior);
        return;
      }
      if (state.successes.some(success => success.cell === cell)) throw new Error('checkpoint_success_immutable');
      await this.append({ type: 'intent', cell, paidAttempt: attempt });
    });
  }
  async recordUncertain(cell: string, paidAttempt: PaidAttempt, reason: string, ownership: NativeTargetOwnership): Promise<void> {
    const attempt = snapshotAttempt(paidAttempt);
    requireText(reason, 'reason');
    return this.write(ownership, async () => {
      this.cell(cell);
      const state = await this.read();
      if (state.finalized) throw new Error('checkpoint_finalized');
      if (!state.records.some(record => record.type === 'intent' && record.cell === cell && record.paidAttempt?.id === attempt.id && record.paidAttempt.kind === attempt.kind)) throw new Error('checkpoint_missing_intent');
      const prior = state.records.find(record => record.type === 'uncertain' && record.cell === cell && record.paidAttempt?.id === attempt.id && record.reason === reason);
      if (prior) { await this.syncRecord(prior); return; }
      await this.append({ type: 'uncertain', cell, paidAttempt: attempt, reason });
    });
  }
  async recordResult(cell: string, paidAttempt: PaidAttempt, result: CheckpointResult, ownership: NativeTargetOwnership): Promise<void> {
    const attempt = snapshotAttempt(paidAttempt), captured = snapshotResult(result);
    this.cell(cell);
    validateResult(captured, this.plan.cells.find(candidate => candidate.id === cell)!);
    return this.write(ownership, async () => {
      const state = await this.read();
      if (state.finalized) throw new Error('checkpoint_finalized');
      const existing = state.records.find(record => record.type === 'result' && record.cell === cell && record.paidAttempt?.id === attempt.id);
      const priorSuccess = state.successes.find(success => success.cell === cell);
      if (priorSuccess) {
        if (captured.kind === 'success' && priorSuccess.paidAttempt.id === attempt.id && priorSuccess.paidAttempt.kind === attempt.kind && priorSuccess.reviewBytes === captured.reviewBytes) {
          await this.syncRecord(existing!);
          return;
        }
        throw new Error('checkpoint_success_immutable');
      }
      if (existing) {
        if (existing.result?.reviewSha256 === sha256(captured.reviewBytes) && existing.result.kind === captured.kind && existing.result.chunk === captured.chunk && existing.paidAttempt?.kind === attempt.kind && (captured.kind !== 'failure' || existing.result.possiblyBilled === captured.possiblyBilled)) {
          await this.syncRecord(existing);
          return;
        }
        throw new Error('checkpoint_terminal_result_exists');
      }
      if (!state.records.some(record => record.type === 'intent' && record.cell === cell && record.paidAttempt?.id === attempt.id && record.paidAttempt.kind === attempt.kind)) throw new Error('checkpoint_missing_intent');
      const resultFile = resultFileFor(cell, attempt), resultPath = join(this.path, 'results', resultFile);
      try { await writeExclusive(resultPath, captured.reviewBytes); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await syncExisting(resultPath, captured.reviewBytes);
      }
      await this.append({ type: 'result', cell, paidAttempt: attempt, result: { kind: captured.kind, chunk: captured.chunk, reviewSha256: sha256(captured.reviewBytes), resultFile, ...(captured.kind === 'failure' ? { possiblyBilled: captured.possiblyBilled } : {}) } });
    });
  }

  finalize(ownership: NativeTargetOwnership): Promise<void> {
    return this.write(ownership, async () => {
      const state = await this.read();
      if (state.finalized) { await this.syncRecord(state.records.at(-1)!); return; }
      await this.append({ type: 'finalization', finalizedDigest: sha256(canonical(state.records as unknown as Json)) });
    });
  }
}
