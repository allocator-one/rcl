import { cosmiconfig } from 'cosmiconfig';
import { join } from 'path';
import { SEARCH_PLACES } from '../config/loader.js';
import { HarnessSchema, type Config } from '../config/schema.js';
import type { ReviewResult } from '../consensus/types.js';
import { resolveDataDir } from '../config/data-dir.js';
import { credentialHost, resolveHarnessCredential, type HarnessCredential } from './credentials.js';
import { buildRunEnvelope, type ArtifactBytes, type ArtifactKind, type TelemetryLevel } from './envelope.js';
import { deliverable, type WireEvent } from './events.js';
import { ensureNoticeShown } from './notice.js';
import { Outbox, OUTBOX_DIR, type FlushOptions, type FlushSummary } from './outbox.js';
import { scrubText } from './scrub.js';
import { describeOutcome, HarnessSink } from './sink.js';

/**
 * Evidence delivery for a finished review and for the converge commands
 * (epic IO-12475, section 8): resolve where the evidence goes, send it,
 * spool what could not be sent, and say in one dim line what happened.
 * Delivery never blocks a review on the network beyond its own timeouts,
 * never changes the review's result, and never turns a local failure of its
 * own (a read-only data dir, a torn file) into a failed review — only
 * `--evidence-required` turns an unacknowledged delivery into an exit code.
 */

export const STARTUP_FLUSH_DEADLINE_MS = 5_000;
export const EVIDENCE_REQUIRED_EXIT_CODE = 4;

export interface TelemetryRuntime {
  level: TelemetryLevel;
  /** Whether the working tree carries `.harness-cli/config.json`. */
  repoManaged: boolean;
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
  /** The loaded project config; when omitted, the `harness` section is read from the project's config file. */
  config?: Config;
  /** `--no-telemetry` (commander passes `telemetry: false`). */
  noTelemetry?: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
  dataDir?: string;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  stderr?: (line: string) => void;
  /** `rcl telemetry` works on the user's outbox from any directory. */
  requireRepo?: boolean;
}

const ENV_OFF = new Set(['off', '0', 'false', 'no', 'none', 'disabled']);
const LEVELS = new Set<TelemetryLevel>(['off', 'envelope', 'findings', 'full']);

/**
 * What `RCL_TELEMETRY` asks for: `off` (also `0`, `false`, `no`), a level
 * name, or nothing when unset. A value that is set but not understood is a
 * failed opt-out and reads as `off` — never as the default.
 */
export function envTelemetryLevel(env: Record<string, string | undefined>): TelemetryLevel | undefined {
  const raw = (env['RCL_TELEMETRY'] ?? '').trim().toLowerCase();
  if (raw === '') return undefined;
  if (ENV_OFF.has(raw)) return 'off';
  return LEVELS.has(raw as TelemetryLevel) ? (raw as TelemetryLevel) : 'off';
}

/** `--no-telemetry` wins, then `RCL_TELEMETRY`, then `harness.telemetry`; default `full`. */
export function resolveTelemetryLevel(
  config: Pick<Config, 'harness'> | undefined,
  flags: { noTelemetry?: boolean },
  env: Record<string, string | undefined>
): TelemetryLevel {
  if (flags.noTelemetry) return 'off';
  return envTelemetryLevel(env) ?? config?.harness?.telemetry ?? 'full';
}

/**
 * The `harness` section of the project's config file, read without the
 * full loader (whose fleet degradation warns on stderr — noise no startup
 * flush should print). A missing or unusable file reads as no settings.
 */
export async function loadHarnessSettings(cwd: string): Promise<Pick<Config, 'harness'> | undefined> {
  try {
    const found = await cosmiconfig('review-council', { searchPlaces: SEARCH_PLACES }).search(cwd);
    if (!found || found.isEmpty || typeof found.config !== 'object' || found.config === null) return undefined;
    const harness = (found.config as { harness?: unknown }).harness;
    if (harness === undefined) return {};
    const parsed = HarnessSchema.safeParse(harness);
    // A harness section that does not parse fails closed: an opt-out the
    // user wrote next to a typo must still hold.
    return parsed.success ? { harness: parsed.data } : { harness: { telemetry: 'off' } };
  } catch {
    return undefined;
  }
}

