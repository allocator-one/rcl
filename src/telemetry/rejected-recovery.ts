import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReviewResult } from '../consensus/types.js';
import type { RunDetail } from '../evidence/types.js';
import { getRun } from '../evidence/reads.js';
import { buildRunEnvelope, sha256Hex, type ArtifactBytes, type ArtifactKind, type RunEnvelope } from './envelope.js';
import { validateRunEnvelope } from './envelope-validation.js';
import type { Quarantine, QuarantineManifest } from './quarantine.js';
import { readStable } from './recovery/files.js';
import { parseSource } from './recovery/source.js';
import { HarnessSink, type ArtifactReceipt, type RunReceipt, type SinkOutcome } from './sink.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_VERSION = '4.4.7';
const ALGORITHM_VERSION = 1;
const RECOVERY_REASON = 'severity-fallback';

export interface RejectedRecoverySink {
  baseUrl: string;
  checkSeverityFallbackRecovery(): Promise<SinkOutcome<{ protocol: 1; orgId: string }>>;
  getRun(id: string): Promise<SinkOutcome<RunDetail>>;
  postRun(envelope: RunEnvelope): Promise<SinkOutcome<RunReceipt>>;
  putArtifact(runId: string, kind: ArtifactKind, bytes: string): Promise<SinkOutcome<ArtifactReceipt>>;
  getArtifact(runId: string, kind: ArtifactKind, limit: number): Promise<SinkOutcome<{ bytes: Buffer; sha256: string }>>;
}

export function rejectedRecoverySink(sink: HarnessSink): RejectedRecoverySink {
  return {
    baseUrl: sink.baseUrl,
    checkSeverityFallbackRecovery: () => sink.checkSeverityFallbackRecovery(),
    getRun: (id) => getRun(sink, id, { requireCompleteRead: true }),
    postRun: (envelope) => sink.postRun(envelope),
    putArtifact: (runId, kind, bytes) => sink.putArtifact(runId, kind, bytes),
    getArtifact: (runId, kind, limit) => sink.getArtifact(runId, kind, limit),
  };
}

interface SourceSummary {
  run_id: string;
  rcl_version: typeof SOURCE_VERSION;
  requested_mode: 'asserted';
  quarantine_path: string;
  report_sha256: string;
  report_bytes: number;
  markdown_sha256?: string;
  markdown_bytes?: number;
  envelope_sha256: string;
  envelope_bytes: number;
  manifest_sha256: string;
  manifest_bytes: number;
  events_sha256: string;
  events_bytes: number;
  converge: { target: string; round: number; attempt: number };
  reviewer_calls: number;
  blocking_health: Record<string, unknown>;
}

export interface RejectedRecoveryManifest {
  kind: 'rcl-rejected-evidence-recovery';
  version: 1;
  created_at: string;
  destination: { base_url: string; org_id: string; protocol: 1 };
  source: SourceSummary;
  recovery: {
    reason: typeof RECOVERY_REASON;
    algorithm_version: 1;
    cause: 'verification_pass_failed';
    actionable_findings: number;
    total_findings: number;
    recovered_envelope_sha256: string;
    recovered_envelope_bytes: number;
  };
  recovered_envelope: RunEnvelope;
}

export interface RejectedRecoveryOutcome {
  kind: 'rcl-rejected-evidence-recovery-outcome';
  version: 1;
  completed_at: string;
  run_id: string;
  destination: RejectedRecoveryManifest['destination'];
  writes: { run: 'created' | 'existing'; artifacts: Partial<Record<ArtifactKind, 'created' | 'existing'>> };
  readback: {
    report_sha256: string;
    envelope_sha256: string;
    recovered_envelope_sha256: string;
    reviewer_calls: number;
    converge: SourceSummary['converge'];
  };
  effects: { reviewer_calls: 0; attempt_changes: 0; round_changes: 0 };
}

interface PreparedRecovery {
  source: SourceSummary;
  recovery: RejectedRecoveryManifest['recovery'];
  recoveredEnvelope: RunEnvelope;
  artifacts: ArtifactBytes;
}

