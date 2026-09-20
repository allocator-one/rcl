import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { getRun } from '../../evidence/reads.js';
import type { RunDetail } from '../../evidence/types.js';
import { UUID_NAMESPACE_RCL_BACKFILL, uuidv5 } from '../../report/uuid.js';
import { buildLegacyReport } from '../backfill.js';
import { buildRunEnvelope, type RunEnvelope } from '../envelope.js';
import { normalizeVerificationEvidence } from '../verification.js';
import { scrubDeep } from '../scrub.js';
import type { HarnessSink, SinkOutcome } from '../sink.js';
import { beneath, gitMetadata, reportReferences, repositoryFromRemote } from './discovery.js';
import { hasSyntheticAncestor, readStable } from './files.js';
import { parseSource, SHA256, UUID } from './source.js';
import type { RecoveryInventory, RecoveryManifest, RecoveryOutcome, RecoveryPlan, RecoverySource } from './types.js';

const hash = z.string().regex(SHA256);
const uuid = z.string().regex(UUID);
const proof = z.object({ worktree: z.string(), repo: z.string(), reference_path: z.string().optional(), reference_sha256: hash.optional() });
const finding = z.object({ ref: z.string(), identity: z.string().nullable(), model: z.string().nullable(), note: z.string().nullable() });
const plan = z.object({
  sha256: hash, run_id: uuid.nullable(),
  action: z.enum(['import_history', 'upload_and_recover', 'recover', 'already_present', 'skip', 'conflict', 'unavailable']),
  reason: z.string().optional(),
  delivery: z.object({ report_sha256: hash, report_bytes: z.number().int().nonnegative() }).optional(),
  server: z.object({ exists: z.boolean(), provenance: z.enum(['live', 'backfill']).nullable(), artifact_stored: z.boolean(), report_sha256: hash.nullable(), report_bytes: z.number().int().nonnegative().nullable() }).optional(),
  findings: z.array(finding.extend({ state: z.enum(['missing', 'already_present', 'original_note_absent', 'conflict']) })).max(2000),
});
const source = z.object({
  sha256: hash, bytes: z.number().int().nonnegative(), paths: z.array(z.string()).min(1), mtime: z.string(),
  format: z.enum(['modern', 'legacy', 'unknown']), run_id: uuid.nullable(), repo: z.string().nullable(), target: z.record(z.string(), z.unknown()).nullable(),
  repository_proofs: z.array(proof),
  state: z.enum(['ready', 'no_refutations', 'synthetic', 'unbound', 'unsafe', 'conflict', 'unsupported']),
  reason: z.string().optional(), refutations: z.array(finding).max(2000),
});
const manifestSchema = z.object({
  kind: z.literal('rcl-refutation-recovery'), version: z.literal(1), created_at: z.string(),
  destination: z.object({ base_url: z.string(), org_id: uuid }),
  inventory: z.object({
    kind: z.literal('rcl-refutation-inventory'), version: z.literal(1), created_at: z.string(),
    coverage: z.object({
      roots: z.array(z.string()), worktrees: z.array(proof), git_common_dirs: z.array(z.string()), references: z.array(z.string()),
      issues: z.array(z.object({ path: z.string(), reason: z.string() })), excluded_sha256: z.array(hash),
      outbox: z.array(z.object({ path: z.string(), sha256: hash, run_id: uuid.nullable(), report_sha256: hash.nullable(), report_path: z.string() })),
    }),
    reports: z.array(source),
  }),
  plans: z.array(plan),
});

/** A discovery artifact has no reviewed destination and must never authorize writes. */
export function validateRecoveryManifest(value: unknown): RecoveryManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid_recovery_manifest');
  const manifest = parsed.data as RecoveryManifest;
  const hashes = new Set(manifest.inventory.reports.map((s) => s.sha256));
  if (hashes.size !== manifest.inventory.reports.length || manifest.plans.length !== hashes.size ||
      new Set(manifest.plans.map((p) => p.sha256)).size !== hashes.size || manifest.plans.some((p) => !hashes.has(p.sha256))) {
    throw new Error('invalid_recovery_selection');
  }
  return manifest;
}

