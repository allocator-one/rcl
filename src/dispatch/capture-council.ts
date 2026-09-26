import type { CapturedAggregationInputs } from '../report/aggregation-inputs.js';
import type { Config } from '../config/schema.js';
import { formatChunkForPrompt, chunkDiff, type Chunk } from '../prepare/chunker.js';
import type { ContextDoc, BuiltPrompt } from '../prepare/prompt-builder.js';
import { DIGESTED_CONFIG_FIELDS, configDigest, diffDigest, sha256Hex, stableStringify } from '../report/run-header.js';
import type { Diff } from '../resolver/types.js';
import type { ReviewAssignment } from '../roles/types.js';
import {
  captureReviewerInputs,
  decodeCapturedInputs,
  type CapturedReviewerInputs,
} from './captured-inputs.js';
import { freezeCheckpointPlan, type FrozenCheckpointPlan } from './checkpoint.js';

export interface CouncilCompatibility {
  parser: { name: string; version: number };
  aggregation: { name: string; version: number };
}
export interface CapturePreparedCouncilInput {
  target: string;
  headSha: string;
  mergeBaseSha: string;
  /** Observed upstream base tip is informational; effective mergeBaseSha is the binding. */
  baseTip?: string;
  diff: Diff;
  assignments: readonly ReviewAssignment[];
  chunks: readonly Chunk[];
  prompts: readonly BuiltPrompt[];
  /** Resolved config. This factory persists only the existing digest allow-list. */
  config: Config;
  /** Exact bytes already read by the caller; this factory never re-reads it. */
  specBytes: string;
  /** Exact documents already read by the caller; this factory never re-reads them. */
  contextDocs: readonly ContextDoc[];
  compatibility: CouncilCompatibility;
  aggregationInputs?: CapturedAggregationInputs;
  /** Actual prepared chunk-major first-eight async calls, separate from blocking seats. */
  async?: { assignments: readonly ReviewAssignment[]; prompts: readonly BuiltPrompt[];
    timeoutMs: number; maxAttemptsPerCall: number; maxPhysicalCalls: number };
}
export interface CapturedPreparedCouncil {
  plan: FrozenCheckpointPlan;
  captured: CapturedReviewerInputs;
  patchBytes: string;
  configBytes: string;
  aggregation: CouncilCompatibility['aggregation'];
  /** Missing static input snapshots remain explicit and cannot enter proof-aware assembly. */
  aggregationRequirement: 'captured' | 'freeze_actual_aggregation_inputs_before_report_construction';
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonicalPatchBytes(diff: Diff): string {
  return stableStringify([...diff.files].sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0).map(file => ({
    filename: file.filename,
    status: file.status,
    previousFilename: file.previousFilename ?? null,
    patch: file.patch,
    additions: file.additions,
    deletions: file.deletions,
    blobSha: file.blobSha ?? null,
  })));
}
function canonicalConfigBytes(config: Config): string {
  const projection: Record<string, unknown> = {};
  for (const key of DIGESTED_CONFIG_FIELDS) if (config[key] !== undefined) projection[key] = config[key];
  return stableStringify(projection);
}
function sameChunks(left: readonly Chunk[], right: readonly Chunk[]): boolean {
  return left.length === right.length && left.every((chunk, index) => formatChunkForPrompt(chunk) === formatChunkForPrompt(right[index]!));
}

/**
 * Captures only already-prepared council inputs. It validates chunk preparation
 * against the supplied diff but never reads files or builds replacement prompts.
 */
export function capturePreparedCouncil(input: CapturePreparedCouncilInput): CapturedPreparedCouncil {
  if (!input.assignments.length || input.chunks.length === 0) throw new Error('capture_council_empty_matrix');
  const regeneratedChunks = chunkDiff(input.diff.files);
  if (!sameChunks(input.chunks, regeneratedChunks)) throw new Error('capture_council_chunk_source_mismatch');
  const expectedCalls = input.chunks.length * input.assignments.length;
  if (input.prompts.length !== expectedCalls) throw new Error('capture_council_incomplete_matrix');
  const patchBytes = canonicalPatchBytes(input.diff);
  if (sha256Hex(patchBytes) !== diffDigest(input.diff.files)) throw new Error('capture_council_diff_digest_mismatch');
  const configBytes = canonicalConfigBytes(input.config);
  if (sha256Hex(configBytes) !== configDigest(input.config)) throw new Error('capture_council_config_digest_mismatch');
  const contextBytes = stableStringify(input.contextDocs);
  const toolsBytes = stableStringify(input.compatibility);
  const chunkBytes = input.chunks.map(formatChunkForPrompt);
  const roster = input.assignments.map((assignment, index) => ({
    seat: `assignment:${index}`,
    model: assignment.model,
    role: assignment.role.name,
    route: assignment.provider,
  }));
  const plan = freezeCheckpointPlan({
    target: input.target,
    headSha: input.headSha,
    mergeBaseSha: input.mergeBaseSha,
    patchSha256: sha256Hex(patchBytes),
    configSha256: sha256Hex(configBytes),
    specSha256: sha256Hex(input.specBytes),
    contextSha256: sha256Hex(contextBytes),
    toolsSha256: sha256Hex(toolsBytes),
    parser: input.compatibility.parser,
    roster,
    chunks: input.chunks.map((chunk, index) => ({ index, total: input.chunks.length, digest: sha256Hex(chunkBytes[index]!) })),
    prompts: input.chunks.flatMap((_, chunk) => input.assignments.map((_, seat) => {
      const prompt = input.prompts[chunk * input.assignments.length + seat]!;
      return { seat: `assignment:${seat}`, chunk, systemSha256: sha256Hex(prompt.systemPrompt), userSha256: sha256Hex(prompt.userPrompt) };
    })),
  });
  const assignments = input.chunks.flatMap(() => input.assignments.map(assignment => ({
    model: assignment.model, provider: assignment.provider, role: assignment.role,
  })));
  const asyncCalls = input.async === undefined ? undefined : input.chunks.flatMap((_, chunk) =>
    input.async!.assignments.map((assignment, index) => ({ assignmentId: `async-assignment:${index}`, chunk, assignment }))).slice(0, 8);
  if (input.async && (asyncCalls!.length === 0 || input.async.prompts.length !== asyncCalls!.length)) {
    throw new Error('capture_council_incomplete_async_matrix');
  }
  const captured = captureReviewerInputs({
    plan,
    policy: { version: 1, fraction: input.config.quorumFraction ?? 2 / 3 },
    patchBytes,
    configBytes,
    specBytes: input.specBytes,
    contextBytes,
    toolsBytes,
    chunkBytes,
    assignments,
    prompts: [...input.prompts],
    ...(input.async === undefined ? {} : { async: { timeoutMs: input.async.timeoutMs,
      maxAttemptsPerCall: input.async.maxAttemptsPerCall, maxPhysicalCalls: input.async.maxPhysicalCalls,
      calls: asyncCalls!.map((call, index) => ({ ...call, prompt: input.async!.prompts[index]! })) } }),
    ...(input.aggregationInputs !== undefined ? { aggregation: input.aggregationInputs } : {}),
  });
  const decoded = decodeCapturedInputs(captured.bytes, plan);
  return freeze({
    plan,
    captured: decoded,
    patchBytes,
    configBytes,
    aggregation: { ...input.compatibility.aggregation },
    aggregationRequirement: input.aggregationInputs ? 'captured' as const : 'freeze_actual_aggregation_inputs_before_report_construction' as const,
  });
}