const hash = z.string().regex(SHA256);
const summarySchema = z.object({
  run_id: z.string().regex(UUID), rcl_version: z.literal(SOURCE_VERSION), requested_mode: z.literal('asserted'),
  quarantine_path: z.string().min(1), report_sha256: hash, report_bytes: z.number().int().nonnegative(),
  markdown_sha256: hash.optional(), markdown_bytes: z.number().int().nonnegative().optional(),
  envelope_sha256: hash, envelope_bytes: z.number().int().nonnegative(),
  manifest_sha256: hash, manifest_bytes: z.number().int().nonnegative(),
  events_sha256: hash, events_bytes: z.number().int().nonnegative(),
  converge: z.object({ target: z.string().min(1), round: z.number().int().positive(), attempt: z.number().int().positive() }).strict(),
  reviewer_calls: z.number().int().nonnegative(), blocking_health: z.record(z.string(), z.unknown()),
}).strict();
const recoverySchema = z.object({
  reason: z.literal(RECOVERY_REASON), algorithm_version: z.literal(1), cause: z.literal('verification_pass_failed'),
  actionable_findings: z.number().int().positive(), total_findings: z.number().int().positive(),
  recovered_envelope_sha256: hash, recovered_envelope_bytes: z.number().int().nonnegative(),
}).strict();
const manifestSchema = z.object({
  kind: z.literal('rcl-rejected-evidence-recovery'), version: z.literal(1), created_at: z.iso.datetime(),
  destination: z.object({ base_url: z.string().url(), org_id: z.string().regex(UUID), protocol: z.literal(1) }).strict(),
  source: summarySchema, recovery: recoverySchema, recovered_envelope: z.unknown(),
}).strict();

function requiredOk<T>(outcome: SinkOutcome<T>, operation: string): T {
  if (outcome.kind === 'ok') return outcome.value;
  throw new Error(`${operation}_${outcome.kind}`);
}

function isMissing(outcome: SinkOutcome<unknown>): boolean {
  return outcome.kind === 'rejected' && outcome.httpStatus === 404 && outcome.error === 'not_found';
}

function sourceDescriptor(source: SourceSummary) {
  return {
    version: 1,
    cause: 'verification_pass_failed',
    source_rcl_version: SOURCE_VERSION,
    source_mode: 'asserted',
    source_report_sha256: source.report_sha256,
    source_envelope_sha256: source.envelope_sha256,
    source_manifest_sha256: source.manifest_sha256,
  } as const;
}

function originalFindings(report: ReviewResult): Array<{ finding: ReviewResult['findings'][number]; below: boolean }> {
  return [
    ...report.findings.map((finding) => ({ finding, below: false })),
    ...(report.belowThresholdFindings ?? []).map((finding) => ({ finding, below: true })),
  ];
}

function assertLegacySource(report: ReviewResult & { run: NonNullable<ReviewResult['run']> }, manifest: QuarantineManifest): void {
  const findings = originalFindings(report);
  const health = report.stats.blockingHealth as unknown as Record<string, unknown> | undefined;
  if (report.run.id.toLowerCase() !== manifest.run_id.toLowerCase() || report.run.rcl_version !== SOURCE_VERSION ||
      report.run.gating?.mode !== 'verified-consensus' || Object.hasOwn(report.stats, 'verification') ||
      health?.['conclusive'] !== true || findings.length === 0 || findings.some(({ finding }) => finding.gating != null)) {
    throw new Error('unsupported_rejected_evidence');
  }
  if (manifest.requested_mode !== 'asserted' || manifest.acknowledged || manifest.envelope === undefined ||
      manifest.diagnostics.length === 0 || manifest.diagnostics.some((diagnostic) =>
        !/^(?:findings|belowThresholdFindings)\.\d+\.gating\.reason$/.test(diagnostic.path) ||
        diagnostic.message !== 'Verified-consensus finding is missing a valid gating label')) {
    throw new Error('unsupported_rejected_evidence');
  }
}

function assertOriginalProjection(report: ReviewResult, artifacts: ArtifactBytes, envelope: RunEnvelope): void {
  if (envelope.findings.length === 0 || envelope.findings.some((finding) => finding.gating_reason !== 'none') ||
      envelope.run.rcl_version !== SOURCE_VERSION || envelope.run.gating?.mode !== 'verified-consensus') {
    throw new Error('source_envelope_mismatch');
  }
  const candidates = [false, true].map((parseFailures) => buildRunEnvelope(report, artifacts, {
    level: 'full', delivery: envelope.delivery, parseFailures,
  }));
  if (!candidates.some((candidate) => isDeepStrictEqual(candidate, envelope))) throw new Error('source_envelope_mismatch');
}

