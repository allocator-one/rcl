import type { Config } from '../config/schema.js';
import type { ReviewResult } from '../consensus/types.js';
import { resolveDataDir } from '../models/stats-store.js';
import { credentialHost, resolveHarnessCredential, type HarnessCredential } from './credentials.js';
import { buildRunEnvelope, type ArtifactBytes, type ArtifactKind, type TelemetryLevel } from './envelope.js';
import { deliverable, type WireEvent } from './events.js';
import { ensureNoticeShown } from './notice.js';
import { Outbox } from './outbox.js';
import { describeOutcome, HarnessSink } from './sink.js';

/**
 * Evidence delivery for a finished review and for the converge commands
 * (epic IO-12475, section 8): resolve where the evidence goes, send it,
 * spool what could not be sent, and say in one dim line what happened.
 * Delivery never blocks a review on the network beyond its own timeouts,
 * and never changes the review's result — only `--evidence-required`
 * turns an unacknowledged delivery into an exit code.
 */

export const STARTUP_FLUSH_DEADLINE_MS = 5_000;
export const EVIDENCE_REQUIRED_EXIT_CODE = 4;

export interface TelemetryRuntime {
  level: TelemetryLevel;
  parseFailures: boolean;
  credential?: HarnessCredential;
  /** Why there is no credential, when telemetry would otherwise apply. */
  note?: string;
  sink?: HarnessSink;
  outbox: Outbox;
  dataDir: string;
  rclVersion: string;
  stderr: (line: string) => void;
}

export interface RuntimeOptions {
  rclVersion: string;
  config?: Config;
  /** `--no-telemetry` (commander passes `telemetry: false`). */
  noTelemetry?: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
  dataDir?: string;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  stderr?: (line: string) => void;
}

/** `RCL_TELEMETRY=off` and `--no-telemetry` win; then `harness.telemetry`; default `full`. */
export function resolveTelemetryLevel(
  config: Config | undefined,
  flags: { noTelemetry?: boolean },
  env: Record<string, string | undefined>
): TelemetryLevel {
  if (flags.noTelemetry) return 'off';
  if ((env['RCL_TELEMETRY'] ?? '').trim().toLowerCase() === 'off') return 'off';
  return config?.harness?.telemetry ?? 'full';
}

