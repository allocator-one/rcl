import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { join, relative, resolve, basename } from 'node:path';
import { z } from 'zod';
import { originalRawFindingSchema } from '../telemetry/recovery/source.js';
import { MAX_ARTIFACT_BYTES } from '../telemetry/envelope-validation.js';
import { syncNativeDirectory } from '../converge/native-lock.js';
import { verificationContextFromValidatedCheckpoint } from './checkpoint-verification-context.js';
import {
  appendVerificationRecord, encodeVerificationProof, parseVerificationAnswer, snapshotVerificationEvent, validateVerificationRecords, verificationDigest,
  type VerificationContext, type VerificationEvent, type VerificationIntent, type VerificationPlanInput,
  type VerificationResult, type VerificationState, type VerificationTerminal,
} from './checkpoint-verification.js';
import {
  assertNativeTargetOwnership,
  ownedNativeTargetCommonDir,
  withOwnedNativeOperation,
  type NativeTargetOwnership,
} from '../converge/target-ownership.js';

const VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_CHECKPOINT_PROOF_BYTES = 25 * 1024 * 1024;
const integer = z.number().int().nonnegative().safe();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const bindingNameSchema = z.enum(['captured-inputs', 'source', 'operation', 'launch']);
const bindingReferenceSchema = z.object({ name: bindingNameSchema, file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
  .refine(binding => binding.file === bindingFile(binding.name));
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
/** Strict raw blocking-review wire schema, shared by supplemental async capture. */
export const blockingCheckpointReviewSchema = reviewSchema;
const resultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success'), chunk: integer, reviewBytes: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('failure'), chunk: integer, reviewBytes: z.string().min(1), possiblyBilled: z.boolean() }).strict(),
]);
const resultReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success'), chunk: integer, reviewSha256: digestSchema, resultFile: z.string() }).strict(),
  z.object({ kind: z.literal('failure'), chunk: integer, reviewSha256: digestSchema, resultFile: z.string(), possiblyBilled: z.boolean() }).strict(),
]);
const recordBase = { sequence: integer.min(1), previousDigest: digestSchema, digest: digestSchema };
const attemptRecord = { cell: z.string().min(1), paidAttempt: attemptSchema };
const journalRecordSchema = z.discriminatedUnion('type', [
  z.object({ ...recordBase, type: z.literal('binding'), binding: bindingReferenceSchema }).strict(),
  z.object({ ...recordBase, ...attemptRecord, type: z.literal('intent') }).strict(),
  z.object({ ...recordBase, ...attemptRecord, type: z.literal('result'), result: resultReferenceSchema }).strict(),
  z.object({ ...recordBase, ...attemptRecord, type: z.literal('uncertain'), reason: z.string().refine(value => !!value.trim() && !/[\0\r\n]/.test(value)) }).strict(),
  z.object({ ...recordBase, type: z.literal('finalization'), finalizedDigest: digestSchema }).strict(),
]);
const verificationLateRecordSchema = z.object({ sequence: integer.positive(), previousDigest: digestSchema, digest: digestSchema,
  version: z.literal(1), type: z.literal('late-verification-result'), verificationTerminalDigest: digestSchema,
  result: z.object({ batchIndex: integer, attemptId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/), finishedAtMs: integer, answerBytes: z.string().min(1) }).strict(),
}).strict();
export type CheckpointLateVerificationRecord = DeepReadonly<z.infer<typeof verificationLateRecordSchema>>;
const lateRecordSchema = z.object({ ...recordBase, ...attemptRecord,
  version: z.literal(1), type: z.literal('late-result'), planDigest: digestSchema,
  finalizationDigest: digestSchema, intentDigest: digestSchema, reviewSha256: digestSchema, reviewBytes: z.string().min(1),
}).strict();
// Inline JSON escaping can enlarge a valid raw 8 MiB review. Main file bounds stay unchanged.
const lateFileOptions = Object.freeze({ maxBytes: MAX_ARTIFACT_BYTES, singleLink: true });
const terminalPayloadSchema = z.object({ reportBytes: z.string().min(1), reviewerArtifactBytes: z.string().min(1) }).strict();
const terminalManifestSchema = z.object({ version: z.literal(1), planDigest: digestSchema, finalizationDigest: digestSchema,
  reportSha256: digestSchema, reviewerArtifactSha256: digestSchema,
  reportByteLength: integer.min(1).max(MAX_ARTIFACT_BYTES), reviewerArtifactByteLength: integer.min(1).max(MAX_ARTIFACT_BYTES),
}).strict();
const terminalPayloadOptions = Object.freeze({ maxBytes: MAX_ARTIFACT_BYTES, singleLink: true });
const terminalManifestOptions = Object.freeze({ singleLink: true });
const terminalFileNames = ['manifest.json', 'report.json', 'reviewer-artifact.json'];
const bindingsSchema = z.object({ 'captured-inputs': z.string().optional(), source: z.string().optional(), operation: z.string().optional(), launch: z.string().optional() }).strict();
const proofWireSchema = z.object({ version: z.literal(1), plan: z.unknown(), records: z.array(z.unknown()),
  outcomes: z.array(z.object({ resultFile: z.string(), reviewBytes: z.string() }).strict()), bindings: bindingsSchema }).strict();