/** Server-owned organization metadata is required even when the organization has no runs. */
export async function recoveryDestination(sink: HarnessSink): Promise<RecoveryManifest['destination']> {
  const result = await sink.getJson('/api/v1/reviews/runs?page_size=1', (data, meta) => {
    const org = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['org_id'] : null;
    return Array.isArray(data) && typeof org === 'string' && UUID.test(org) ? org.toLowerCase() : null;
  });
  if (result.kind !== 'ok') throw new Error(`recovery_destination_unavailable:${result.kind}`);
  return { base_url: sink.baseUrl, org_id: result.value };
}

interface Prepared {
  envelope: RunEnvelope;
  originalId: string | null;
  artifact: string;
  findings: RecoverySource['refutations'];
  unsafeArtifact: boolean;
}
interface Assessment {
  plan: RecoveryPlan;
  prepared?: Prepared;
  recorded?: RunDetail;
}

function disposition(source: RecoverySource, action: RecoveryPlan['action'], reason?: string, runId = source.run_id): RecoveryPlan {
  return {
    sha256: source.sha256, run_id: runId, action, ...(reason ? { reason } : {}),
    findings: source.refutations.map((f) => ({ ...f, state: f.note === null ? 'original_note_absent' : 'missing' })),
  };
}

async function prepare(source: RecoverySource, destination: RecoveryManifest['destination']): Promise<Prepared> {
  const syntheticAncestors = new Map<string, boolean>();
  for (const path of source.paths) if (await hasSyntheticAncestor(path, syntheticAncestors)) throw new Error('source_marked_synthetic');
  let retained: Awaited<ReturnType<typeof readStable>> | undefined;
  for (const path of source.paths) {
    try {
      const candidate = await readStable(path);
      if (candidate.sha256 === source.sha256 && candidate.raw.length === source.bytes) { retained = candidate; break; }
    } catch { /* A verified retained alias can replace an unavailable location. */ }
  }
  if (!retained) throw new Error('source_missing_or_changed');
  const parsed = parseSource(retained.text);
  if (parsed.format !== source.format || !isDeepStrictEqual(parsed.refutations, source.refutations)) throw new Error('source_manifest_mismatch');
  if (parsed.format === 'modern') {
    const target = scrubDeep(parsed.report.run.target);
    if (parsed.report.run.id !== source.run_id || (target.repo ?? null) !== source.repo ||
        !isDeepStrictEqual(target, source.target)) throw new Error('source_manifest_mismatch');
    // A historical import never borrows a live run id or replays its events.
    const id = uuidv5(`refutations|${destination.base_url}|${destination.org_id}|${source.run_id}|${source.sha256}`, UUID_NAMESPACE_RCL_BACKFILL);
    const envelope = buildRunEnvelope(parsed.report, { report_json: retained.text }, { level: 'full', delivery: { mode: 'direct' } });
    const originalFindings = [...parsed.report.findings, ...(parsed.report.belowThresholdFindings ?? [])];
    if (TARGET_BINDINGS.some((key) => value(envelope.run.target[key]) !== value(parsed.report.run.target[key])) ||
        originalFindings.some((f, i) => envelope.findings[i]!.file !== f.file || envelope.findings[i]!.category !== f.category ||
          value(envelope.findings[i]!.verification_verdict) !== value(f.gating?.verification?.verdict))) {
      throw new Error('source_binding_requires_transformation');
    }
    envelope.run = { ...envelope.run, id, provenance: 'backfill', historical_source: { original_run_id: source.run_id!, report_sha256: source.sha256 } };
    return { envelope, originalId: source.run_id, artifact: retained.text, findings: parsed.refutations, unsafeArtifact: parsed.unsafe };
  }
  if (!source.repo || source.repository_proofs.length === 0) throw new Error('repository_not_proven');
  const repos = new Set<string>();
  for (const proof of source.repository_proofs) {
    try {
      const repo = repositoryFromRemote(await gitMetadata(proof.worktree, ['config', '--get', 'remote.origin.url']));
      if (!repo || repo.toLowerCase() !== proof.repo.toLowerCase()) throw new Error();
      if (proof.reference_path) {
        if (!beneath(proof.reference_path, proof.worktree)) throw new Error();
        const reference = await readStable(proof.reference_path, 2 * 1024 * 1024);
        if (reference.sha256 !== proof.reference_sha256 || !reportReferences(reference.text, proof.reference_path).some((p) => source.paths.includes(p))) throw new Error();
      } else if (!source.paths.some((path) => beneath(path, proof.worktree))) throw new Error();
      repos.add(repo.toLowerCase());
    } catch { throw new Error('repository_proof_changed'); }
  }
  if (repos.size !== 1 || !repos.has(source.repo.toLowerCase())) throw new Error('ambiguous_repository');
  const built = buildLegacyReport({ bytes: retained.text, mtime: new Date(source.mtime), repo: source.repo, host: new URL(destination.base_url).host });
  // The established legacy scrubber may transform artifact bytes. If escaped
  // values still need redaction afterwards, keep this source unresolved.
  if (parseSource(built.artifacts.report_json).unsafe) throw new Error('original_artifact_requires_redaction');
  // Legacy identities and declared digests deliberately follow the original
  // importer: identity uses original bytes, delivery uses scrubbed bytes.
  return { envelope: built.envelope, originalId: null, artifact: built.artifacts.report_json, findings: parsed.refutations, unsafeArtifact: false };
}