export async function createTelemetryRuntime(options: RuntimeOptions): Promise<TelemetryRuntime> {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? resolveDataDir(env as NodeJS.ProcessEnv);
  const level = resolveTelemetryLevel(options.config, { noTelemetry: options.noTelemetry }, env);
  const runtime: TelemetryRuntime = {
    level,
    parseFailures: options.config?.harness?.parseFailures === true,
    outbox: new Outbox(`${dataDir}/outbox`),
    dataDir,
    rclVersion: options.rclVersion,
    stderr: options.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  };
  if (level === 'off') return runtime;

  const resolved = await resolveHarnessCredential({
    env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.credentialsPath !== undefined ? { credentialsPath: options.credentialsPath } : {}),
  });
  if (!resolved.repoManaged) {
    // Not a Harness-managed repository: there is nowhere the evidence belongs.
    return { ...runtime, level: 'off' };
  }
  if (resolved.note !== undefined) runtime.note = resolved.note;
  if (resolved.credential) {
    runtime.credential = resolved.credential;
    runtime.sink = new HarnessSink({
      credential: resolved.credential,
      rclVersion: options.rclVersion,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  return runtime;
}

/** Bounded: an offline machine must never stall a command. Fail-soft. */
export async function flushOutboxAtStart(runtime: TelemetryRuntime, deadlineMs = STARTUP_FLUSH_DEADLINE_MS): Promise<void> {
  if (!runtime.sink) return;
  try {
    const entries = await runtime.outbox.list();
    if (entries.length === 0) return;
    const summary = await runtime.outbox.flush(runtime.sink, { deadlineMs });
    if (summary.delivered.length > 0) {
      runtime.stderr(`Delivered ${summary.delivered.length} spooled evidence entr${summary.delivered.length === 1 ? 'y' : 'ies'} to ${credentialHost(runtime.credential!)}.`);
    }
  } catch {
    // The outbox is a convenience; a broken data dir must not stop the command.
  }
}

export type DeliveryStatus = 'recorded' | 'spooled' | 'disabled' | 'rejected' | 'conflict' | 'skipped' | 'off';

export interface DeliveryOutcome {
  status: DeliveryStatus;
  /** The one dim status line to print (empty when telemetry is off). */
  line: string;
  url?: string;
  runId?: string;
  /** 4 when `--evidence-required` and the envelope was not acknowledged. */
  exitCode: 0 | typeof EVIDENCE_REQUIRED_EXIT_CODE;
}

export interface DeliverRunInput {
  result: ReviewResult;
  artifacts: ArtifactBytes;
  evidenceRequired?: boolean;
  events?: WireEvent[];
}

function exitFor(status: DeliveryStatus, evidenceRequired: boolean): DeliveryOutcome['exitCode'] {
  return evidenceRequired && status !== 'recorded' ? EVIDENCE_REQUIRED_EXIT_CODE : 0;
}

/**
 * POST the envelope, PUT the artifacts (at `full`), POST any events; spool
 * whatever the server could not take because it was unreachable.
 */
export async function deliverRun(runtime: TelemetryRuntime, input: DeliverRunInput): Promise<DeliveryOutcome> {
  const evidenceRequired = input.evidenceRequired === true;
  if (runtime.level === 'off') {
    return { status: 'off', line: '', exitCode: exitFor('off', evidenceRequired) };
  }
  const runId = input.result.run?.id;
  if (!runtime.sink || !runtime.credential || runId === undefined) {
    const reason = runId === undefined ? 'the report has no run header' : runtime.note ?? 'no Harness credential';
    return { status: 'skipped', line: `Evidence not sent: ${reason}`, exitCode: exitFor('skipped', evidenceRequired) };
  }
  const host = credentialHost(runtime.credential);
  const envelope = buildRunEnvelope(input.result, input.artifacts, {
    level: runtime.level,
    delivery: { mode: 'direct' },
    parseFailures: runtime.parseFailures,
  });
  const events = (input.events ?? []).filter(deliverable);
  const artifactsToSend: Partial<Record<ArtifactKind, string>> =
    runtime.level === 'full'
      ? { report_json: input.artifacts.report_json, ...(input.artifacts.report_md !== undefined ? { report_md: input.artifacts.report_md } : {}) }
      : {};

  await ensureNoticeShown(host, runtime.dataDir, runtime.stderr);

  const posted = await runtime.sink.postRun(envelope);
  switch (posted.kind) {
    case 'unavailable': {
      const spooled = await runtime.outbox.spoolRun({ runId, envelope, artifacts: artifactsToSend, events });
      const dropped = spooled.artifactsDropped.length > 0 ? ' — artifacts not spooled: outbox over its cap' : '';
      return {
        status: 'spooled',
        runId,
        line: `Evidence spooled (Harness unreachable: ${posted.reason}); run rcl telemetry flush${dropped}`,
        exitCode: exitFor('spooled', evidenceRequired),
      };
    }
    case 'disabled':
      return {
        status: 'disabled',
        runId,
        line: `Evidence not sent: ${host} has not enabled review evidence for this organization`,
        exitCode: exitFor('disabled', evidenceRequired),
      };
    case 'conflict':
      return {
        status: 'conflict',
        runId,
        line: `Evidence conflict: ${host} already holds run ${runId} with a different report; nothing recorded`,
        exitCode: exitFor('conflict', evidenceRequired),
      };
    case 'rejected':
      return {
        status: 'rejected',
        runId,
        line: `Evidence refused by ${host} (${describeOutcome(posted)}); nothing spooled`,
        exitCode: exitFor('rejected', evidenceRequired),
      };
    case 'ok':
      break;
  }

  const receipt = posted.value;
  const notes: string[] = [];
  const pendingArtifacts: Partial<Record<ArtifactKind, string>> = {};
  for (const [kind, bytes] of Object.entries(artifactsToSend) as Array<[ArtifactKind, string]>) {
    if (!receipt.artifacts_expected.includes(kind)) continue;
    const outcome = await runtime.sink.putArtifact(runId, kind, bytes);
    if (outcome.kind === 'ok') continue;
    if (outcome.kind === 'disabled') {
      notes.push('artifacts capped by the organization');
      break;
    }
    if (outcome.kind === 'unavailable') {
      pendingArtifacts[kind] = bytes;
      continue;
    }
    notes.push(`${kind} refused: ${describeOutcome(outcome)}`);
  }

  let pendingEvents: WireEvent[] = [];
  if (events.length > 0) {
    const outcome = await runtime.sink.postEvents(events);
    if (outcome.kind === 'unavailable') pendingEvents = events;
    else if (outcome.kind === 'rejected' || outcome.kind === 'conflict') notes.push(`events refused: ${describeOutcome(outcome)}`);
  }

  if (Object.keys(pendingArtifacts).length > 0 || pendingEvents.length > 0) {
    await runtime.outbox.spoolRun({
      runId,
      envelope,
      artifacts: pendingArtifacts,
      events: pendingEvents,
      envelopeDelivered: true,
      runUrl: receipt.url,
    });
    notes.push('artifacts spooled; run rcl telemetry flush');
  }

  return {
    status: 'recorded',
    runId,
    url: receipt.url,
    line: `Evidence recorded: ${receipt.url}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
    exitCode: 0,
  };
}

/**
 * Converge commands report their events through the same sink, fail-soft:
 * unreachable spools, anything else is noted and dropped.
 */
export async function emitConvergeEvents(
  runtime: TelemetryRuntime,
  events: WireEvent[]
): Promise<'sent' | 'spooled' | 'skipped' | 'refused'> {
  if (runtime.level === 'off' || !runtime.sink) return 'skipped';
  const sendable = events.filter(deliverable);
  if (sendable.length === 0) return 'skipped';
  const outcome = await runtime.sink.postEvents(sendable);
  switch (outcome.kind) {
    case 'ok':
      return 'sent';
    case 'unavailable':
      await runtime.outbox.spoolEvents(sendable);
      return 'spooled';
    case 'disabled':
      return 'skipped';
    case 'conflict':
    case 'rejected':
      runtime.stderr(`Converge events refused by ${credentialHost(runtime.credential!)}: ${describeOutcome(outcome)}`);
      return 'refused';
  }
}