const frozenPlanSchema = z.object({
  version: z.literal(1), digest: digestSchema, target: z.string(), headSha: z.string(), mergeBaseSha: z.string(),
  patchSha256: digestSchema, configSha256: digestSchema, specSha256: digestSchema, contextSha256: digestSchema, toolsSha256: digestSchema,
  parser: z.object({ name: z.string(), version: integer.min(1) }).strict(),
  roster: z.array(z.object({ seat: z.string(), model: z.string(), role: z.string(), route: z.string() }).strict()),
  chunks: z.array(z.object({ index: integer, total: integer.min(1), digest: digestSchema }).strict()),
  prompts: z.array(z.object({ seat: z.string(), chunk: integer, systemSha256: digestSchema, userSha256: digestSchema }).strict()),
  cells: z.array(z.object({ id: z.string(), seat: z.string(), chunk: integer, route: z.string(), model: z.string(), role: z.string(), chunkDigest: digestSchema, systemPromptSha256: digestSchema, userPromptSha256: digestSchema }).strict()),
}).strict();

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
export type CheckpointBindingName = z.infer<typeof bindingNameSchema>;
export type CheckpointBindings = Partial<Record<CheckpointBindingName, string>>;
export type CheckpointResult = { kind: 'success'; chunk: number; reviewBytes: string } | { kind: 'failure'; chunk: number; reviewBytes: string; possiblyBilled: boolean };
export interface JournalRecord { sequence: number; previousDigest: string; digest: string; type: 'binding' | 'intent' | 'result' | 'uncertain' | 'finalization'; binding?: { name: CheckpointBindingName; file: string; sha256: string }; cell?: string; paidAttempt?: PaidAttempt; result?: { kind: 'success' | 'failure'; chunk: number; reviewSha256: string; resultFile: string; possiblyBilled?: boolean }; reason?: string; finalizedDigest?: string }
export interface CheckpointState { records: JournalRecord[]; outcomes: Array<{ cell: string; paidAttempt: PaidAttempt; result: CheckpointResult }>; successes: Array<{ cell: string; paidAttempt: PaidAttempt; reviewBytes: string }>; uncertain: Array<{ cell: string; paidAttempt: PaidAttempt }>; finalized: boolean }
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type CheckpointLateAuditRecord = DeepReadonly<z.infer<typeof lateRecordSchema>>;
export interface TerminalCheckpointReport {
  readonly reportBytes: string;
  readonly reviewerArtifactBytes: string;
  readonly reportSha256: string;
  readonly reviewerArtifactSha256: string;
}
export type CheckpointProof = DeepReadonly<{ version: 1; bytes: string; digest: string; plan: FrozenCheckpointPlan; state: CheckpointState; bindings: CheckpointBindings }>;
const validatedProofs = new WeakSet<object>();

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
async function readSafe(path: string, preserveBom = false, options: { maxBytes?: number; singleLink?: boolean } = {}): Promise<string> {
  const entry = await lstat(path); if (!entry.isFile() || entry.isSymbolicLink() || entry.size > (options.maxBytes ?? MAX_FILE_BYTES) || options.singleLink && entry.nlink !== 1 || (entry.mode & 0o7777) !== 0o600 || (process.geteuid && entry.uid !== process.geteuid())) throw new Error('checkpoint_symlink');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const before = await handle.stat(); if (!before.isFile() || before.size !== entry.size || before.ino !== entry.ino || before.dev !== entry.dev || before.mtimeMs !== entry.mtimeMs || before.ctimeMs !== entry.ctimeMs || options.singleLink && before.nlink !== 1) throw new Error('checkpoint_changing_source'); const bytes = Buffer.alloc(before.size); let offset = 0; while (offset < bytes.length) { const next = await handle.read(bytes, offset, bytes.length - offset, offset); if (!next.bytesRead) break; offset += next.bytesRead; } const after = await handle.stat(), current = await lstat(path); if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || options.singleLink && (after.nlink !== 1 || current.nlink !== 1)) throw new Error('checkpoint_changing_source'); return new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBom }).decode(bytes); } finally { await handle.close(); }
}

async function writeExclusive(path: string, bytes: string, maxBytes = MAX_FILE_BYTES): Promise<void> {
  boundedBytes(bytes, maxBytes);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncNativeDirectory(resolve(path, '..'));
}

/** Event records are staged outside the observed journal namespace before an exclusive link publishes them. */
async function publishEventExclusive(journalPath: string, name: string, bytes: string, maxBytes = MAX_FILE_BYTES): Promise<void> {
  boundedBytes(bytes, maxBytes);
  const eventDirectory = join(journalPath, 'events');
  const targetDirectory = resolve(journalPath, '..');
  await inspectDirectory(eventDirectory);
  const stagingDirectory = await ensurePrivateChild(targetDirectory, '.staging');
  const staged = join(stagingDirectory, `${randomUUID()}.pending`);
  const published = join(eventDirectory, name);
  let stagedCreated = false, linked = false;
  try {
    await writeExclusive(staged, bytes, maxBytes);
    stagedCreated = true;
    await link(staged, published);
    linked = true;
    // The event name is durable before removing the otherwise invisible staging link.
    await syncNativeDirectory(eventDirectory);
  } finally {
    if (stagedCreated) {
      try { await unlink(staged); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await syncNativeDirectory(stagingDirectory);
    }
  }
  // Preserve the acknowledged file and directory durability boundary used by replay.
  if (linked) await syncExisting(published, bytes, false, { maxBytes });
}
function boundedBytes(bytes: string, maxBytes = MAX_FILE_BYTES): void {
  if (Buffer.byteLength(bytes, 'utf8') > maxBytes) throw new Error('checkpoint_file_too_large');
}

/** An identical visible file is not proof that a previous fsync succeeded. */
async function syncExisting(path: string, expected?: string, preserveBom = false, options: { maxBytes?: number; singleLink?: boolean } = {}): Promise<void> {
  await inspectDirectory(resolve(path, '..'));
  const entry = await lstat(path);
  const bytes = await readSafe(path, preserveBom, options);
  if (expected !== undefined && bytes !== expected) throw new Error('checkpoint_changing_source');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev || opened.size !== entry.size ||
      opened.mtimeMs !== entry.mtimeMs || opened.ctimeMs !== entry.ctimeMs || options.singleLink && opened.nlink !== 1) throw new Error('checkpoint_changing_source');
    await handle.sync();
    const current = await lstat(path);
    if (current.ino !== opened.ino || current.dev !== opened.dev || current.mtimeMs !== opened.mtimeMs ||
      current.ctimeMs !== opened.ctimeMs || current.isSymbolicLink() || options.singleLink && current.nlink !== 1) throw new Error('checkpoint_changing_source');
  } finally { await handle.close(); }
  await syncNativeDirectory(resolve(path, '..'));
}
function decodePlan(text: string): FrozenCheckpointPlan {
  boundedBytes(text);
  let plan: FrozenCheckpointPlan; try { plan = frozenPlanSchema.parse(JSON.parse(text)); } catch { throw new Error('checkpoint_invalid_plan'); }
  const recalculated = freezeCheckpointPlan(plan);
  if (plan.version !== VERSION || plan.digest !== recalculated.digest || canonical(plan as unknown as Json) !== canonical(recalculated as unknown as Json)) throw new Error('checkpoint_invalid_plan');
  return recalculated;
}
function matchingPlan(actual: FrozenCheckpointPlan, expected: FrozenCheckpointPlan): boolean { return actual.digest === expected.digest && canonical(actual as unknown as Json) === canonical(expected as unknown as Json); }
function eventFile(sequence: number): string { return `${String(sequence).padStart(8, '0')}.json`; }
function bindingFile(name: CheckpointBindingName): string { return `binding-${name}.data`; }

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
function validateReviewBytes(bytes: string, cell: CheckpointCell): z.infer<typeof reviewSchema> {
  if (typeof bytes !== 'string' || !bytes) throw new Error('checkpoint_invalid_result');
  boundedBytes(bytes);
  let review: unknown; try { review = JSON.parse(bytes); } catch { throw new Error('checkpoint_invalid_result'); }
  const parsed = reviewSchema.safeParse(review);
  if (!parsed.success) throw new Error('checkpoint_invalid_result');
  const item = parsed.data;
  if (item.model !== cell.model || item.role !== cell.role || item.provider !== cell.route) throw new Error('checkpoint_result_cell_mismatch');
  return item;
}
function validateResult(result: CheckpointResult, cell: CheckpointCell): void {
  if (!Number.isSafeInteger(result.chunk) || result.chunk !== cell.chunk || typeof result.reviewBytes !== 'string' || !result.reviewBytes) throw new Error('checkpoint_result_cell_mismatch');
  const item = validateReviewBytes(result.reviewBytes, cell);
  if ((result.kind === 'success') !== (item.status === 'success')) throw new Error('checkpoint_result_cell_mismatch');
}