const value = (v: unknown): unknown => v ?? null;
const TARGET_BINDINGS = ['kind', 'repo', 'pr_number', 'head_sha', 'base_sha', 'diff_sha256'] as const;
const FINDING_BINDINGS = ['ref', 'identity_key', 'file', 'category', 'start_line', 'end_line', 'severity', 'below_threshold', 'verification_verdict', 'gating_reason'] as const;

/** All source positions must match, including non-refuted and below-threshold findings. */
function boundToSource(recorded: RunDetail, prepared: Prepared): boolean {
  const expected = prepared.envelope;
  const historical = recorded.id === expected.run.id;
  if (recorded.id !== (historical ? expected.run.id : prepared.originalId) ||
      recorded.command !== expected.run.command || recorded.rcl_version !== expected.run.rcl_version ||
      TARGET_BINDINGS.some((key) => value(recorded.target[key]) !== value(expected.run.target[key]))) return false;
  if (historical) {
    if (recorded.provenance !== 'backfill' || !isDeepStrictEqual(value(recorded.historical_source), value(expected.run.historical_source))) return false;
    if (prepared.originalId === null && recorded.runner?.['agent'] !== 'rcl telemetry backfill') return false;
  } else if (recorded.historical_source != null) return false;
  const declarations = recorded.artifacts?.filter((a) => a.kind === 'report_json') ?? [];
  const declared = expected.artifacts_declared.find((a) => a.kind === 'report_json')!;
  if (declarations.length !== 1 || declarations[0]!.declared_sha256 !== declared.sha256 || declarations[0]!.declared_bytes !== declared.bytes) return false;
  if (recorded.findings.length !== expected.findings.length) return false;
  const rows = new Map(recorded.findings.map((f) => [f.ref, f]));
  return rows.size === recorded.findings.length && expected.findings.every((f) => {
    const stored = rows.get(f.ref);
    return stored !== undefined && FINDING_BINDINGS.every((key) => value(stored[key]) === value(f[key]));
  });
}

function classifyRecorded(source: RecoverySource, prepared: Prepared, recorded: RunDetail): RecoveryPlan {
  if (!boundToSource(recorded, prepared)) return disposition(source, 'conflict', 'server_source_binding_conflict', recorded.id);
  const findings: RecoveryPlan['findings'] = prepared.findings.map((original) => {
    const stored = recorded.findings.find((f) => f.ref === original.ref)!;
    const normalized = normalizeVerificationEvidence({ verdict: stored.verification_verdict, model: stored.verification_model, note: stored.verification_note });
    const conflict = (original.note !== null && normalized.note !== undefined && original.note !== normalized.note) ||
      (original.model !== null && normalized.model !== undefined && original.model !== normalized.model) ||
      (stored.verification_provenance?.source === 'report_json' && stored.verification_provenance.report_sha256 !== prepared.envelope.artifacts_declared[0]!.sha256);
    const missing = (original.note !== null && normalized.note === undefined) || (original.model !== null && normalized.model === undefined);
    return { ...original, state: conflict ? 'conflict' : missing ? 'missing' : original.note === null ? 'original_note_absent' : 'already_present' };
  });
  const storedArtifact = recorded.artifacts!.find((a) => a.kind === 'report_json')!.stored;
  const conflict = findings.some((f) => f.state === 'conflict');
  const missing = findings.some((f) => f.state === 'missing');
  const artifactRequired = missing || recorded.provenance === 'backfill';
  if (!storedArtifact && artifactRequired && prepared.unsafeArtifact) return disposition(source, 'conflict', 'original_artifact_requires_redaction', recorded.id);
  // Native evidence already present is complete even when the optional original
  // report artifact was never retained. Only missing evidence needs delivery.
  const action = conflict ? 'conflict' : artifactRequired && !storedArtifact ? 'upload_and_recover' : missing ? 'recover' : 'already_present';
  return { sha256: source.sha256, run_id: recorded.id, action, ...(conflict ? { reason: 'recorded_evidence_conflict' } : {}), findings };
}

