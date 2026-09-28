import { isDeepStrictEqual } from 'node:util';
import type { ReviewResult } from '../consensus/types.js';
import { buildRunEnvelope, type RunEnvelope } from './envelope.js';

const GATING_REASONS = new Set(['consensus', 'critical', 'verified', 'none']);

/** Before 3.6.0, verifier outages could retain a `verified` gate. */
function allowsUnavailableVerified(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const [major, minor] = parts;
  return major! >= 1 && (major! < 3 || (major === 3 && minor! < 6));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compare JSON values, ignoring properties that JSON serialization omits. */
function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

/**
 * A verified-consensus envelope must agree with the immutable report bytes.
 * The wire builder can supply `none` for a missing label, so labels are
 * checked before projecting the report. This check is shared by direct
 * delivery and queued replay.
 */
export function verifiedConsensusReportProblem(
  report: unknown, envelope: RunEnvelope, reportJson: string, directResult?: ReviewResult
): string | undefined {
  if (!isRecord(report) || !isRecord(report['run']) || !isRecord(report['run']['gating']) ||
      report['run']['id'] !== envelope.run.id || report['run']['rcl_version'] !== envelope.run.rcl_version ||
      report['run']['gating']['mode'] !== 'verified-consensus') {
    return 'report_json does not match the queued verified-consensus run';
  }
  if (!Array.isArray(report['findings']) ||
      (report['belowThresholdFindings'] !== undefined && !Array.isArray(report['belowThresholdFindings']))) {
    return 'report_json findings are missing or malformed';
  }
  const groups = [
    ['findings', report['findings']],
    ['belowThresholdFindings', report['belowThresholdFindings'] ?? []],
  ] as const;
  const sourceFindings = groups.flatMap(([, findings]) => findings);
  // `envelope` telemetry omits rows entirely, even when the report has findings.
  const hasWireFindings = envelope.findings.length > 0;
  if (hasWireFindings && sourceFindings.length !== envelope.findings.length) return 'report_json finding count differs from the queued envelope';
  let hasVerification = false;
  let wireIndex = 0;
  for (const [group, findings] of groups) {
    for (const [index, finding] of findings.entries()) {
      if (!isRecord(finding) || !isRecord(finding['gating']) || !GATING_REASONS.has(finding['gating']['reason'] as string)) {
        return `${group}.${index}.gating.reason missing or invalid in report_json`;
      }
      const verification = finding['gating']['verification'];
      if (verification !== undefined) hasVerification = true;
      const verdict = isRecord(verification) ? verification['verdict'] : undefined;
      const reason = finding['gating']['reason'];
      const coherent = reason === 'verified'
        ? verdict === 'confirmed' || verdict === 'unrefuted' ||
          (verdict === 'unavailable' && allowsUnavailableVerified(envelope.run.rcl_version))
        : reason === 'none'
          ? verification === undefined || verdict === 'refuted' || verdict === 'insufficient_evidence' || verdict === 'unavailable'
          : verification === undefined;
      if (!coherent) {
        return `${group}.${index}.gating.verification.verdict contradicts the ${reason} gating reason in report_json`;
      }
      const wire = envelope.findings[wireIndex++];
      if (hasWireFindings && (wire?.gating_reason !== finding['gating']['reason'] || wire?.below_threshold !== (group === 'belowThresholdFindings'))) {
        return `${group}.${index}.gating.reason differs from the queued envelope`;
      }
    }
  }
  if (hasVerification && (!isRecord(report['stats']) || report['stats']['verification'] == null)) {
    return 'stats.verification missing for annotated candidates in report_json';
  }

  // Envelope-level telemetry intentionally has no finding rows. A direct
  // delivery still has the completed result, so bind both original groups
  // before projecting the report into that empty wire view.
  if (directResult !== undefined) {
    for (const group of ['findings', 'belowThresholdFindings'] as const) {
      if (!sameJson(report[group] ?? [], directResult[group] ?? [])) {
        return `report_json ${group} differ from the completed result`;
      }
    }
  }

  // No reviewer rows are present at envelope level. Otherwise the optional
  // parse-failure text setting is not encoded on the wire, so either legal
  // projection may match the queued calls.
  const level = envelope.findings.length > 0 || envelope.calls.length > 0 ? 'findings' : 'envelope';
  try {
    if (!Array.isArray(report['reviews']) || !isRecord(report['stats'])) return 'report_json reviews or stats are malformed';
    const projected = [false, true].map(parseFailures => buildRunEnvelope(report as unknown as ReviewResult,
      { report_json: reportJson }, { level, delivery: envelope.delivery, parseFailures }));
    for (const field of ['run', 'stats', 'findings', 'calls'] as const) {
      if (!projected.some(candidate => sameJson(candidate[field], envelope[field]))) {
        return `report_json ${field} differ from the queued envelope`;
      }
    }
  } catch {
    return 'report_json cannot be projected into the queued envelope';
  }
  return undefined;
}