function boundedOpaqueBytes(bytes: string): void {
  boundedBytes(bytes);
  if (Buffer.from(bytes, 'utf8').toString('utf8') !== bytes) throw new Error('checkpoint_invalid_bytes');
}

function validateRecordChain(input: unknown[], plan: FrozenCheckpointPlan): JournalRecord[] {
  let previous = plan.digest;
  return input.map((value, index) => {
    const parsed = journalRecordSchema.safeParse(value);
    if (!parsed.success) throw new Error('checkpoint_invalid_record');
    const record = parsed.data, { digest, ...unsigned } = record;
    boundedBytes(canonical(record as unknown as Json));
    if (record.sequence !== index + 1 || record.previousDigest !== previous || digest !== recordDigest(unsigned)) throw new Error('checkpoint_invalid_record');
    if (record.type === 'result' && !validResultReference(record.result, record.cell, record.paidAttempt)) throw new Error('checkpoint_invalid_record');
    previous = digest;
    return record;
  });
}

/** One semantic validator for both private files and portable proof bytes. */
function validateHistory(plan: FrozenCheckpointPlan, records: JournalRecord[], resultBytes: Map<string, string>, suppliedBindings: CheckpointBindings): { state: CheckpointState; bindings: CheckpointBindings } {
  const cells = new Set(plan.cells.map(cell => cell.id));
  const intents = new Map<string, PaidAttempt>(), terminalAttempts = new Map<string, JournalRecord>(), outcomes: Array<{ cell: string; paidAttempt: PaidAttempt; result: CheckpointResult }> = [], successes: Array<{ cell: string; paidAttempt: PaidAttempt; reviewBytes: string }> = [];
  const successfulCells = new Set<string>(), attemptIds = new Set<string>(), bindings: CheckpointBindings = {}; let finalized = false;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.type === 'binding') {
      const parsed = bindingReferenceSchema.safeParse(record.binding);
      if (!parsed.success || Object.keys(record).some(key => !['sequence', 'previousDigest', 'digest', 'type', 'binding'].includes(key))) throw new Error('checkpoint_invalid_binding');
      if (finalized || intents.size) throw new Error('checkpoint_binding_closed');
      const binding = parsed.data;
      if (Object.hasOwn(bindings, binding.name)) throw new Error('checkpoint_duplicate_binding');
      const bytes = suppliedBindings[binding.name];
      if (typeof bytes !== 'string') throw new Error('checkpoint_missing_binding');
      boundedOpaqueBytes(bytes);
      if (sha256(bytes) !== binding.sha256) throw new Error('checkpoint_binding_tampered');
      bindings[binding.name] = bytes;
      continue;
    }
    if (Object.hasOwn(record, 'binding')) throw new Error('checkpoint_invalid_record');
    if (record.type === 'finalization') { if (finalized || !record.finalizedDigest || index !== records.length - 1 || record.finalizedDigest !== sha256(canonical(records.slice(0, -1) as unknown as Json))) throw new Error('checkpoint_invalid_finalization'); finalized = true; continue; }
    if (finalized || !record.cell || !record.paidAttempt || !cells.has(record.cell) || !validAttempt(record.paidAttempt)) throw new Error('checkpoint_invalid_record');
    const key = `${record.cell}\0${record.paidAttempt.id}`;
    if (record.type === 'intent') { if (successfulCells.has(record.cell)) throw new Error('checkpoint_success_immutable'); if (intents.has(key) || attemptIds.has(record.paidAttempt.id)) throw new Error('checkpoint_duplicate_attempt'); intents.set(key, record.paidAttempt); attemptIds.add(record.paidAttempt.id); continue; }
    if (!intents.has(key) || intents.get(key)!.kind !== record.paidAttempt.kind) throw new Error('checkpoint_missing_intent');
    if (record.type === 'uncertain') continue;
    if (record.type === 'result') {
      if (!record.result || terminalAttempts.has(key) || successfulCells.has(record.cell) || !validResultReference(record.result, record.cell, record.paidAttempt)) throw new Error('checkpoint_invalid_record');
      terminalAttempts.set(key, record);
      const bytes = resultBytes.get(record.result.resultFile);
      if (typeof bytes !== 'string') throw new Error('checkpoint_missing_result');
      boundedOpaqueBytes(bytes);
      if (sha256(bytes) !== record.result.reviewSha256) throw new Error('checkpoint_result_tampered');
      const cell = plan.cells.find(candidate => candidate.id === record.cell)!; const result: CheckpointResult = record.result.kind === 'success' ? { kind: 'success', chunk: record.result.chunk, reviewBytes: bytes } : { kind: 'failure', chunk: record.result.chunk, reviewBytes: bytes, possiblyBilled: record.result.possiblyBilled === true }; validateResult(result, cell); outcomes.push({ cell: record.cell, paidAttempt: record.paidAttempt, result }); if (record.result.kind === 'success') { successfulCells.add(record.cell); successes.push({ cell: record.cell, paidAttempt: record.paidAttempt, reviewBytes: bytes }); }
    }
  }
  const uncertain = [...intents.entries()].filter(([key]) => !terminalAttempts.has(key)).map(([key, paidAttempt]) => ({ cell: key.split('\0')[0]!, paidAttempt }));
  if (Object.keys(bindings).length !== Object.keys(suppliedBindings).length || terminalAttempts.size !== resultBytes.size) throw new Error('checkpoint_unreferenced_bytes');
  return { state: { records, outcomes, successes, uncertain, finalized }, bindings };
}

