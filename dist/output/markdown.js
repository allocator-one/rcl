import { writeFile } from 'fs/promises';
function severityEmoji(severity) {
    return { critical: '🔴', important: '🟡', minor: '🔵', nitpick: '⚪' }[severity];
}
function buildFindingSection(finding, index) {
    const { consensus } = finding;
    const lines = [
        `### ${index + 1}. ${severityEmoji(finding.severity)} [${finding.severity.toUpperCase()}] ${finding.title}`,
        '',
        `**File:** \`${finding.file}\` (lines ${finding.startLine}–${finding.endLine})`,
        `**Category:** ${finding.category}`,
        `**Confidence:** ${consensus.confidenceLabel} (${(consensus.confidence * 100).toFixed(0)}%)`,
        '',
        finding.description,
    ];
    if (finding.suggestedFix) {
        lines.push('', '**Suggested Fix:**', '', '```', finding.suggestedFix, '```');
    }
    lines.push('', `> Flagged by: ${consensus.roles.join(', ')} on ${consensus.models.join(', ')}` +
        (consensus.elevated
            ? ` | Elevated from \`${consensus.original_severity}\` (${consensus.elevation})`
            : '') +
        (consensus.disputed ? ' | ⚠ Disputed' : ''));
    return lines.join('\n');
}
export function toMarkdown(result) {
    const { stats } = result;
    const sections = [
        '# Review Council Report',
        '',
        `**Completed:** ${stats.successfulReviews}/${stats.totalReviews} reviewers · ` +
            `**${stats.totalDeduped}** unique findings (${stats.totalRawFindings} raw) · ` +
            `${(stats.durationMs / 1000).toFixed(1)}s`,
        '',
    ];
    // Summary counts
    const bySeverity = {
        critical: [],
        important: [],
        minor: [],
        nitpick: [],
    };
    for (const f of result.findings) {
        bySeverity[f.severity]?.push(f);
    }
    sections.push('## Summary', '');
    sections.push('| Severity | Count |');
    sections.push('|:---------|------:|');
    for (const [sev, findings] of Object.entries(bySeverity)) {
        sections.push(`| ${severityEmoji(sev)} ${sev} | ${findings.length} |`);
    }
    sections.push('');
    // Reviewers table
    sections.push('## Reviewers', '');
    sections.push('| Model | Role | Status | Findings | Duration |');
    sections.push('|-------|------|--------|----------|----------|');
    for (const review of result.reviews) {
        const status = review.status === 'success' ? '✅' : review.status === 'timeout' ? '⏱️' : '❌';
        sections.push(`| ${review.model} | ${review.role} | ${status} | ${review.findings.length} | ${(review.durationMs / 1000).toFixed(1)}s |`);
    }
    sections.push('');
    // Findings by severity
    for (const severity of ['critical', 'important', 'minor', 'nitpick']) {
        const findings = bySeverity[severity];
        if (findings.length === 0)
            continue;
        sections.push(`## ${severityEmoji(severity)} ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${findings.length})`, '');
        findings.forEach((f, i) => {
            sections.push(buildFindingSection(f, i));
            sections.push('');
        });
    }
    if (result.findings.length === 0) {
        sections.push('## ✅ No Issues Found', '', 'All reviewers returned clean results.');
    }
    return sections.join('\n');
}
export async function writeMarkdownOutput(result, path) {
    await writeFile(path, toMarkdown(result), 'utf-8');
}
//# sourceMappingURL=markdown.js.map