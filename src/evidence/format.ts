import { scrubText } from '../telemetry/scrub.js';
import type { GateStatus, Projection, RunDetail } from './types.js';

/**
 * Terminal rendering of what Harness holds; one line per entry, no colour,
 * safe to grep. Every server-supplied string — repository names, titles,
 * paths, model names, errors, URLs — can trace back to reviewed code or model
 * output, so it reaches the terminal only through `text()`: control and
 * escape characters (C0, DEL, C1) become spaces, secrets are scrubbed, and
 * the length is bounded, which also keeps every entry on its one line.
 */

function text(value: unknown, limit = 300): string {
  if (value === null || value === undefined) return '—';
  return scrubText(String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '), limit);
}

function short(sha: string | null | undefined): string {
  return typeof sha === 'string' && sha.length > 0 ? text(sha.slice(0, 10), 10) : '—';
}

function where(file: string | null | undefined, line: number | null | undefined): string {
  if (!file) return '—';
  return `${text(file)}${typeof line === 'number' ? `:${line}` : ''}`;
}

function projectionLines(name: string, projection: Projection, judged: boolean): string[] {
  const lines = [
    `${name}: ${text(projection.status, 40)}${projection.conclusive ? '' : ' (inconclusive)'}${judged ? ' ← judged' : ''}` +
      (projection.run_id ? ` — run ${short(projection.run_id)}${projection.run_url ? ` ${text(projection.run_url)}` : ''}` : ''),
  ];
  for (const round of projection.rounds) {
    lines.push(
      `  round ${typeof round.converge_round === 'number' ? round.converge_round : '·'}: ${short(round.id)} head ${short(round.head_sha)} ${text(round.tier, 40)}` +
        `${round.received_at ? ` ${text(round.received_at, 40)}` : ''}${round.url ? ` ${text(round.url)}` : ''}`
    );
  }
  for (const finding of projection.actionable) {
    lines.push(
      `  actionable ${text(finding.identity_key ?? finding.ref ?? '?', 64)} ${text(finding.severity, 20)}/${text(finding.gating_reason, 20)} ` +
        `${where(finding.file, finding.start_line)} ${text(finding.title, 200)}`
    );
  }
  return lines;
}

export function formatGateStatus(status: GateStatus, judged: 'advisory' | 'enforced'): string[] {
  const head = status.head;
  const name = `${text(status.repo, 200)}#${status.pr_number}`;
  const headLine = !head
    ? `${name} — no head known to Harness`
    : `${name} — head ${short(head.sha)}${head.source ? ` (${text(head.source, 40)})` : ''}` +
      `${head.merged ? ` — merged${head.merge_commit_sha ? ` as ${short(head.merge_commit_sha)}` : ''}` : ''}` +
      `${head.is_cross_repository ? ' — fork' : ''}`;
  const decision = status.decision;
  return [
    headLine,
    ...projectionLines('advisory', status.advisory, judged === 'advisory'),
    ...projectionLines('enforced', status.enforced, judged === 'enforced'),
    decision
      ? `decision: ${text(decision.decision, 40)} at ${short(decision.reviewed_head_sha)} (${text(decision.source, 40)}` +
        `${decision.merged_at ? `, merged ${text(decision.merged_at, 40)}` : ''})`
      : 'decision: —',
  ];
}

function reviewerHealth(run: RunDetail): string {
  const stats = run.stats ?? {};
  const total = stats['totalReviews'];
  const ok = stats['successfulReviews'];
  if (typeof total === 'number' && typeof ok === 'number') return `${ok}/${total}`;
  return `${run.calls.filter((call) => call.status === 'success').length}/${run.calls.length}`;
}

export function formatRun(run: RunDetail): string[] {
  const runner = run.runner ?? {};
  const runnerKind = typeof runner['kind'] === 'string' ? text(runner['kind'], 40) : '—';
  const ciRunId = typeof runner['ci_run_id'] === 'string' ? ` ${text(runner['ci_run_id'], 40)}` : '';
  const target = run.target;
  const named = target.repo && target.pr_number ? `${text(target.repo, 200)}#${target.pr_number}` : text(target.kind, 40);
  const converge = run.converge;
  const lines = [
    `run ${text(run.id, 64)}${run.url ? ` ${text(run.url)}` : ''}`,
    `target ${named} @ ${short(target.head_sha)} (head ${text(run.head_verified ?? 'unknown', 20)}${run.repo_verified ? ', repo verified' : ''}` +
      `${run.is_cross_repository ? ', fork' : ''})`,
    `credential ${text(run.credential_kind, 40)} (${text(run.tier ?? 'asserted', 40)}) — runner ${runnerKind}${ciRunId} — rcl ${text(run.rcl_version, 40)}` +
      (run.provenance && run.provenance !== 'live' ? ` — ${text(run.provenance, 40)}` : ''),
    `reviewers ${reviewerHealth(run)} ok` +
      (converge ? ` — converge ${text(converge.target, 200)}${typeof converge.round === 'number' ? ` round ${converge.round}` : ''}` : '') +
      (run.received_at ? ` — received ${text(run.received_at, 40)}` : ''),
  ];
  for (const artifact of run.artifacts ?? []) {
    lines.push(`artifact ${text(artifact.kind, 40)} ${artifact.stored ? 'stored' : 'missing'}${artifact.url ? ` ${text(artifact.url)}` : ''}`);
  }
  lines.push(`findings (${run.findings.length}): identity severity gating file:line title — verdict`);
  for (const finding of run.findings) {
    const verdict = finding.verdict
      ? `${text(finding.verdict.verdict, 40)}${typeof finding.verdict.round === 'number' ? ` (round ${finding.verdict.round})` : ''}`
      : '—';
    lines.push(
      `  ${text(finding.identity_key ?? finding.ref ?? '?', 64)} ${text(finding.severity, 20)} ${text(finding.gating_reason ?? 'none', 20)} ` +
        `${where(finding.file, finding.start_line)} ${text(finding.title, 200)} — ${verdict}`
    );
  }
  lines.push(`calls (${run.calls.length}):`);
  for (const call of run.calls) {
    const duration = typeof call.duration_ms === 'number' ? ` ${call.duration_ms}ms` : '';
    lines.push(
      `  call ${text(call.model, 80)}${call.role ? ` ${text(call.role, 40)}` : ''} ${text(call.status, 20)}${duration}${call.error ? ` — ${text(call.error, 200)}` : ''}`
    );
  }
  return lines;
}