function readFailure(source: RecoverySource, result: SinkOutcome<unknown>, id: string): Assessment {
  return { plan: disposition(source, result.kind === 'conflict' ? 'conflict' : 'unavailable', `server_read_${result.kind}`, id) };
}
const absent = (result: SinkOutcome<unknown>): boolean => result.kind === 'rejected' && result.httpStatus === 404;

function withServerState(plan: RecoveryPlan, prepared: Prepared, recorded?: RunDetail): Assessment {
  const declared = prepared.envelope.artifacts_declared.find((a) => a.kind === 'report_json')!;
  const artifact = recorded?.artifacts?.find((a) => a.kind === 'report_json');
  return { prepared, ...(recorded ? { recorded } : {}), plan: { ...plan,
    delivery: { report_sha256: declared.sha256, report_bytes: declared.bytes },
    server: {
      exists: recorded !== undefined,
      provenance: recorded?.provenance === 'live' || recorded?.provenance === 'backfill' ? recorded.provenance : null,
      artifact_stored: artifact?.stored === true,
      report_sha256: typeof artifact?.declared_sha256 === 'string' && SHA256.test(artifact.declared_sha256) ? artifact.declared_sha256 : null,
      report_bytes: typeof artifact?.declared_bytes === 'number' && Number.isSafeInteger(artifact.declared_bytes) && artifact.declared_bytes >= 0 ? artifact.declared_bytes : null,
    },
  } };
}

async function assess(source: RecoverySource, sink: HarnessSink, destination: RecoveryManifest['destination']): Promise<Assessment> {
  if (!['ready', 'unsafe'].includes(source.state)) return { plan: disposition(source, source.state === 'conflict' ? 'conflict' : 'skip', source.reason ?? source.state) };
  let prepared: Prepared;
  try { prepared = await prepare(source, destination); }
  catch (error) {
    const known = new Set(['source_marked_synthetic', 'source_missing_or_changed', 'source_manifest_mismatch', 'source_binding_requires_transformation', 'repository_not_proven', 'repository_proof_changed', 'ambiguous_repository', 'original_artifact_requires_redaction', 'unsupported_report', 'unsupported_identity_version', 'invalid_legacy_duration', 'invalid_legacy_mtime']);
    return { plan: disposition(source, 'conflict', error instanceof Error && known.has(error.message) ? error.message : 'unusable_source') };
  }
  if (Buffer.byteLength(JSON.stringify(prepared.envelope)) > 2_000_000) return { plan: disposition(source, 'conflict', 'envelope_too_large') };
  if (prepared.originalId) {
    const original = await getRun(sink, prepared.originalId);
    if (original.kind === 'ok') return withServerState(classifyRecorded(source, prepared, original.value), prepared, original.value);
    if (!absent(original)) return readFailure(source, original, prepared.originalId);
  }
  const history = await getRun(sink, prepared.envelope.run.id);
  if (history.kind === 'ok') return withServerState(classifyRecorded(source, prepared, history.value), prepared, history.value);
  if (!absent(history)) return readFailure(source, history, prepared.envelope.run.id);
  if (prepared.unsafeArtifact) return { plan: disposition(source, 'skip', 'original_artifact_requires_redaction') };
  return withServerState(disposition(source, 'import_history', undefined, prepared.envelope.run.id), prepared);
}