/** Structural integrity only: this brand does not attest providers or source authority. */
export function isCheckpointProof(value: unknown): value is CheckpointProof {
  return typeof value === 'object' && value !== null && validatedProofs.has(value);
}

/** Decode canonical portable bytes using the same plan, chain and outcome validation as disk reads. */
export function decodeCheckpointProof(bytes: string, expectedPlan?: FrozenCheckpointPlan | CheckpointProof['plan']): CheckpointProof {
  if (typeof bytes !== 'string') throw new Error('checkpoint_invalid_proof');
  if (Buffer.byteLength(bytes, 'utf8') > MAX_CHECKPOINT_PROOF_BYTES) throw new Error('checkpoint_proof_too_large');
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_invalid_proof'); }
  const parsed = proofWireSchema.safeParse(value);
  if (!parsed.success) throw new Error('checkpoint_invalid_proof');
  const wire = parsed.data;
  if (canonical(wire as unknown as Json) !== bytes) throw new Error('checkpoint_proof_noncanonical');
  const plan = decodePlan(canonical(wire.plan as Json));
  if (expectedPlan && !matchingPlan(plan, decodePlan(canonical(expectedPlan as unknown as Json)))) throw new Error('checkpoint_plan_mismatch');
  const records = validateRecordChain(wire.records, plan);
  const references = records.filter(record => record.type === 'result');
  if (references.length !== wire.outcomes.length) throw new Error('checkpoint_proof_outcomes_mismatch');
  const resultBytes = new Map<string, string>();
  for (const [index, outcome] of wire.outcomes.entries()) {
    if (references[index]!.result!.resultFile !== outcome.resultFile || resultBytes.has(outcome.resultFile)) throw new Error('checkpoint_proof_outcomes_mismatch');
    resultBytes.set(outcome.resultFile, outcome.reviewBytes);
  }
  const { state, bindings } = validateHistory(plan, records, resultBytes, wire.bindings);
  if (!state.finalized) throw new Error('checkpoint_proof_unsealed');
  const proof: CheckpointProof = deepFreeze({ version: 1 as const, bytes, digest: sha256(bytes), plan, state, bindings });
  validatedProofs.add(proof);
  return proof;
}

