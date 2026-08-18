import { writeFile } from 'fs/promises';
import type { AgreementTier, ConsensusFinding, ReviewResult } from '../consensus/types.js';
import { sanitizeInline, sanitizeBlock, fencedCodeBlock } from './sanitize.js';

function severityEmoji(severity: ConsensusFinding['severity']): string {
  return { critical: '🔴', important: '🟡', minor: '🔵', nitpick: '⚪' }[severity];
}

const SEVERITY_ORDER: Record<ConsensusFinding['severity'], number> = {
  critical: 0,
  important: 1,
  minor: 2,
  nitpick: 3,
};

/** Strongest evidence first inside every section: severity, then confidence. */
function bySeverityThenConfidence(a: ConsensusFinding, b: ConsensusFinding): number {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    b.consensus.confidence - a.consensus.confidence
  );
}

/**
 * The report's organizing principle: agreement tier. Disputed findings are
 * pulled out of their count-based tier into their own section — they are the
 * ones where the reader's judgment is needed, regardless of how many models
 * weighed in.
 */
type ReportSection = AgreementTier | 'disputed';

function sectionOf(f: ConsensusFinding): ReportSection {
  return f.consensus.disputed ? 'disputed' : f.consensus.tier;
}

const SECTION_META: Record<ReportSection, { title: (totalModels: number) => string; intro: string }> = {
  unanimous: {
    title: (n) => `✅ Unanimous — all ${n} models`,
    intro: 'Every successful model independently flagged these. The strongest signal the council produces.',
  },
  majority: {
    title: () => '🤝 Majority — at least half of the models',
    intro: 'Independently confirmed across model families.',
  },
  minority: {
    title: () => '👥 Cross-model — 2+ models, under half',
    intro: 'Multiple models agree, but most of the fleet stayed silent.',
  },
  disputed: {
    title: () => '⚔️ Disputed — your judgment needed',
    intro: 'Reviewers reached materially different conclusions. Positions are shown per model; the council cannot settle these for you.',
  },
  single: {
    title: (n) => `👤 Single model — 1 of ${n} models`,
    intro: 'Seen by exactly one model. Weaker evidence — but sometimes one model is the only one that looked in the right place.',
  },
};

const SECTION_ORDER: ReportSection[] = ['unanimous', 'majority', 'minority', 'disputed', 'single'];

function buildFindingSection(finding: ConsensusFinding, index: number): string {
  const { consensus } = finding;
  const lines: string[] = [
    `### ${index + 1}. ${severityEmoji(finding.severity)} [${finding.severity.toUpperCase()}] ${sanitizeInline(finding.title)}`,
    '',
    `**File:** \`${finding.file}\` (lines ${finding.startLine}–${finding.endLine})`,
    `**Category:** ${finding.category}`,
    `**Confidence:** ${consensus.confidenceLabel} (${(consensus.confidence * 100).toFixed(0)}%)`,
    '',
    sanitizeBlock(finding.description),
  ];

  if (finding.suggestedFix) {
    lines.push('', '**Suggested Fix:**', '', fencedCodeBlock(finding.suggestedFix));
  }

  if (consensus.disputed && consensus.positions && consensus.positions.length > 0) {
    lines.push('', '**Positions:**', '');
    for (const pos of consensus.positions) {
      lines.push(
        `- **${sanitizeInline(pos.model)}** (${sanitizeInline(pos.role)}) rated **${pos.severity}**: ` +
          `${sanitizeInline(pos.title)} — ${sanitizeInline(pos.excerpt)}`
      );
    }
    if (consensus.disputeDetails) {
      lines.push('', `> ⚠ ${sanitizeInline(consensus.disputeDetails)}`);
    }
  }

  lines.push(
    '',
    `> Flagged by: ${consensus.roles.join(', ')} on ${consensus.models.join(', ')}` +
      (consensus.elevated
        ? ` | Elevated from \`${consensus.original_severity}\` (${consensus.elevation})`
        : '') +
      (consensus.disputed ? ' | ⚠ Disputed' : '')
  );

  return lines.join('\n');
}

/** Cap the rendered appendix; the JSON output always carries the full list. */
const APPENDIX_MAX_ENTRIES = 20;

function buildAppendix(dropped: ConsensusFinding[]): string[] {
  const lines: string[] = [
    `## 🕵️ Worth checking — below report thresholds (${dropped.length})`,
    '',
    'Findings that did not clear the confidence/consensus thresholds. Not counted',
    'in the summary above and never gate CI — but occasionally one model saw',
    'something real that the rest of the council missed.',
    '',
    '<details>',
    `<summary>Show ${Math.min(dropped.length, APPENDIX_MAX_ENTRIES)} of ${dropped.length}</summary>`,
    '',
  ];

  for (const f of dropped.slice(0, APPENDIX_MAX_ENTRIES)) {
    lines.push(
      `- ${severityEmoji(f.severity)} **[${f.severity}]** ${sanitizeInline(f.title)} — ` +
        `\`${sanitizeInline(f.file).replace(/`/g, '')}:${f.startLine}\` · ` +
        `${sanitizeInline(f.consensus.models.join(', '))} · ` +
        `confidence ${(f.consensus.confidence * 100).toFixed(0)}%`
    );
  }

  if (dropped.length > APPENDIX_MAX_ENTRIES) {
    lines.push(
      '',
      `…and ${dropped.length - APPENDIX_MAX_ENTRIES} more — see the JSON output (\`belowThresholdFindings\`) for the full list.`
    );
  }

  lines.push('', '</details>', '');
  return lines;
}

