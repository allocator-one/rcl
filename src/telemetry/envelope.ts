import { createHash } from 'node:crypto';
import type { ConsensusFinding, ModelReview, ReviewResult } from '../consensus/types.js';
import { stableFindingKey } from '../consensus/finding-identity.js';
import type { RosterLane, RunHeader } from '../report/run-header.js';
import { scrubDeep, scrubOptional, scrubSecrets, scrubText, stripFencedCode } from './scrub.js';

/**
 * The transport envelope rcl posts to `POST /api/v1/reviews/runs` (epic
 * IO-12475, section 5): the report's own `run` header plus structured
 * findings and calls, the report's `stats`, the digests of the artifacts the
 * client will upload, and how this delivery came about.
 *
 * Pure and allow-listed by construction: the builder receives the report
 * and the artifact bytes, never `process.env`, and every free-text field
 * passes through the scrubber. The `report_json` digest is the SHA-256 of
 * the exact bytes written to `--json-file`; the declaration sits outside
 * those bytes, so there is no self-reference and the server can verify the
 * upload byte for byte.
 */

export type TelemetryLevel = 'off' | 'envelope' | 'findings' | 'full';

export type ArtifactKind = 'report_json' | 'report_md';

export interface ArtifactBytes {
  /** Exactly what `--json-file` receives (or would receive). */
  report_json: string;
  /** Exactly what `--markdown` receives (or would receive). */
  report_md?: string;
}

export interface ArtifactDeclaration {
  kind: ArtifactKind;
  sha256: string;
  bytes: number;
}

export interface DeliveryInfo {
  mode: 'direct' | 'retried';
  spooled_at?: string;
}

export interface WireFinding {
  ref: string;
  identity_key: string;
  file: string;
  start_line: number;
  end_line: number;
  severity: ConsensusFinding['severity'];
  category: ConsensusFinding['category'];
  title: string;
  description: string;
  suggested_fix?: string;
  consensus: ConsensusFinding['consensus'];
  gating_reason: 'consensus' | 'critical' | 'verified' | 'none';
  verification_verdict?: string;
  below_threshold: boolean;
}

export interface WireCall {
  model: string;
  role: string;
  provider: string;
  lane: RosterLane;
  chunk_index: number;
  status: ModelReview['status'];
  duration_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  dropped_findings: number;
  warnings: string[];
  error?: string;
  async: boolean;
}

export interface RunEnvelope {
  run: RunHeader;
  findings: WireFinding[];
  calls: WireCall[];
  stats: ReviewResult['stats'];
  artifacts_declared: ArtifactDeclaration[];
  delivery: DeliveryInfo;
}

export interface EnvelopeOptions {
  level: Exclude<TelemetryLevel, 'off'>;
  delivery: DeliveryInfo;
  /**
   * Send a `parse_failed` call's raw model answer (fenced code and key-shaped
   * strings removed, 32 KB cap). Off by default: a malformed answer can echo
   * the prompt, and the prompt contains the diff.
   */
  parseFailures?: boolean;
}

/** Wire limits mirrored from the server (section 7 "Limits"). */
export const MAX_WARNINGS_PER_CALL = 50;
export const MAX_PARSE_FAILURE_BYTES = 32_000;
const MAX_PARSER_ERROR_SUMMARY = 500;

