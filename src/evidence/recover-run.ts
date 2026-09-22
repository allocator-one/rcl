import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { resolveDataDir } from '../config/data-dir.js';
import { readStable, platformPath, sha256 } from '../telemetry/recovery/files.js';
import { type ArtifactKind } from '../telemetry/envelope.js';
import { openSink, type EvidenceDeps } from './status.js';
import { prepareOriginalRun, hashSchema, selectionSchema, uuidSchema, type PreparedOriginal } from './original-run/source.js';
import { destination, readOriginalRun, readOriginalArtifacts, type Destination } from './original-run/remote.js';
import { writeExclusive, withRecoveryLock, openJournal, serializeRecoveryDocument } from './original-run/journal.js';
import { decodeOriginalReport } from './original-run/decode.js';

export interface OriginalRunOptions {
  preview?: boolean; apply?: boolean; resume?: boolean; json?: boolean;
  manifest: string; manifestSha256?: string;
  run?: string; forPr?: string; head?: string; reportJson?: string; reportSha256?: string;
  reportMd?: string; markdownSha256?: string; originalMode?: string;
}
export interface OriginalRunDeps extends EvidenceDeps { beforeCheckpoint?: (phase: string) => Promise<void> }
export const MAX_ORIGINAL_RUN_MANIFEST_BYTES = 8 * 1024 * 1024;
const manifestSchema = z.object({
  kind: z.literal('rcl-original-run-recovery'), version: z.literal(1), operation_id: uuidSchema,
  created_at: z.string(), rcl_version: z.string(),
  destination: z.object({ base_url: z.string(), org_id: uuidSchema }).strict(),
  prepared: z.object({ selection: selectionSchema }).passthrough(),
  preview: z.object({ run_exists: z.boolean(), artifacts: z.record(z.string(), z.enum(['missing','verified'])) }).strict(),
}).strict();
function failure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  if (error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message)) return error.message;
  return 'invalid_or_unsupported_recovery_input';
}
function outcomeAudit(outcome: { kind: string; httpStatus?: number; error?: string }): Record<string, unknown> {
  const httpStatus = outcome.httpStatus;
  const error = outcome.error;
  return {
    kind: outcome.kind,
    ...(Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { http_status: httpStatus } : {}),
    ...(typeof error === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error) ? { error } : {}),
  };
}
/** Mode A only: no provider, event, native accounting, outbox or fresh report generation. */
export async function runOriginalRecovery(options: OriginalRunOptions, deps: OriginalRunDeps): Promise<number> {
  let stage: 'input' | 'remote' | 'journal' = 'input';
  const emit = (value: unknown) => deps.stdout(JSON.stringify(value));
  try {
    if ([options.preview, options.apply, options.resume].filter(Boolean).length !== 1) throw new Error('choose_exactly_one_recovery_mode');
    const path = platformPath(options.manifest);
    let manifest: z.infer<typeof manifestSchema> | undefined;
    let boundSha: string | undefined;
    let prepared: PreparedOriginal;
    let artifacts: Awaited<ReturnType<typeof prepareOriginalRun>>['artifacts'];
    if (options.preview) {
      if (options.manifestSha256 !== undefined) throw new Error('preview_does_not_accept_manifest_digest');
      ({ prepared, artifacts } = await prepareOriginalRun({ run: options.run, forPr: options.forPr, head: options.head, reportJson: options.reportJson, reportSha256: options.reportSha256, reportMd: options.reportMd, markdownSha256: options.markdownSha256, originalMode: options.originalMode }));
      // Reject oversized prepared evidence before any destination read. The complete
      // manifest is checked again after destination and observation metadata exist.
      serializeRecoveryDocument({ prepared }, MAX_ORIGINAL_RUN_MANIFEST_BYTES);
      if (await realpath(dirname(path)) !== dirname(path)) throw new Error('symlink_directory');
      try { await lstat(path); throw new Error('manifest_already_exists'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    } else {
      if ([options.run,options.forPr,options.head,options.reportJson,options.reportSha256,options.reportMd,options.markdownSha256,options.originalMode].some(v => v !== undefined)) throw new Error('resume_uses_only_pinned_manifest');
      boundSha = hashSchema.parse(options.manifestSha256);
      const retained = await readStable(path, MAX_ORIGINAL_RUN_MANIFEST_BYTES);
      if (retained.sha256 !== boundSha) throw new Error('manifest_digest_mismatch');
      manifest = manifestSchema.parse(decodeOriginalReport(retained.text).value);
      ({ prepared, artifacts } = await prepareOriginalRun(manifest.prepared.selection));
      if (!isDeepStrictEqual(prepared, manifest.prepared)) throw new Error('original_source_or_preparation_changed');
    }
    stage = 'remote';
    const sink = await openSink(deps); if (!sink) return 3;
    const target = await destination(sink);
    if (manifest && !isDeepStrictEqual(manifest.destination, target)) throw new Error('destination_or_organization_conflict');
    const inspect = async () => {
      const run = await readOriginalRun(sink, target, prepared);
      const states = run.exists ? await readOriginalArtifacts(sink, prepared) : Object.fromEntries(prepared.envelope.artifacts_declared.map(a => [a.kind, 'missing' as const]));
      return { run, states };
    };
    const verifySources = async () => {
      stage = 'input';
      const current = await prepareOriginalRun(prepared.selection);
      if (!isDeepStrictEqual(current.prepared, prepared)) throw new Error('original_source_or_preparation_changed');
    };
    if (options.preview) {
      const observed = await inspect();
      await verifySources();
      const value = { kind: 'rcl-original-run-recovery' as const, version: 1 as const, operation_id: randomUUID(), created_at: new Date().toISOString(), rcl_version: deps.rclVersion, destination: target, prepared, preview: { run_exists: observed.run.exists, artifacts: observed.states } };
      manifestSchema.parse(value);
      const serialized = serializeRecoveryDocument(value, MAX_ORIGINAL_RUN_MANIFEST_BYTES);
      stage = 'journal'; await writeExclusive(path, value, MAX_ORIGINAL_RUN_MANIFEST_BYTES);
      emit({ status: 'prepared', manifest: path, manifest_sha256: sha256(serialized), operation_id: value.operation_id, run_id: prepared.selection.run, observation: value.preview, accounting: 'unchanged; no native admission or verdict', original_mode: prepared.original_mode, retained_content_limitations: prepared.retained_content_limitations });
      return 0;
    }
    const selected = manifest!; const pinned = boundSha!;
    stage = 'journal';
    const completion = await withRecoveryLock(join(resolveDataDir(deps.env), 'original-run-recovery-locks'), JSON.stringify([target.base_url,target.org_id,prepared.selection.run]), async () => {
      const journal = await openJournal(`${path}.journal`, pinned, selected.operation_id, options.apply ? 'apply' : 'resume', deps.beforeCheckpoint);
      const append = async (phase: string, data?: unknown) => { stage = 'journal'; await journal.append(phase, data); };
      const read = async () => { stage = 'remote'; if (!isDeepStrictEqual(await destination(sink), target)) throw new Error('destination_or_organization_conflict'); return inspect(); };
      await append('prepared', { source_sha256: prepared.sources, envelope_sha256: prepared.envelope_sha256, destination: target, retained_content_limitations: prepared.retained_content_limitations });
      let observed = await read();
      if (!observed.run.exists) {
        if (selected.preview.run_exists) throw new Error('previously_recorded_run_disappeared_conflict');
        await append('post_intent', { envelope_sha256: prepared.envelope_sha256 });
        await verifySources();
        stage = 'remote'; const posted = await sink.postRun(prepared.envelope);
        await append('post_outcome', outcomeAudit(posted));
        observed = await read();
        if (!observed.run.exists) {
          if (posted.kind === 'rejected') throw new Error(`run_delivery_rejected_${outcomeAudit(posted).error ?? 'unspecified'}`);
          throw new Error('run_delivery_not_verified');
        }
      }
      await append('run_verified', { projection_sha256: observed.run.exists ? observed.run.projection_sha256 : null });
      for (const a of prepared.envelope.artifacts_declared) {
        if (observed.states[a.kind] === 'verified') continue;
        await append('put_intent', { kind: a.kind, sha256: a.sha256, bytes: a.bytes });
        await verifySources();
        stage = 'remote'; const uploaded = await sink.putArtifact(prepared.selection.run, a.kind, artifacts[a.kind as ArtifactKind]!);
        await append('put_outcome', { artifact: a.kind, ...outcomeAudit(uploaded) });
        observed = await read();
        if (!observed.run.exists || observed.states[a.kind] !== 'verified') {
          if (uploaded.kind === 'rejected') throw new Error(`artifact_delivery_rejected_${outcomeAudit(uploaded).error ?? 'unspecified'}`);
          throw new Error('artifact_delivery_not_verified');
        }
        await append('artifact_verified', a);
      }
      observed = await read();
      if (!observed.run.exists || Object.values(observed.states).some(v => v !== 'verified') ||
        (observed.run.raw.artifacts as Array<{ stored: boolean }>).some(a => !a.stored)) throw new Error('completion_not_verified');
      await verifySources();
      await append('complete', { projection_sha256: observed.run.projection_sha256, artifacts: prepared.envelope.artifacts_declared });
      return { status: 'complete', operation_id: selected.operation_id, run_id: prepared.selection.run, manifest_sha256: pinned, journal: `${path}.journal`, destination: target, artifacts: prepared.envelope.artifacts_declared, accounting: 'unchanged; delivery is not a native admission, verdict or gate approval' };
    });
    emit(completion);
    return 0;
  } catch (error) {
    const reason = failure(error);
    const definitiveRejection = reason.startsWith('run_delivery_rejected_') || reason.startsWith('artifact_delivery_rejected_');
    const exit = stage === 'input' ? 2 : definitiveRejection || reason.includes('conflict') ? 4 : stage === 'journal' ? 5 : 3;
    const instruction = options.preview
      ? 'Correct the explicit input; no delivery was attempted.'
      : definitiveRejection
        ? 'Correct the reported remote refusal; do not resume this manifest unchanged.'
        : 'Preserve the manifest and journal. Resume this same pinned operation after resolving the reported failure; completion requires fresh readback.';
    const result = { status: 'incomplete', error: reason, stage, exit_code: exit, instruction };
    if (options.json) emit(result); else deps.stderr(`Original-run recovery incomplete: ${reason}. ${result.instruction}`);
    return exit;
  }
}
export type { Destination };