export function toMarkdown(result: ReviewResult): string {
  const { stats } = result;
  const totalModels = new Set(
    result.reviews.filter((r) => r.status === 'success').map((r) => r.model)
  ).size;

  const sections: string[] = [
    '# Review Council Report',
    '',
    `**Completed:** ${stats.successfulReviews}/${stats.totalReviews} reviewers · ` +
      `**${stats.totalDeduped}** unique findings (${stats.totalRawFindings} raw) · ` +
      `${(stats.durationMs / 1000).toFixed(1)}s`,
    '',
  ];

  // Summary counts
  const bySeverity: Record<string, ConsensusFinding[]> = {
    critical: [],
    important: [],
    minor: [],
    nitpick: [],
  };
  const bySection = new Map<ReportSection, ConsensusFinding[]>(
    SECTION_ORDER.map((s) => [s, []])
  );
  for (const f of result.findings) {
    bySeverity[f.severity]?.push(f);
    bySection.get(sectionOf(f))!.push(f);
  }

  sections.push('## Summary', '');
  sections.push('| Severity | Count |');
  sections.push('|:---------|------:|');
  for (const [sev, findings] of Object.entries(bySeverity)) {
    sections.push(`| ${severityEmoji(sev as ConsensusFinding['severity'])} ${sev} | ${findings.length} |`);
  }
  sections.push('');
  sections.push(
    '**Agreement:** ' +
      SECTION_ORDER.map((s) => `${bySection.get(s)!.length} ${s}`).join(' · ') +
      (result.belowThresholdFindings?.length
        ? ` · ${result.belowThresholdFindings.length} below thresholds`
        : '')
  );
  sections.push('');

  // Degraded coverage belongs next to the headline counts, not only in the
  // reviewers table: a lost reviewer means the finding lists below are
  // incomplete in a way no severity total can show.
  const parseFailed = result.reviews.filter((r) => r.status === 'parse_failed');
  const totalDropped = result.reviews.reduce((sum, r) => sum + (r.droppedFindings ?? 0), 0);
  // Either signal alone means degraded coverage. A reviewer whose response
  // carried no findings array at all is a total loss with a dropped count of
  // zero, so gating on the count would hide exactly that case (RCL-15).
  if (totalDropped > 0 || parseFailed.length > 0) {
    const lostRoles = parseFailed.map((r) => `${r.model}/${r.role}`).join(', ');
    sections.push(
      '> ⚠️ **Degraded coverage:** ' +
        [
          totalDropped > 0
            ? `${totalDropped} finding(s) could not be parsed and were discarded.`
            : null,
          parseFailed.length > 0
            ? `${parseFailed.length} reviewer(s) returned nothing usable and contributed no findings: ${lostRoles}.`
            : null,
        ]
          .filter(Boolean)
          .join(' ') +
        ' Treat the results below as incomplete.',
      ''
    );
  }

  // Reviewers table
  sections.push('## Reviewers', '');
  sections.push('| Model | Role | Status | Findings | Duration |');
  sections.push('|-------|------|--------|----------|----------|');
  for (const review of result.reviews) {
    const status =
      review.status === 'success'
        ? '✅'
        : review.status === 'timeout'
          ? '⏱️'
          : review.status === 'parse_failed'
            ? '⚠️'
            : review.status === 'canceled'
              ? '⊘'
              : '❌';
    // A dropped count beside the findings count is what tells a reader that
    // "3 findings" might have been 5 — degraded coverage, not a clean run.
    const dropped = review.droppedFindings ?? 0;
    const findingsCell =
      dropped > 0 ? `${review.findings.length} (${dropped} dropped)` : `${review.findings.length}`;
    sections.push(
      `| ${review.model} | ${review.role} | ${status} | ${findingsCell} | ${(review.durationMs / 1000).toFixed(1)}s |`
    );
  }
  sections.push('');

  // Findings by agreement tier — the report's organizing principle: the
  // reader triages strongest-consensus findings first, spends judgment on
  // disputes, and skims single-model catches last.
  for (const section of SECTION_ORDER) {
    const findings = bySection.get(section)!;
    if (findings.length === 0) continue;

    const meta = SECTION_META[section];
    sections.push(`## ${meta.title(totalModels)} (${findings.length})`, '');
    sections.push(`_${meta.intro}_`, '');

    findings.sort(bySeverityThenConfidence).forEach((f, i) => {
      sections.push(buildFindingSection(f, i));
      sections.push('');
    });
  }

  if (result.findings.length === 0) {
    if (result.belowThresholdFindings?.length) {
      sections.push(
        '## ✅ No Findings Above Report Thresholds',
        '',
        'Nothing cleared the confidence/consensus bar; the appendix below lists what fell under it.'
      );
    } else {
      sections.push('## ✅ No Issues Found', '', 'All reviewers returned clean results.');
    }
    sections.push('');
  }

  if (result.belowThresholdFindings && result.belowThresholdFindings.length > 0) {
    sections.push(...buildAppendix(result.belowThresholdFindings));
  }

  return sections.join('\n');
}

export async function writeMarkdownOutput(result: ReviewResult, path: string): Promise<void> {
  await writeFile(path, toMarkdown(result), 'utf-8');
}