export function sha256Hex(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

export function declareArtifacts(artifacts: ArtifactBytes): ArtifactDeclaration[] {
  const declared: ArtifactDeclaration[] = [
    { kind: 'report_json', sha256: sha256Hex(artifacts.report_json), bytes: Buffer.byteLength(artifacts.report_json, 'utf8') },
  ];
  if (artifacts.report_md !== undefined) {
    declared.push({
      kind: 'report_md',
      sha256: sha256Hex(artifacts.report_md),
      bytes: Buffer.byteLength(artifacts.report_md, 'utf8'),
    });
  }
  return declared;
}

function findingRef(index: number): string {
  return `f${String(index + 1).padStart(3, '0')}`;
}

function wireFinding(finding: ConsensusFinding, index: number, belowThreshold: boolean): WireFinding {
  const identity = finding.identity ?? stableFindingKey(finding);
  return {
    ref: findingRef(index),
    identity_key: identity,
    file: scrubText(finding.file),
    start_line: finding.startLine,
    end_line: finding.endLine,
    severity: finding.severity,
    category: finding.category,
    title: scrubText(finding.title, 500),
    description: scrubText(finding.description),
    ...(finding.suggestedFix !== undefined ? { suggested_fix: scrubText(finding.suggestedFix) } : {}),
    consensus: scrubDeep(finding.consensus),
    gating_reason: finding.gating?.reason ?? 'none',
    ...(finding.gating?.verification?.verdict !== undefined
      ? { verification_verdict: scrubText(finding.gating.verification.verdict) }
      : {}),
    below_threshold: belowThreshold,
  };
}

/**
 * A `parse_failed` call's error text defaults to the parser's own message
 * — its first line, scrubbed — because the rest may be the model's raw
 * answer echoing the prompt. Opting in sends that answer with fenced code
 * removed, scrubbed and capped.
 */
function callError(review: ModelReview, parseFailures: boolean): string | undefined {
  if (review.error === undefined) return undefined;
  if (review.status !== 'parse_failed') return scrubText(review.error);
  if (parseFailures) return scrubText(stripFencedCode(review.error), MAX_PARSE_FAILURE_BYTES);
  const firstLine = review.error.split(/\r?\n/, 1)[0] ?? '';
  return scrubText(firstLine, MAX_PARSER_ERROR_SUMMARY);
}

function laneFor(review: ModelReview, run: RunHeader): RosterLane {
  const seat = run.roster.find((entry) => entry.model === review.model && entry.role === review.role);
  if (seat) return seat.lane;
  return review.async ? 'async' : 'blocking';
}

function wireCall(review: ModelReview, run: RunHeader, parseFailures: boolean): WireCall {
  const error = callError(review, parseFailures);
  return {
    model: review.model,
    role: review.role,
    provider: review.provider,
    lane: laneFor(review, run),
    // Chunks are merged before the report is written; one call row stands
    // for a reviewer's work on the whole diff.
    chunk_index: 0,
    status: review.status,
    duration_ms: Math.max(0, Math.round(review.durationMs)),
    ...(review.usage?.inputTokens !== undefined ? { input_tokens: review.usage.inputTokens } : {}),
    ...(review.usage?.outputTokens !== undefined ? { output_tokens: review.usage.outputTokens } : {}),
    ...(review.usage?.reasoningTokens !== undefined ? { reasoning_tokens: review.usage.reasoningTokens } : {}),
    dropped_findings: review.droppedFindings ?? 0,
    warnings: (review.warnings ?? []).slice(0, MAX_WARNINGS_PER_CALL).map((w) => scrubText(w)),
    ...(error !== undefined ? { error } : {}),
    async: review.async === true,
  };
}

/**
 * Build the envelope for a finished review. Requires the self-describing
 * header (`result.run`, rcl ≥ 3.0). `envelope` level sends the header,
 * stats and declarations only; `findings` and `full` add findings and calls
 * (artifacts are uploaded separately, only at `full`).
 */
export function buildRunEnvelope(
  result: ReviewResult,
  artifacts: ArtifactBytes,
  options: EnvelopeOptions
): RunEnvelope {
  if (!result.run) {
    throw new Error('A report without a run header cannot be delivered as evidence (rcl < 3.0 report).');
  }
  const run: RunHeader = scrubRunHeader(result.run);
  const includeRows = options.level !== 'envelope';
  const parseFailures = options.parseFailures === true;

  const kept = result.findings.map((f, i) => wireFinding(f, i, false));
  const below = (result.belowThresholdFindings ?? []).map((f, i) => wireFinding(f, kept.length + i, true));

  return {
    run,
    findings: includeRows ? [...kept, ...below] : [],
    calls: includeRows ? result.reviews.map((review) => wireCall(review, run, parseFailures)) : [],
    stats: result.stats,
    artifacts_declared: declareArtifacts(artifacts),
    delivery: options.delivery,
  };
}

/**
 * The report as it may leave the machine: every free-text field scrubbed
 * and a `parse_failed` call's error reduced to the parser message unless
 * `parseFailures` opts in (fenced code removed, capped). The artifacts are
 * rendered from this view — and written to `--json-file` / `--markdown`
 * from it too — so what the server stores is exactly what was written, and
 * neither contains a raw model answer or a key quoted from the diff.
 */
export function sanitizeForDelivery(result: ReviewResult, options: { parseFailures?: boolean } = {}): ReviewResult {
  const parseFailures = options.parseFailures === true;
  const finding = (f: ConsensusFinding): ConsensusFinding => ({
    ...f,
    file: scrubText(f.file),
    title: scrubText(f.title, 500),
    description: scrubText(f.description),
    ...(f.suggestedFix !== undefined ? { suggestedFix: scrubText(f.suggestedFix) } : {}),
    consensus: scrubDeep(f.consensus),
  });
  const review = (r: ModelReview): ModelReview => {
    const error = callError(r, parseFailures);
    const { error: _dropped, ...rest } = r;
    return {
      ...rest,
      findings: r.findings.map((f) => ({
        ...f,
        file: scrubText(f.file),
        title: scrubText(f.title, 500),
        description: scrubText(f.description),
        ...(f.suggestedFix !== undefined ? { suggestedFix: scrubText(f.suggestedFix) } : {}),
      })),
      ...(r.warnings ? { warnings: r.warnings.map((w) => scrubText(w)) } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  };
  return {
    ...result,
    ...(result.run ? { run: scrubRunHeader(result.run) } : {}),
    reviews: result.reviews.map(review),
    findings: result.findings.map(finding),
    ...(result.belowThresholdFindings ? { belowThresholdFindings: result.belowThresholdFindings.map(finding) } : {}),
  };
}

/**
 * The header is allow-listed when built, but every string in it — target
 * URLs and refs, roster values, context-file paths, runner claims — came
 * from the environment or the repository, so all of them pass the scrubber
 * (hex digests and UUIDs survive it); the runner claims are capped as well.
 */
function scrubRunHeader(run: RunHeader): RunHeader {
  const scrubbed = scrubDeep(run);
  return {
    ...scrubbed,
    runner: {
      ...scrubbed.runner,
      ...(run.runner.agent !== undefined ? { agent: scrubText(run.runner.agent, 200) } : {}),
      ...(run.runner.host !== undefined ? { host: scrubText(run.runner.host, 64) } : {}),
      ...(run.runner.ci_run_id !== undefined ? { ci_run_id: scrubSecrets(run.runner.ci_run_id).slice(0, 200) } : {}),
    },
  };
}

export { scrubOptional };