async function prepare(store: Quarantine, runId: string): Promise<PreparedRecovery> {
  const entry = await store.inspect(runId);
  if (!entry || entry.status !== 'complete' || !entry.manifest) throw new Error('rejected_evidence_unavailable');
  const manifest = entry.manifest;
  const reportFile = await readStable(join(entry.path, manifest.artifacts.report_json.file));
  const envelopeFile = await readStable(join(entry.path, manifest.envelope!.file));
  const eventsFile = await readStable(join(entry.path, manifest.events.file));
  const manifestFile = await readStable(join(entry.path, 'manifest.json'), 64_000);
  const reportMd = manifest.artifacts.report_md
    ? await readStable(join(entry.path, manifest.artifacts.report_md.file))
    : undefined;
  let events: unknown;
  let envelope: RunEnvelope;
  let rawReport: ReviewResult & { run: NonNullable<ReviewResult['run']> };
  try {
    events = JSON.parse(eventsFile.text);
    envelope = JSON.parse(envelopeFile.text) as RunEnvelope;
    rawReport = JSON.parse(reportFile.text) as ReviewResult & { run: NonNullable<ReviewResult['run']> };
  } catch { throw new Error('invalid_rejected_evidence'); }
  if (JSON.stringify(envelope) !== envelopeFile.text) throw new Error('noncanonical_source_envelope');
  if (!Array.isArray(events) || events.length !== 0) throw new Error('rejected_evidence_has_events');
  const parsed = parseSource(reportFile.text);
  if (parsed.format !== 'modern' || parsed.unsafe) throw new Error('unsupported_rejected_evidence');
  assertLegacySource(rawReport, manifest);
  const artifacts: ArtifactBytes = { report_json: reportFile.text, ...(reportMd ? { report_md: reportMd.text } : {}) };
  assertOriginalProjection(rawReport, artifacts, envelope);
  const converge = envelope.run.converge;
  if (!converge?.target || !converge.round || !converge.attempt) throw new Error('missing_native_binding');
  const health = rawReport.stats.blockingHealth as unknown as Record<string, unknown>;
  const source: SourceSummary = {
    run_id: runId.toLowerCase(), rcl_version: SOURCE_VERSION, requested_mode: 'asserted', quarantine_path: entry.path,
    report_sha256: reportFile.sha256, report_bytes: reportFile.raw.length,
    ...(reportMd ? { markdown_sha256: reportMd.sha256, markdown_bytes: reportMd.raw.length } : {}),
    envelope_sha256: envelopeFile.sha256, envelope_bytes: envelopeFile.raw.length,
    manifest_sha256: manifestFile.sha256, manifest_bytes: manifestFile.raw.length,
    events_sha256: eventsFile.sha256, events_bytes: eventsFile.raw.length,
    converge: { target: converge.target, round: converge.round, attempt: converge.attempt },
    reviewer_calls: envelope.calls.length, blocking_health: structuredClone(health),
  };
  const recoveredEnvelope = structuredClone(envelope);
  recoveredEnvelope.run.gating = {
    ...(recoveredEnvelope.run.gating ?? {}),
    severity_fallback_recovery: sourceDescriptor(source),
  } as NonNullable<RunEnvelope['run']['gating']>;
  let actionable = 0;
  for (const finding of recoveredEnvelope.findings) {
    const gate = !finding.below_threshold && (finding.severity === 'critical' || finding.severity === 'important');
    finding.gating_reason = gate ? RECOVERY_REASON : 'none';
    if (gate) actionable++;
  }
  if (actionable === 0) throw new Error('recovery_has_no_actionable_findings');
  const diagnostics = validateRunEnvelope(recoveredEnvelope, artifacts);
  if (diagnostics.length > 0) throw new Error('invalid_recovered_envelope');
  const recoveredBytes = JSON.stringify(recoveredEnvelope);
  return {
    source, recoveredEnvelope, artifacts,
    recovery: {
      reason: RECOVERY_REASON, algorithm_version: ALGORITHM_VERSION, cause: 'verification_pass_failed',
      actionable_findings: actionable, total_findings: recoveredEnvelope.findings.length,
      recovered_envelope_sha256: sha256Hex(recoveredBytes), recovered_envelope_bytes: Buffer.byteLength(recoveredBytes),
    },
  };
}

