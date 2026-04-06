import { Octokit } from '@octokit/rest';
import type { ConsensusFinding, ReviewResult } from '../consensus/types.js';
import type { PRMetadata } from '../resolver/types.js';

function buildCommentBody(finding: ConsensusFinding): string {
  const { consensus } = finding;
  const severityEmoji = {
    critical: '🔴',
    important: '🟡',
    minor: '🔵',
    nitpick: '⚪',
  }[finding.severity];

  const lines: string[] = [
    `### ${severityEmoji} ${finding.severity.toUpperCase()}: ${finding.title}`,
    '',
    finding.description,
  ];

  if (finding.suggestedFix) {
    lines.push('', '**Suggested Fix:**', finding.suggestedFix);
  }

  lines.push(
    '',
    '---',
    `*Confidence: **${consensus.confidenceLabel}** (${(consensus.confidence * 100).toFixed(0)}%) · ` +
      `Flagged by: ${consensus.roles.join(', ')}` +
      (consensus.elevated
        ? ` · Elevated from \`${consensus.original_severity}\` [${consensus.elevation}]`
        : '') +
      '*'
  );

  return lines.join('\n');
}

function buildSummaryComment(result: ReviewResult): string {
  const { stats } = result;
  const lines: string[] = [
    '## 🔍 Review Council Report',
    '',
    `**${stats.successfulReviews}/${stats.totalReviews}** reviewers completed · ` +
      `**${stats.totalDeduped}** unique findings (from ${stats.totalRawFindings} raw)`,
    '',
  ];

  // Summary table
  const bySeverity: Record<string, number> = {
    critical: 0,
    important: 0,
    minor: 0,
    nitpick: 0,
  };
  for (const f of result.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }

  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');
  for (const [sev, count] of Object.entries(bySeverity)) {
    if (count > 0) {
      lines.push(`| ${sev} | ${count} |`);
    }
  }

  lines.push('', '### Reviewers');
  for (const review of result.reviews) {
    const icon = review.status === 'success' ? '✅' : review.status === 'timeout' ? '⏱️' : '❌';
    lines.push(
      `- ${icon} **${review.model}** / ${review.role}: ` +
        (review.status === 'success'
          ? `${review.findings.length} findings`
          : review.error ?? review.status)
    );
  }

  return lines.join('\n');
}

export async function postGitHubReview(
  result: ReviewResult,
  metadata: PRMetadata,
  token?: string
): Promise<void> {
  const octokit = new Octokit({
    auth: token ?? process.env['GITHUB_TOKEN'],
  });

  // Get the latest commit SHA for the PR
  const prResponse = await octokit.pulls.get({
    owner: metadata.owner,
    repo: metadata.repo,
    pull_number: metadata.number,
  });
  const commitSha = prResponse.data.head.sha;

  // Build inline review comments for findings with location info
  const inlineComments: Array<{
    path: string;
    line: number;
    body: string;
  }> = [];

  for (const finding of result.findings) {
    if (finding.file && finding.startLine > 0) {
      inlineComments.push({
        path: finding.file,
        line: finding.startLine,
        body: buildCommentBody(finding),
      });
    }
  }

  // Post review
  await octokit.pulls.createReview({
    owner: metadata.owner,
    repo: metadata.repo,
    pull_number: metadata.number,
    commit_id: commitSha,
    body: buildSummaryComment(result),
    event: 'COMMENT',
    comments: inlineComments,
  });
}
