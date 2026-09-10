import { z } from 'zod';
import type { ConvergeRunState } from '../converge/run-state.js';
import { buildEvent, type WireEvent } from '../telemetry/events.js';
import type { RunDetail } from './types.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nativeKey = z.string().regex(/^[a-f0-9]{16}$/);
const round = z.number().int().positive().max(2_147_483_647);
const severity = z.enum(['critical', 'important', 'minor', 'nitpick']);
const entrySchema = z.object({
  key: nativeKey,
  file: z.string().min(1).max(20_000),
  category: z.string().min(1).max(64),
  startLine: z.number().int().nonnegative().max(2_147_483_647),
  endLine: z.number().int().nonnegative().max(2_147_483_647),
  firstRound: round,
  lastRound: round,
  verdict: z.enum(['dismissed', 'fixed']),
  verdictRound: round,
  severity,
  verdictSeverity: severity.optional(),
});

export interface FindingRecoveryInput {
  state: ConvergeRunState;
  /** Digest of the exact bytes from which state was read, not a re-encoding. */
  stateSha256: string;
  run: RunDetail;
  target: string;
  runId: string;
  reportSha256: string;
  findingRef: string;
  identity: string;
  repository: string;
  prNumber: number;
}

/**
 * An attributed assertion from retained native state, not a reconstructed
 * classification or proof of report artifact retrieval. No state is written and
 * no verdict is created. Harness validates the corresponding stored verdict at
 * submission. Exact spans deliberately refuse state changed by later sightings.
 */
export function prepareFindingRecovery(input: FindingRecoveryInput): WireEvent {
  const { run, state } = input;
  const require = (ok: boolean, message: string): void => { if (!ok) throw new Error(message); };
  require(z.uuid().safeParse(input.runId).success && run.id.toLowerCase() === input.runId.toLowerCase(), 'Recovery run ID does not match server evidence.');
  require(run.target.kind === 'pr' || run.target.kind === 'patch', 'Recovery requires a PR-bound review.');
  require(run.target.repo?.toLowerCase() === input.repository.toLowerCase() && run.target.pr_number === input.prNumber,
    'Recovery repository/PR does not match server evidence.');
  require(digest.safeParse(input.reportSha256).success, 'Recovery report digest must be a lower-case SHA-256.');
  const reports = run.artifacts?.filter((a) => a.kind === 'report_json') ?? [];
  require(reports.length === 1 && reports[0]!.declared_sha256 === input.reportSha256, 'Recovery report digest does not match server evidence.');
  require(digest.safeParse(input.stateSha256).success, 'Recovery state digest must be a lower-case SHA-256.');
  require(state.version === 1 && state.target === input.target && run.converge?.target === input.target,
    'Recovery target does not match native and server evidence.');
  const runRound = run.converge?.round;
  require(round.safeParse(runRound).success, 'Recovery requires a recorded round.');
  const rounds = state.rounds.filter((r) => r.round === runRound);
  require(rounds.length === 1 && rounds[0]!.runId?.toLowerCase() === input.runId.toLowerCase(),
    'Native round is not bound to the selected run.');
  require(input.findingRef.length > 0 && input.findingRef.length <= 32, 'Recovery finding ref is invalid.');
  const findings = run.findings.filter((f) => f.ref === input.findingRef);
  require(findings.length === 1, 'Recovery requires one exact finding ref.');
  const finding = findings[0]!;
  require(typeof finding.identity_key === 'string' && finding.identity_key.length > 0 && finding.identity_key.length <= 64,
    'Recovery finding has no valid original report key.');
  require(nativeKey.safeParse(input.identity).success, 'Recovery requires an explicit native identity.');
  const parsed = entrySchema.safeParse(state.findings[input.identity]);
  require(parsed.success, 'Recovery requires a retained native identity with a verdict.');
  const entry = parsed.data!;
  require(entry.key === input.identity, 'Native identity key does not match its entry.');
  require(entry.firstRound <= runRound! && entry.lastRound === runRound, 'Native identity no longer describes this round.');
  require(entry.verdictRound === runRound, 'Recovery requires a native verdict from this round.');
  require(entry.file === finding.file && entry.category === finding.category && entry.startLine === finding.start_line &&
    entry.endLine === finding.end_line && entry.endLine >= entry.startLine, 'Native identity location does not match the selected finding.');

  const payload = {
    report_json_sha256: input.reportSha256, finding_ref: input.findingRef,
    identity_key: finding.identity_key!, matched_identity: input.identity,
    native_evidence: {
      source: 'rcl_converge_state', state_version: state.version, state_sha256: input.stateSha256,
      identity_key: entry.key, file: entry.file, category: entry.category,
      start_line: entry.startLine, end_line: entry.endLine, first_round: entry.firstRound, last_round: entry.lastRound,
      verdict: entry.verdict, verdict_round: entry.verdictRound, verdict_severity: entry.verdictSeverity ?? entry.severity,
    },
  };
  const event = buildEvent({
    kind: 'finding_identity_corrected', runId: run.id, convergeTarget: input.target, round: runRound!, payload,
  });
  // Normal transport scrubbing still applies. Exact evidence must not be
  // silently rebound to a redacted/truncated identifier, including in preview.
  require(event.converge_target === input.target && JSON.stringify(event.payload) === JSON.stringify(payload),
    'Recovery refused: transport scrubbing would change an exact binding.');
  return event;
}