export async function planRejectedEvidenceRecovery(
  store: Quarantine, runId: string, sink: RejectedRecoverySink
): Promise<RejectedRecoveryManifest> {
  if (!UUID.test(runId)) throw new Error('invalid_run_id');
  const capability = requiredOk(await sink.checkSeverityFallbackRecovery(), 'severity_fallback_capability');
  const prepared = await prepare(store, runId);
  return {
    kind: 'rcl-rejected-evidence-recovery', version: 1, created_at: new Date().toISOString(),
    destination: { base_url: sink.baseUrl, org_id: capability.orgId, protocol: 1 },
    source: prepared.source, recovery: prepared.recovery, recovered_envelope: prepared.recoveredEnvelope,
  };
}

function validateManifest(value: unknown): RejectedRecoveryManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) throw new Error('invalid_recovery_manifest');
  return result.data as RejectedRecoveryManifest;
}

function sameManifestPlan(manifest: RejectedRecoveryManifest, prepared: PreparedRecovery): boolean {
  return isDeepStrictEqual(manifest.source, prepared.source) &&
    isDeepStrictEqual(manifest.recovery, prepared.recovery) &&
    isDeepStrictEqual(manifest.recovered_envelope, prepared.recoveredEnvelope);
}

function field(value: unknown): unknown { return value ?? null; }
function sameField(left: unknown, right: unknown): boolean { return isDeepStrictEqual(field(left), field(right)); }

function runMatches(run: RunDetail, envelope: RunEnvelope, requireStored: boolean): boolean {
  const targetKeys = ['kind', 'repo', 'pr_number', 'head_sha', 'base_sha', 'diff_sha256', 'files', 'additions', 'deletions'] as const;
  const runKeys = ['rcl_version', 'command', 'roster', 'config_sha256', 'thresholds', 'gating', 'spec', 'context_files',
    'plan', 'runner', 'started_at', 'finished_at', 'duration_ms', 'ci_exit_code', 'converge'] as const;
  const findingKeys = ['ref', 'identity_key', 'file', 'start_line', 'end_line', 'location_provenance', 'claim_descriptor',
    'severity', 'category', 'title', 'description', 'suggested_fix', 'consensus', 'gating_reason', 'verification_verdict',
    'verification_model', 'verification_note', 'below_threshold'] as const;
  const callKeys = ['model', 'role', 'provider', 'lane', 'chunk_index', 'status', 'duration_ms', 'input_tokens', 'output_tokens',
    'reasoning_tokens', 'dropped_findings', 'warnings', 'error', 'async'] as const;
  const rawRun = run as unknown as Record<string, unknown>;
  const rawEnvelopeRun = envelope.run as unknown as Record<string, unknown>;
  if (run.id.toLowerCase() !== envelope.run.id.toLowerCase() || run.rcl_version !== envelope.run.rcl_version ||
      run.command !== envelope.run.command || runKeys.some(key => !sameField(rawRun[key], rawEnvelopeRun[key])) ||
      !sameField(rawRun['delivery'], envelope.delivery) || !sameField(rawRun['stats'], envelope.stats) ||
      targetKeys.some((key) => !sameField(run.target[key], envelope.run.target[key])) ||
      run.findings.length !== envelope.findings.length || run.calls.length !== envelope.calls.length) return false;
  if (run.findings.some((finding, index) => findingKeys.some((key) =>
    !sameField((finding as unknown as Record<string, unknown>)[key], (envelope.findings[index] as unknown as Record<string, unknown>)[key])))) return false;
  if (run.calls.some((call, index) => callKeys.some((key) =>
    !sameField((call as unknown as Record<string, unknown>)[key], (envelope.calls[index] as unknown as Record<string, unknown>)[key])))) return false;
  const declarations = new Map((run.artifacts ?? []).map((artifact) => [artifact.kind, artifact]));
  return envelope.artifacts_declared.every((expected) => {
    const actual = declarations.get(expected.kind);
    return actual !== undefined && (!requireStored || actual.stored === true) &&
      actual.declared_sha256 === expected.sha256 && actual.declared_bytes === expected.bytes;
  });
}