/** Export only a validated sealed journal. No live provider or lineage authority is inferred. */
export function exportCheckpointProof(journal: CheckpointJournal): Promise<CheckpointProof> {
  return journal.exportProof();
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

  /**
   * Structural inspection only: validate the stored plan and complete history.
   * This supplies no freshness, source authority or recovery eligibility proof.
   * Callers needing an expected input binding must still use openRead(expected).
   */
  static async inspectRead(path: string): Promise<CheckpointJournal> {
    const canonicalPath = resolve(path);
    await inspectDirectory(canonicalPath);
    const stored = decodePlan((await readSafe(join(canonicalPath, 'plan.json'))).trim());
    return CheckpointJournal.openRead(canonicalPath, stored);
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

  async read(): Promise<CheckpointState> { return (await this.readValidated()).state; }

  /** Exact immutable metadata bytes; validates the entire journal without writing. */
  async readBindings(): Promise<CheckpointBindings> { return (await this.readValidated()).bindings; }

  /**
   * Freeze a distinct, explicitly capped verifier phase after reviewer sealing.
   * This storage contract never expands reviewer-cell caps or establishes spend,
   * capture, provider or server authority. The executor must regenerate the plan
   * from validated captures, authorize its separate cap and disable SDK retries.
   */
  async beginVerification(input: VerificationPlanInput, ownership: NativeTargetOwnership): Promise<void> {
    await this.appendVerification({ type: 'plan', plan: input }, ownership);
  }

  /**
   * True only for a newly durable intent. False means a prior intent exists and
   * must NEVER be launched again, even when its first fsync acknowledgment failed.
   * A true result is a storage claim, not independent provider launch authority.
   */
  async recordVerificationIntent(input: VerificationIntent, ownership: NativeTargetOwnership): Promise<boolean> {
    return this.appendVerification({ type: 'intent', intent: input }, ownership);
  }

  /** Late verifier answers are audit-only and never change the sealed verifier proof. */
  async readLateVerificationAudit(): Promise<readonly CheckpointLateVerificationRecord[]> {
    const main = await this.readValidated(), context = this.verificationContext(main);
    const verification = await this.readVerificationValidated(context);
    if (!verification?.terminal) throw new Error('checkpoint_verification_late_requires_terminal');
    return this.readLateVerificationAuditValidated(verification);
  }

  async recordLateVerificationResult(input: VerificationResult, ownership: NativeTargetOwnership): Promise<void> {
    const snapshot = snapshotVerificationEvent({ type: 'result', result: input });
    if (snapshot.type !== 'result') throw new Error('checkpoint_verification_late_invalid_result');
    const result = snapshot.result;
    return this.write(ownership, async () => {
      const main = await this.readValidated(), context = this.verificationContext(main);
      const verification = await this.readVerificationValidated(context);
      if (!verification?.terminal) throw new Error('checkpoint_verification_late_requires_terminal');
      parseVerificationAnswer(result.answerBytes, verification.plan);
      const intent = verification.intents.find(item => item.batchIndex === result.batchIndex && item.attemptId === result.attemptId);
      if (!intent || result.finishedAtMs < intent.startedAtMs) throw new Error('checkpoint_verification_late_invalid_result');
      const prior = await this.readLateVerificationAuditValidated(verification);
      const existing = prior.find(item => item.result.attemptId === result.attemptId);
      if (existing) {
        if (existing.result.batchIndex !== result.batchIndex || existing.result.finishedAtMs !== result.finishedAtMs || existing.result.answerBytes !== result.answerBytes) throw new Error('checkpoint_verification_late_conflict');
        const events = join(this.path, 'verification-late-audit', 'events');
        for (const record of prior) await syncExisting(join(events, eventFile(record.sequence)), `${canonical(record as unknown as Json)}\n`, true, { maxBytes: MAX_ARTIFACT_BYTES, singleLink: true });
        return;
      }
      if (prior.length >= verification.intents.length) throw new Error('checkpoint_verification_late_call_cap');
      const directory = await ensurePrivateChild(this.path, 'verification-late-audit');
      await ensurePrivateChild(directory, 'events');
      const terminalDigest = verification.records.at(-1)!.digest;
      const unsigned = { sequence: prior.length + 1, previousDigest: prior.at(-1)?.digest ?? terminalDigest,
        version: 1 as const, type: 'late-verification-result' as const, verificationTerminalDigest: terminalDigest, result };
      const record = { ...unsigned, digest: verificationDigest(canonical(unsigned as unknown as Json)) };
      const total = prior.reduce((sum, item) => sum + Buffer.byteLength(`${canonical(item as unknown as Json)}\n`, 'utf8'), 0) + Buffer.byteLength(`${canonical(record as unknown as Json)}\n`, 'utf8');
      if (total > MAX_ARTIFACT_BYTES) throw new Error('checkpoint_verification_late_too_large');
      const events = join(directory, 'events');
      for (const existingRecord of prior) await syncExisting(join(events, eventFile(existingRecord.sequence)), `${canonical(existingRecord as unknown as Json)}\n`, true, { maxBytes: MAX_ARTIFACT_BYTES, singleLink: true });
      await publishEventExclusive(directory, eventFile(record.sequence), `${canonical(record as unknown as Json)}\n`, MAX_ARTIFACT_BYTES);
    });
  }

  private async readLateVerificationAuditValidated(verification: VerificationState): Promise<readonly CheckpointLateVerificationRecord[]> {
    const directory = join(this.path, 'verification-late-audit');
    try { await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]); throw error; }
    await inspectDirectory(directory);
    const rootEntries = await readdir(directory);
    if (rootEntries.some(name => name !== 'events')) throw new Error('checkpoint_verification_late_unknown_entry');
    if (!verification.terminal) throw new Error('checkpoint_verification_late_requires_terminal');
    const terminalDigest = verification.records.at(-1)!.digest;
    const events = join(directory, 'events');
    try { await lstat(events); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]); throw error; }
    await inspectDirectory(events);
    const names = (await readdir(events)).sort();
    if (names.length > verification.intents.length) throw new Error('checkpoint_verification_late_call_cap');
    const records: CheckpointLateVerificationRecord[] = []; const attempts = new Set<string>(); let previous = terminalDigest; let total = 0;
    for (const [index, name] of names.entries()) {
      if (name !== eventFile(index + 1)) throw new Error('checkpoint_verification_late_unknown_entry');
      const bytes = await readSafe(join(events, name), true, { maxBytes: MAX_ARTIFACT_BYTES, singleLink: true }); total += Buffer.byteLength(bytes, 'utf8');
      if (total > MAX_ARTIFACT_BYTES) throw new Error('checkpoint_verification_late_too_large');
      let value: unknown; try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_verification_late_invalid_record'); }
      const parsed = verificationLateRecordSchema.safeParse(value); if (!parsed.success) throw new Error('checkpoint_verification_late_invalid_record');
      const record = parsed.data, { digest: hash, ...unsigned } = record;
      if (record.sequence !== index + 1 || record.previousDigest !== previous || record.verificationTerminalDigest !== terminalDigest ||
        hash !== verificationDigest(canonical(unsigned as unknown as Json)) || bytes !== `${canonical(record as unknown as Json)}\n` || attempts.has(record.result.attemptId)) throw new Error('checkpoint_verification_late_invalid_record');
      const intent = verification.intents.find(item => item.batchIndex === record.result.batchIndex && item.attemptId === record.result.attemptId);
      if (!intent || record.result.finishedAtMs < intent.startedAtMs) throw new Error('checkpoint_verification_late_invalid_record');
      parseVerificationAnswer(record.result.answerBytes, verification.plan);
      attempts.add(record.result.attemptId); records.push(deepFreeze(record)); previous = hash;
    }
    return Object.freeze(records);
  }

  /** Exact observed adapter bytes; failed/late answers remain physical history. */
  async recordVerificationResult(input: VerificationResult, ownership: NativeTargetOwnership): Promise<void> {
    await this.appendVerification({ type: 'result', result: input }, ownership);
  }

  /** A terminal storage outcome, never a finding verdict or approval. */
  async finalizeVerification(input: VerificationTerminal, ownership: NativeTargetOwnership): Promise<void> {
    await this.appendVerification({ type: 'terminal', terminal: input }, ownership);
  }

  async readVerification(): Promise<VerificationState | undefined> {
    const directory = join(this.path, 'verification');
    // Validate main history even when no phase has been created.
    const main = await this.readValidated();
    try { await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    return this.readVerificationValidated(this.verificationContext(main));
  }

  async exportVerificationProof(): Promise<{ bytes: string; digest: string }> {
    const context = this.verificationContext(await this.readValidated());
    const state = await this.readVerificationValidated(context);
    if (!state?.terminal) throw new Error('checkpoint_verification_unsealed');
    return encodeVerificationProof(state, context);
  }

  private verificationContext(main: { state: CheckpointState; bindings: CheckpointBindings }): VerificationContext {
    return verificationContextFromValidatedCheckpoint(this.plan, main);
  }

  private async readVerificationValidated(context: VerificationContext): Promise<VerificationState | undefined> {
    const directory = join(this.path, 'verification');
    try { await lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    await inspectDirectory(directory);
    const entries = await readdir(directory);
    if (entries.some(name => name !== 'events')) throw new Error('checkpoint_verification_unknown_entry');
    // A crash while publishing the empty directories consumed no intent.
    if (!entries.length) return undefined;
    const events = join(directory, 'events'); await inspectDirectory(events);
    const names = (await readdir(events)).sort(), values: unknown[] = [];
    if (names.length > 1002) throw new Error('checkpoint_verification_too_many_records');
    let totalBytes = 0;
    for (const [index, name] of names.entries()) {
      if (name !== eventFile(index + 1)) throw new Error('checkpoint_verification_sequence_gap');
      const bytes = await readSafe(join(events, name), true, { maxBytes: MAX_ARTIFACT_BYTES, singleLink: true });
      totalBytes += Buffer.byteLength(bytes, 'utf8');
      if (totalBytes > MAX_ARTIFACT_BYTES) throw new Error('checkpoint_verification_too_large');
      let value: unknown;
      try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_verification_invalid_record'); }
      if (bytes !== `${canonical(value as Json)}\n`) throw new Error('checkpoint_verification_noncanonical');
      values.push(value);
    }
    return validateVerificationRecords(values, context);
  }

  private async appendVerification(input: VerificationEvent, ownership: NativeTargetOwnership): Promise<boolean> {
    const event = snapshotVerificationEvent(input);
    return this.write(ownership, async () => {
      const context = this.verificationContext(await this.readValidated());
      const state = await this.readVerificationValidated(context), records = state?.records ?? [];
      const prior = records.find(row => row.event.type === event.type &&
        (event.type === 'intent' ? row.event.type === 'intent' && row.event.intent.attemptId === event.intent.attemptId
          : event.type === 'result' ? row.event.type === 'result' && row.event.result.attemptId === event.result.attemptId : true));
      if (prior && canonical(prior.event as unknown as Json) !== canonical(event as unknown as Json)) throw new Error('checkpoint_verification_conflict');
      // An immutable report, including a surviving partial publication, closes
      // this run to new paid work. Only identical records of a sealed phase can
      // be re-acknowledged afterward; they never return a new launch claim.
      if (await this.terminalReportEntries() !== undefined && (!state?.terminal || !prior)) {
        throw new Error('checkpoint_verification_report_finalized');
      }
      const record = prior ? undefined : appendVerificationRecord(records, event, context);
      if (!state && event.type !== 'plan') throw new Error('checkpoint_verification_missing_plan');
      const directory = await ensurePrivateChild(this.path, 'verification'); await ensurePrivateChild(directory, 'events');
      for (const existing of records) {
        await syncExisting(join(directory, 'events', eventFile(existing.sequence)), `${canonical(existing as unknown as Json)}\n`, true,
          { maxBytes: MAX_ARTIFACT_BYTES, singleLink: true });
      }
      if (!record) return false;
      await publishEventExclusive(directory, eventFile(record.sequence), `${canonical(record as unknown as Json)}\n`, MAX_ARTIFACT_BYTES);
      return true;
    });
  }

  /**
   * Retain opaque terminal bytes after sealing, under the caller's ownership.
   * Exact orphan payloads can resume; no existing bytes are replaced. The final
   * manifest publishes the pair and does not confer producer authority.
   */
  async retainTerminalReport(input: { reportBytes: string; reviewerArtifactBytes: string }, ownership: NativeTargetOwnership): Promise<void> {
    const parsed = terminalPayloadSchema.safeParse(input);
    if (!parsed.success) throw new Error('checkpoint_invalid_terminal_report');
    const captured = parsed.data;
    for (const bytes of Object.values(captured)) {
      boundedBytes(bytes, MAX_ARTIFACT_BYTES);
      if (Buffer.from(bytes, 'utf8').toString('utf8') !== bytes) throw new Error('checkpoint_invalid_bytes');
    }
    return this.write(ownership, async () => {
      const state = await this.read();
      if (!state.finalized) throw new Error('checkpoint_terminal_report_requires_finalization');
      const verification = await this.readVerification();
      if (verification && !verification.terminal) throw new Error('checkpoint_terminal_report_verification_pending');
      const directory = join(this.path, 'terminal-report'), names = await this.terminalReportEntries();
      const payloads = [['report.json', captured.reportBytes], ['reviewer-artifact.json', captured.reviewerArtifactBytes]] as const;
      if (names?.includes('manifest.json')) {
        const published = await this.readTerminalReportValidated(state);
        if (published!.reportBytes !== captured.reportBytes || published!.reviewerArtifactBytes !== captured.reviewerArtifactBytes) {
          throw new Error('checkpoint_terminal_report_conflict');
        }
      } else {
        // Validate every surviving orphan before writing any missing file. A
        // truncated/conflicting payload is evidence of failure, never a prefix
        // that can be repaired or attributed to this caller's report.
        for (const [name, bytes] of payloads) {
          if (names?.includes(name) && await readSafe(join(directory, name), true, terminalPayloadOptions) !== bytes) {
            throw new Error('checkpoint_terminal_report_conflict');
          }
        }
      }
      await ensurePrivateChild(this.path, 'terminal-report');
      for (const [name, bytes] of payloads) {
        const path = join(directory, name);
        if (!names?.includes(name)) await writeExclusive(path, bytes, MAX_ARTIFACT_BYTES);
        await syncExisting(path, bytes, true, terminalPayloadOptions);
      }
      const manifest = { version: 1, planDigest: this.plan.digest, finalizationDigest: state.records.at(-1)!.digest,
        reportSha256: sha256(captured.reportBytes), reviewerArtifactSha256: sha256(captured.reviewerArtifactBytes),
        reportByteLength: Buffer.byteLength(captured.reportBytes, 'utf8'), reviewerArtifactByteLength: Buffer.byteLength(captured.reviewerArtifactBytes, 'utf8') };
      const bytes = `${canonical(manifest as unknown as Json)}\n`, path = join(directory, 'manifest.json');
      if (!names?.includes('manifest.json')) await writeExclusive(path, bytes);
      await syncExisting(path, bytes, true, terminalManifestOptions);
    });
  }

  /** Exact private payloads only after complete publication; no report semantics are inferred. */
  async readTerminalReport(): Promise<TerminalCheckpointReport | undefined> {
    return this.readTerminalReportValidated(await this.read());
  }

  private async terminalReportEntries(): Promise<string[] | undefined> {
    const path = join(this.path, 'terminal-report');
    try { await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    await inspectDirectory(path);
    const names = (await readdir(path)).sort();
    if (names.some(name => !terminalFileNames.includes(name))) throw new Error('checkpoint_terminal_report_unknown_entry');
    return names;
  }

  private async readTerminalReportValidated(state: CheckpointState): Promise<TerminalCheckpointReport | undefined> {
    const names = await this.terminalReportEntries();
    if (names === undefined) return undefined;
    if (!state.finalized) throw new Error('checkpoint_terminal_report_requires_finalization');
    if (names.length !== terminalFileNames.length) throw new Error('checkpoint_terminal_report_incomplete');
    const path = join(this.path, 'terminal-report'), bytes = await readSafe(join(path, 'manifest.json'), true, terminalManifestOptions);
    let value: unknown;
    try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_invalid_terminal_manifest'); }
    const parsed = terminalManifestSchema.safeParse(value);
    if (!parsed.success) throw new Error('checkpoint_invalid_terminal_manifest');
    const manifest = parsed.data;
    if (bytes !== `${canonical(manifest as unknown as Json)}\n` || manifest.planDigest !== this.plan.digest ||
      manifest.finalizationDigest !== state.records.at(-1)!.digest) throw new Error('checkpoint_invalid_terminal_manifest');
    const reportBytes = await readSafe(join(path, 'report.json'), true, terminalPayloadOptions);
    const reviewerArtifactBytes = await readSafe(join(path, 'reviewer-artifact.json'), true, terminalPayloadOptions);
    if (Buffer.byteLength(reportBytes, 'utf8') !== manifest.reportByteLength || Buffer.byteLength(reviewerArtifactBytes, 'utf8') !== manifest.reviewerArtifactByteLength ||
      sha256(reportBytes) !== manifest.reportSha256 || sha256(reviewerArtifactBytes) !== manifest.reviewerArtifactSha256) throw new Error('checkpoint_terminal_report_tampered');
    return Object.freeze({ reportBytes, reviewerArtifactBytes, reportSha256: manifest.reportSha256, reviewerArtifactSha256: manifest.reviewerArtifactSha256 });
  }

  /** Late observations are audit-only and never enter the sealed main proof or accounting. */
  async readLateAudit(): Promise<readonly CheckpointLateAuditRecord[]> {
    return this.readLateAuditValidated(await this.read());
  }

  private async readLateAuditValidated(state: CheckpointState): Promise<readonly CheckpointLateAuditRecord[]> {
    const path = join(this.path, 'late-audit');
    try { await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]); throw error; }
    await inspectDirectory(path);
    if (!state.finalized) throw new Error('checkpoint_late_requires_finalization');
    const finalization = state.records.at(-1)!;
    const names = (await readdir(path)).sort(), records: CheckpointLateAuditRecord[] = [], attempts = new Set<string>();
    let previous = finalization.digest;
    for (const [index, name] of names.entries()) {
      if (name !== eventFile(index + 1)) throw new Error('checkpoint_late_unknown_entry');
      const bytes = await readSafe(join(path, name), true, lateFileOptions);
      let value: unknown;
      try { value = JSON.parse(bytes); } catch { throw new Error('checkpoint_invalid_late_record'); }
      const parsed = lateRecordSchema.safeParse(value);
      if (!parsed.success) throw new Error('checkpoint_invalid_late_record');
      const record = parsed.data, { digest, ...unsigned } = record;
      if (record.sequence !== index + 1 || record.previousDigest !== previous || digest !== sha256(canonical(unsigned as unknown as Json)) ||
        bytes !== `${canonical(record as unknown as Json)}\n` || record.planDigest !== this.plan.digest || record.finalizationDigest !== finalization.digest || attempts.has(record.paidAttempt.id)) throw new Error('checkpoint_invalid_late_record');
      const intent = state.records.find(row => row.type === 'intent' && row.cell === record.cell && row.paidAttempt?.id === record.paidAttempt.id && row.paidAttempt.kind === record.paidAttempt.kind);
      const cell = this.plan.cells.find(cell => cell.id === record.cell);
      if (!intent || !cell || intent.digest !== record.intentDigest) throw new Error('checkpoint_late_missing_intent');
      boundedOpaqueBytes(record.reviewBytes); validateReviewBytes(record.reviewBytes, cell);
      if (sha256(record.reviewBytes) !== record.reviewSha256) throw new Error('checkpoint_late_tampered');
      attempts.add(record.paidAttempt.id); previous = digest; records.push(record);
    }
    return deepFreeze(records);
  }

  private async syncLateRecord(record: CheckpointLateAuditRecord): Promise<void> {
    await syncExisting(join(this.path, 'late-audit', eventFile(record.sequence)), `${canonical(record as unknown as Json)}\n`, true, lateFileOptions);
  }

  /** Caller retains live original ownership while draining; no ownership is created here. */
  async recordLateResult(cell: string, paidAttempt: PaidAttempt, rawReviewBytes: string, ownership: NativeTargetOwnership): Promise<void> {
    const attempt = snapshotAttempt(paidAttempt);
    this.cell(cell); validateReviewBytes(rawReviewBytes, this.plan.cells.find(candidate => candidate.id === cell)!); boundedOpaqueBytes(rawReviewBytes);
    return this.write(ownership, async () => {
      const state = await this.read();
      if (!state.finalized) throw new Error('checkpoint_late_requires_finalization');
      const intent = state.records.find(row => row.type === 'intent' && row.cell === cell && row.paidAttempt?.id === attempt.id && row.paidAttempt.kind === attempt.kind);
      if (!intent) throw new Error('checkpoint_late_missing_intent');
      const records = await this.readLateAuditValidated(state);
      const prior = records.find(record => record.paidAttempt.id === attempt.id);
      if (prior && prior.reviewBytes !== rawReviewBytes) throw new Error('checkpoint_late_conflict');
      const finalizationDigest = state.records.at(-1)!.digest;
      const unsigned = { version: 1 as const, type: 'late-result' as const, sequence: records.length + 1, previousDigest: records.at(-1)?.digest ?? finalizationDigest,
        planDigest: this.plan.digest, finalizationDigest, intentDigest: intent.digest, cell, paidAttempt: attempt,
        reviewSha256: sha256(rawReviewBytes), reviewBytes: rawReviewBytes };
      const record = { ...unsigned, digest: sha256(canonical(unsigned as unknown as Json)) };
      const bytes = `${canonical(record as unknown as Json)}\n`;
      boundedBytes(bytes, lateFileOptions.maxBytes);
      const path = await ensurePrivateChild(this.path, 'late-audit');
      // Reflush acknowledged history too: a prior process may have lost an fsync acknowledgment.
      for (const existing of records) await this.syncLateRecord(existing);
      if (prior) return;
      await writeExclusive(join(path, eventFile(record.sequence)), bytes, lateFileOptions.maxBytes);
      await this.syncLateRecord(record);
    });
  }

  async exportProof(): Promise<CheckpointProof> {
    const { state, bindings } = await this.readValidated(MAX_CHECKPOINT_PROOF_BYTES);
    if (!state.finalized) throw new Error('checkpoint_proof_unsealed');
    let outcomeIndex = 0;
    const outcomes = state.records.filter(record => record.type === 'result').map(record => ({
      resultFile: record.result!.resultFile, reviewBytes: state.outcomes[outcomeIndex++]!.result.reviewBytes,
    }));
    const bytes = canonical({ version: 1, plan: this.plan, records: state.records, outcomes, bindings } as unknown as Json);
    return decodeCheckpointProof(bytes, this.plan);
  }

  private async readValidated(maxRetainedBytes?: number): Promise<{ state: CheckpointState; bindings: CheckpointBindings }> {
    await inspectDirectory(this.path); await inspectDirectory(join(this.path, 'events')); await inspectDirectory(join(this.path, 'results'));
    const actual = decodePlan((await readSafe(join(this.path, 'plan.json'))).trim());
    if (!matchingPlan(actual, this.plan)) throw new Error('checkpoint_plan_mismatch');
    let retainedBytes = 0;
    const retain = (bytes: string): string => {
      retainedBytes += Buffer.byteLength(bytes, 'utf8');
      if (maxRetainedBytes !== undefined && retainedBytes > maxRetainedBytes) throw new Error('checkpoint_proof_too_large');
      return bytes;
    };
    retain(canonical(actual as unknown as Json));
    const names = (await readdir(join(this.path, 'events'))).sort();
    const rawRecords: unknown[] = [];
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== eventFile(i + 1)) throw new Error('checkpoint_sequence_gap');
      let bytes = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try { bytes = await readSafe(join(this.path, 'events', names[i]!)); break; }
        catch (error) {
          if (error instanceof Error && error.message === 'checkpoint_changing_source' && attempt < 2) continue;
          if (error instanceof Error && error.message === 'checkpoint_symlink') throw error;
          throw new Error('checkpoint_invalid_record');
        }
      }
      let record: unknown;
      try { record = JSON.parse(bytes); }
      catch { throw new Error('checkpoint_invalid_record'); }
      retain(canonical(record as Json)); rawRecords.push(record);
    }
    const records = validateRecordChain(rawRecords, this.plan);
    const resultBytes = new Map<string, string>(), suppliedBindings: CheckpointBindings = {};
    for (const record of records) {
      if (record.binding) suppliedBindings[record.binding.name] = retain(await readSafe(join(this.path, record.binding.file), true));
      if (record.result) resultBytes.set(record.result.resultFile, retain(await readSafe(join(this.path, 'results', record.result.resultFile), true)));
    }
    return validateHistory(this.plan, records, resultBytes, suppliedBindings);
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
    if (record.binding) {
      const path = join(this.path, record.binding.file), bytes = await readSafe(path, true);
      if (sha256(bytes) !== record.binding.sha256) throw new Error('checkpoint_binding_tampered');
      await syncExisting(path, bytes, true);
    }
    if (record.result) {
      const path = join(this.path, 'results', record.result.resultFile), bytes = await readSafe(path, true);
      if (sha256(bytes) !== record.result.reviewSha256) throw new Error('checkpoint_result_tampered');
      await syncExisting(path, bytes, true);
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
    await publishEventExclusive(this.path, eventFile(complete.sequence), `${canonical(complete as unknown as Json)}\n`);
  }
  private cell(cell: string): void { if (!this.plan.cells.some(candidate => candidate.id === cell)) throw new Error('checkpoint_unknown_cell'); }

  /** Bind opaque UTF-8 bytes before work begins. Identical replay re-establishes durability. */
  async bind(name: CheckpointBindingName, bytes: string, ownership: NativeTargetOwnership): Promise<void> {
    const parsed = bindingNameSchema.safeParse(name);
    if (!parsed.success || typeof bytes !== 'string') throw new Error('checkpoint_invalid_binding');
    boundedBytes(bytes);
    if (Buffer.from(bytes, 'utf8').toString('utf8') !== bytes) throw new Error('checkpoint_invalid_binding');
    const binding = { name: parsed.data, file: bindingFile(parsed.data), sha256: sha256(bytes) };
    return this.write(ownership, async () => {
      const { state, bindings } = await this.readValidated();
      const prior = state.records.find(record => record.type === 'binding' && record.binding?.name === binding.name);
      if (prior) {
        if (bindings[binding.name] !== bytes) throw new Error('checkpoint_binding_conflict');
        await this.syncRecord(prior);
        return;
      }
      if (state.finalized) throw new Error('checkpoint_finalized');
      if (state.records.some(record => record.type === 'intent')) throw new Error('checkpoint_binding_closed');
      const path = join(this.path, binding.file);
      try { await writeExclusive(path, bytes); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await readSafe(path, true) !== bytes) throw new Error('checkpoint_binding_conflict');
        await syncExisting(path, bytes, true);
      }
      await this.append({ type: 'binding', binding });
    });
  }

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
        await syncExisting(resultPath, captured.reviewBytes, true);
      }
      await this.append({ type: 'result', cell, paidAttempt: attempt, result: { kind: captured.kind, chunk: captured.chunk, reviewSha256: sha256(captured.reviewBytes), resultFile, ...(captured.kind === 'failure' ? { possiblyBilled: captured.possiblyBilled } : {}) } });
    });
  }

  finalize(ownership: NativeTargetOwnership): Promise<void> {
    return this.write(ownership, async () => {
      const state = await this.read();
      for (const record of state.records) if (record.type === 'binding') await this.syncRecord(record);
      if (state.finalized) { await this.syncRecord(state.records.at(-1)!); return; }
      await this.append({ type: 'finalization', finalizedDigest: sha256(canonical(state.records as unknown as Json)) });
    });
  }
}