export async function createTelemetryRuntime(options: RuntimeOptions): Promise<TelemetryRuntime> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const dataDir = options.dataDir ?? resolveDataDir(env as NodeJS.ProcessEnv);
  const config = options.config ?? (await loadHarnessSettings(cwd));
  const level = resolveTelemetryLevel(config, { noTelemetry: options.noTelemetry }, env);
  const runtime: TelemetryRuntime = {
    level,
    repoManaged: false,
    parseFailures: config?.harness?.parseFailures === true,
    outbox: new Outbox(join(dataDir, OUTBOX_DIR)),
    dataDir,
    rclVersion: options.rclVersion,
    stderr: options.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
  };
  if (level === 'off') return runtime;

  const resolved = await resolveHarnessCredential({
    env,
    cwd,
    ...(options.credentialsPath !== undefined ? { credentialsPath: options.credentialsPath } : {}),
    ...(options.requireRepo !== undefined ? { requireRepo: options.requireRepo } : {}),
  });
  runtime.repoManaged = resolved.repoManaged;
  if (!resolved.repoManaged && options.requireRepo !== false) {
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

/**
 * The consent notice precedes the first transmission from this machine to a
 * host, whatever the transmission is — a run, a converge event, or a flush of
 * something spooled earlier. A notice that cannot be recorded shows again
 * next time; it is never a failure.
 */
async function noticeBefore(runtime: TelemetryRuntime): Promise<void> {
  if (!runtime.credential) return;
  try {
    await ensureNoticeShown(credentialHost(runtime.credential), runtime.dataDir, runtime.stderr);
  } catch {
    // Shown, not recorded — the safe side.
  }
}

/** Flush the outbox through the runtime's sink, the notice shown first. */
export async function flushOutbox(runtime: TelemetryRuntime, options: FlushOptions = {}): Promise<FlushSummary> {
  if (!runtime.sink) throw new Error('No Harness credential to flush with.');
  await noticeBefore(runtime);
  return runtime.outbox.flush(runtime.sink, options);
}

/** Bounded: an offline machine must never stall a command. Fail-soft. */
export async function flushOutboxAtStart(runtime: TelemetryRuntime, deadlineMs = STARTUP_FLUSH_DEADLINE_MS): Promise<void> {
  if (!runtime.sink) return;
  try {
    // One listing, inside the deadline: flush scans the outbox itself.
    const summary = await flushOutbox(runtime, { deadlineMs });
    if (summary.delivered.length > 0) {
      runtime.stderr(
        `Delivered ${summary.delivered.length} spooled evidence entr${summary.delivered.length === 1 ? 'y' : 'ies'} to ${credentialHost(runtime.credential!)}.`
      );
    }
  } catch {
    // The outbox is a convenience; a broken data dir must not stop the command.
  }
}

export type DeliveryStatus =
  | 'recorded'
  | 'spooled'
  | 'disabled'
  | 'rejected'
  | 'conflict'
  | 'skipped'
  | 'off'
  | 'error';

export interface DeliveryOutcome {
  status: DeliveryStatus;
  /** The one dim status line to print (empty when telemetry is off and nothing was required). */
  line: string;
  url?: string;
  runId?: string;
  /** Something waits in the outbox for `rcl telemetry flush`. */
  spooled: boolean;
  /**
   * 4 when `--evidence-required` and the evidence is incomplete: the envelope
   * was not acknowledged, or a declared artifact was spooled or refused.
   */
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

function localFailure(err: unknown): string {
  return scrubText(err instanceof Error ? err.message : String(err), 300);
}

/**
 * POST the envelope, PUT the artifacts (at `full`), POST any events; spool
 * whatever the server could not take because it was unreachable. Local
 * failures (notice file, outbox) are reported, never thrown.
 */
export async function deliverRun(runtime: TelemetryRuntime, input: DeliverRunInput): Promise<DeliveryOutcome> {
  const evidenceRequired = input.evidenceRequired === true;
  if (runtime.level === 'off') {
    return {
      status: 'off',
      line: evidenceRequired ? 'Evidence not sent: telemetry is off, or this repository is not Harness-managed' : '',
      spooled: false,
      exitCode: exitFor('off', evidenceRequired),
    };
  }
  const runId = input.result.run?.id;
  if (runId === undefined) {
    return {
      status: 'skipped',
      line: 'Evidence not sent: the report has no run header',
      spooled: false,
      exitCode: exitFor('skipped', evidenceRequired),
    };
  }
  const envelope = buildRunEnvelope(input.result, input.artifacts, {
    level: runtime.level,
    delivery: { mode: 'direct' },
    parseFailures: runtime.parseFailures,
  });
  const events = (input.events ?? []).filter(deliverable);
  const artifactsToSend: Partial<Record<ArtifactKind, string>> =
    runtime.level === 'full'
      ? {
          report_json: input.artifacts.report_json,
          ...(input.artifacts.report_md !== undefined ? { report_md: input.artifacts.report_md } : {}),
        }
      : {};

  if (!runtime.sink || !runtime.credential) {
    // No credential to send with. When the caller insists on evidence, the
    // run still goes to the outbox so a later login + flush can deliver it.
    const reason = runtime.note ?? 'no Harness credential';
    if (!evidenceRequired) {
      return { status: 'skipped', line: `Evidence not sent: ${reason}`, runId, spooled: false, exitCode: 0 };
    }
    try {
      await runtime.outbox.spoolRun({ runId, envelope, artifacts: artifactsToSend, events });
      return {
        status: 'spooled',
        line: `Evidence spooled (${reason}); run rcl telemetry flush once a credential is available`,
        runId,
        spooled: true,
        exitCode: EVIDENCE_REQUIRED_EXIT_CODE,
      };
    } catch (err) {
      return {
        status: 'skipped',
        line: `Evidence not sent: ${reason}; could not spool it either (${localFailure(err)})`,
        runId,
        spooled: false,
        exitCode: EVIDENCE_REQUIRED_EXIT_CODE,
      };
    }
  }
  const host = credentialHost(runtime.credential);
  await noticeBefore(runtime);

  const posted = await runtime.sink.postRun(envelope);
  switch (posted.kind) {
    case 'unavailable': {
      try {
        const spooled = await runtime.outbox.spoolRun({ runId, envelope, artifacts: artifactsToSend, events });
        const dropped = spooled.artifactsDropped.length > 0 ? ' — artifacts not spooled: outbox over its cap' : '';
        return {
          status: 'spooled',
          runId,
          spooled: true,
          line: `Evidence spooled (Harness unreachable: ${posted.reason}); run rcl telemetry flush${dropped}`,
          exitCode: exitFor('spooled', evidenceRequired),
        };
      } catch (err) {
        return {
          status: 'error',
          runId,
          spooled: false,
          line: `Evidence not sent (Harness unreachable: ${posted.reason}) and could not be spooled: ${localFailure(err)}`,
          exitCode: exitFor('error', evidenceRequired),
        };
      }
    }
    case 'disabled':
      return {
        status: 'disabled',
        runId,
        spooled: false,
        line: `Evidence not sent: ${host} has not enabled review evidence for this organization`,
        exitCode: exitFor('disabled', evidenceRequired),
      };
    case 'conflict':
      return {
        status: 'conflict',
        runId,
        spooled: false,
        line: `Evidence conflict: ${host} already holds run ${runId} with a different report; nothing recorded`,
        exitCode: exitFor('conflict', evidenceRequired),
      };
    case 'rejected':
      return {
        status: 'rejected',
        runId,
        spooled: false,
        line: `Evidence refused by ${host} (${describeOutcome(posted)}); nothing spooled`,
        exitCode: exitFor('rejected', evidenceRequired),
      };
    case 'ok':
      break;
  }

  const receipt = posted.value;
  const notes: string[] = [];
  const pendingArtifacts: Partial<Record<ArtifactKind, string>> = {};
  let unreachable = false;
  let artifactsRefused = 0;
  for (const [kind, bytes] of Object.entries(artifactsToSend) as Array<[ArtifactKind, string]>) {
    if (!receipt.artifacts_expected.includes(kind)) continue;
    if (unreachable) {
      // The server went away mid-delivery: spool the rest instead of
      // waiting out one timeout per artifact.
      pendingArtifacts[kind] = bytes;
      continue;
    }
    const outcome = await runtime.sink.putArtifact(runId, kind, bytes);
    if (outcome.kind === 'ok') continue;
    if (outcome.kind === 'disabled') {
      notes.push('artifacts capped by the organization');
      break;
    }
    if (outcome.kind === 'unavailable') {
      unreachable = true;
      pendingArtifacts[kind] = bytes;
      continue;
    }
    // A refusal is final — retrying the same bytes cannot help — so it is
    // not spooled; under --evidence-required it makes the evidence incomplete.
    artifactsRefused += 1;
    notes.push(`${kind} refused: ${describeOutcome(outcome)}`);
  }

  let pendingEvents: WireEvent[] = [];
  if (events.length > 0) {
    if (unreachable) {
      pendingEvents = events;
    } else {
      const outcome = await runtime.sink.postEvents(events);
      if (outcome.kind === 'unavailable') pendingEvents = events;
      else if (outcome.kind === 'rejected' || outcome.kind === 'conflict') notes.push(`events refused: ${describeOutcome(outcome)}`);
    }
  }

  let spooled = false;
  if (Object.keys(pendingArtifacts).length > 0 || pendingEvents.length > 0) {
    const parts = [
      Object.keys(pendingArtifacts).length > 0 ? 'artifacts' : undefined,
      pendingEvents.length > 0 ? 'events' : undefined,
    ].filter((p): p is string => p !== undefined);
    try {
      const result = await runtime.outbox.spoolRun({
        runId,
        envelope,
        artifacts: pendingArtifacts,
        events: pendingEvents,
        envelopeDelivered: true,
        runUrl: receipt.url,
      });
      const kept = Object.keys(pendingArtifacts).filter((kind) => !result.artifactsDropped.includes(kind as ArtifactKind));
      spooled = kept.length > 0 || pendingEvents.length > 0;
      const retained = [kept.length > 0 ? 'artifacts' : undefined, pendingEvents.length > 0 ? 'events' : undefined].filter(
        (p): p is string => p !== undefined
      );
      if (retained.length > 0) notes.push(`${retained.join(' and ')} spooled; run rcl telemetry flush`);
      if (result.artifactsDropped.length > 0) {
        notes.push(`${result.artifactsDropped.join(', ')} not spooled: outbox over its cap`);
      }
    } catch (err) {
      notes.push(`${parts.join(' and ')} not delivered and could not be spooled: ${localFailure(err)}`);
    }
  }

  // The run is recorded; the evidence is complete only when every artifact
  // the server expected has landed (or the org caps artifacts).
  const artifactsOutstanding = Object.keys(pendingArtifacts).length + artifactsRefused;
  return {
    status: 'recorded',
    runId,
    url: receipt.url,
    spooled,
    line: `Evidence recorded: ${receipt.url}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
    exitCode: evidenceRequired && artifactsOutstanding > 0 ? EVIDENCE_REQUIRED_EXIT_CODE : 0,
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
  await noticeBefore(runtime);
  const outcome = await runtime.sink.postEvents(sendable);
  switch (outcome.kind) {
    case 'ok':
      return 'sent';
    case 'unavailable':
      try {
        await runtime.outbox.spoolEvents(sendable);
        return 'spooled';
      } catch {
        return 'refused';
      }
    case 'disabled':
      return 'skipped';
    case 'conflict':
    case 'rejected':
      runtime.stderr(
        `Converge events refused by ${runtime.credential ? credentialHost(runtime.credential) : 'Harness'}: ${describeOutcome(outcome)}`
      );
      return 'refused';
  }
}