export async function applyRejectedEvidenceRecovery(
  reviewed: unknown, store: Quarantine, sink: RejectedRecoverySink
): Promise<RejectedRecoveryOutcome> {
  const manifest = validateManifest(reviewed);
  const capability = requiredOk(await sink.checkSeverityFallbackRecovery(), 'severity_fallback_capability');
  if (manifest.destination.base_url !== sink.baseUrl || manifest.destination.org_id !== capability.orgId || manifest.destination.protocol !== capability.protocol) {
    throw new Error('recovery_destination_mismatch');
  }
  const prepared = await prepare(store, manifest.source.run_id);
  if (!sameManifestPlan(manifest, prepared)) throw new Error('recovery_manifest_mismatch');

  let read = await sink.getRun(manifest.source.run_id);
  let runStatus: 'created' | 'existing' = 'existing';
  if (isMissing(read)) {
    const posted = await sink.postRun(prepared.recoveredEnvelope);
    if (posted.kind === 'ok') {
      if (posted.value.id.toLowerCase() !== manifest.source.run_id ||
          new Set(posted.value.artifacts_expected).size !== prepared.recoveredEnvelope.artifacts_declared.length ||
          prepared.recoveredEnvelope.artifacts_declared.some((artifact) => !posted.value.artifacts_expected.includes(artifact.kind))) {
        throw new Error('recovery_run_receipt_mismatch');
      }
      runStatus = posted.value.status;
    } else if (posted.kind === 'unavailable') {
      read = await sink.getRun(manifest.source.run_id);
      if (read.kind !== 'ok' || !runMatches(read.value, prepared.recoveredEnvelope, false)) {
        throw new Error('recovery_run_acknowledgment_unknown');
      }
      runStatus = 'existing';
    } else {
      throw new Error(`recovery_run_${posted.kind}`);
    }
  } else if (read.kind !== 'ok') {
    throw new Error(`recovery_run_read_${read.kind}`);
  } else if (!runMatches(read.value, prepared.recoveredEnvelope, false)) {
    throw new Error('recovery_run_conflict');
  }

  const artifactWrites: Partial<Record<ArtifactKind, 'created' | 'existing'>> = {};
  for (const declaration of prepared.recoveredEnvelope.artifacts_declared) {
    const bytes = prepared.artifacts[declaration.kind];
    if (bytes === undefined) throw new Error('recovery_artifact_missing');
    const uploaded = requiredOk(await sink.putArtifact(manifest.source.run_id, declaration.kind, bytes), `recovery_${declaration.kind}`);
    if (uploaded.sha256 !== declaration.sha256) throw new Error('recovery_artifact_receipt_mismatch');
    artifactWrites[declaration.kind] = uploaded.status;
  }

  read = await sink.getRun(manifest.source.run_id);
  const recorded = requiredOk(read, 'recovery_readback');
  if (!runMatches(recorded, prepared.recoveredEnvelope, true)) throw new Error('recovery_readback_mismatch');
  for (const declaration of prepared.recoveredEnvelope.artifacts_declared) {
    const bytes = prepared.artifacts[declaration.kind]!;
    const original = requiredOk(await sink.getArtifact(manifest.source.run_id, declaration.kind, declaration.bytes), `recovery_${declaration.kind}_readback`);
    if (original.sha256 !== declaration.sha256 || original.bytes.length !== declaration.bytes || !original.bytes.equals(Buffer.from(bytes))) {
      throw new Error('recovery_artifact_readback_mismatch');
    }
  }
  return {
    kind: 'rcl-rejected-evidence-recovery-outcome', version: 1, completed_at: new Date().toISOString(),
    run_id: manifest.source.run_id, destination: manifest.destination,
    writes: { run: runStatus, artifacts: artifactWrites },
    readback: {
      report_sha256: manifest.source.report_sha256, envelope_sha256: manifest.source.envelope_sha256,
      recovered_envelope_sha256: manifest.recovery.recovered_envelope_sha256,
      reviewer_calls: manifest.source.reviewer_calls, converge: manifest.source.converge,
    },
    effects: { reviewer_calls: 0, attempt_changes: 0, round_changes: 0 },
  };
}