/** GET-only classification. No outbox, ledger events, model calls or gate mutations. */
export async function planRecovery(inventory: RecoveryInventory, sink: HarnessSink): Promise<RecoveryManifest> {
  const destination = await recoveryDestination(sink);
  const plans: RecoveryPlan[] = [];
  for (const source of inventory.reports) plans.push((await assess(source, sink, destination)).plan);
  return { kind: 'rcl-refutation-recovery', version: 1, created_at: new Date().toISOString(), destination, inventory, plans };
}

async function requireDestination(sink: HarnessSink, expected: RecoveryManifest['destination']): Promise<void> {
  if (sink.baseUrl !== expected.base_url || !isDeepStrictEqual(await recoveryDestination(sink), expected)) {
    throw new Error('recovery_destination_or_organization_changed');
  }
}

/** Apply only reviewed selections, reconstructing payloads from retained original bytes. */
export async function applyRecovery(value: unknown, sink: HarnessSink): Promise<RecoveryOutcome> {
  const manifest = validateRecoveryManifest(value);
  await requireDestination(sink, manifest.destination);
  const outcome: RecoveryOutcome = {
    kind: 'rcl-refutation-recovery-outcome', version: 1, created_at: new Date().toISOString(), destination: manifest.destination,
    writes: { runs: 0, artifacts: 0 }, server_recovery_run_ids: [], reports: [],
  };
  const writable = new Set(['import_history', 'upload_and_recover', 'recover', 'already_present']);
  for (const selected of manifest.plans) {
    const source = manifest.inventory.reports.find((s) => s.sha256 === selected.sha256)!;
    if (!writable.has(selected.action) || manifest.inventory.coverage.excluded_sha256.includes(source.sha256)) {
      outcome.reports.push(selected); continue;
    }
    let current = await assess(source, sink, manifest.destination);
    const prepared = current.prepared;
    if (!prepared || !writable.has(current.plan.action)) { outcome.reports.push(current.plan); continue; }
    if (current.plan.action === 'import_history' && selected.action !== 'import_history') {
      outcome.reports.push(disposition(source, 'conflict', 'reviewed_run_disappeared', selected.run_id)); continue;
    }
    if (current.plan.run_id !== selected.run_id) {
      outcome.reports.push(disposition(source, 'conflict', 'reviewed_run_binding_changed', current.plan.run_id)); continue;
    }
    if (current.plan.action === 'upload_and_recover' && !['import_history', 'upload_and_recover'].includes(selected.action)) {
      outcome.reports.push(disposition(source, 'conflict', 'reviewed_action_changed', current.plan.run_id)); continue;
    }
    if (current.plan.action === 'import_history') {
      await requireDestination(sink, manifest.destination);
      const posted = await sink.postRun(prepared.envelope);
      if (posted.kind === 'ok' && posted.value.status === 'created') outcome.writes.runs++;
      // A lost receipt can still have stored the run. Read its exact binding
      // before resuming; a subsequent apply has the same deterministic id.
      current = await assess(source, sink, manifest.destination);
      if (current.plan.action === 'import_history') {
        outcome.reports.push(disposition(source, 'unavailable', `run_delivery_${posted.kind}`, prepared.envelope.run.id)); continue;
      }
    }
    if (current.plan.action === 'upload_and_recover' && current.recorded) {
      await requireDestination(sink, manifest.destination);
      const uploaded = await sink.putArtifact(current.recorded.id, 'report_json', prepared.artifact);
      if (uploaded.kind === 'ok' && uploaded.value.status === 'created') outcome.writes.artifacts++;
      current = await assess(source, sink, manifest.destination);
      if (current.plan.action === 'upload_and_recover') {
        outcome.reports.push(disposition(source, 'unavailable', `artifact_delivery_${uploaded.kind}`, current.plan.run_id)); continue;
      }
    }
    if (current.plan.action === 'recover' && current.plan.run_id) outcome.server_recovery_run_ids.push(current.plan.run_id);
    outcome.reports.push(current.plan);
  }
  outcome.server_recovery_run_ids = [...new Set(outcome.server_recovery_run_ids)].sort();
  return outcome;
}
