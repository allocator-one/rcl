import { Octokit } from '@octokit/rest';
import type { ConsensusFinding, ReviewResult } from '../consensus/types.js';
import type { PRMetadata, FileChange } from '../resolver/types.js';
import { sanitizeInline, sanitizeBlock, fencedCodeBlock } from './sanitize.js';

function buildCommentBody(finding: ConsensusFinding): string {
  const { consensus } = finding;
  const severityEmoji = {
    critical: '🔴',
    important: '🟡',
    minor: '🔵',
    nitpick: '⚪',
  }[finding.severity];

  const lines: string[] = [
    `### ${severityEmoji} ${finding.severity.toUpperCase()}: ${sanitizeInline(finding.title)}`,
    '',
    sanitizeBlock(finding.description),
  ];

  if (finding.suggestedFix) {
    lines.push('', '**Suggested Fix:**', fencedCodeBlock(finding.suggestedFix));
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

/**
 * The set of RIGHT-side (new file) line numbers that GitHub will accept as
 * inline-comment anchors: exactly the added/context lines a unified-diff
 * patch declares. GitHub rejects the ENTIRE review with a 422 if any single
 * comment targets a line outside this set, so unmappable findings must be
 * demoted to the summary rather than posted inline.
 */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const row of patch.split('\n')) {
    const header = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      newLine = parseInt(header[1]!, 10);
      continue;
    }
    if (row.startsWith('\\')) {
      // "\ No newline at end of file" — a marker, not a real line
      continue;
    }
    if (row.startsWith('+')) {
      lines.add(newLine);
      newLine++;
    } else if (row.startsWith('-')) {
      // deletion: consumes no new-file line
    } else {
      // context line advances the new-file counter but is also commentable
      lines.add(newLine);
      newLine++;
    }
  }
  return lines;
}

type Anchor = { line: number; snapped: boolean } | null;

/** Map a finding's line to the nearest commentable line within `maxSnap`. */
function resolveAnchor(
  startLine: number,
  commentable: Set<number>,
  maxSnap = 3
): Anchor {
  if (commentable.has(startLine)) return { line: startLine, snapped: false };
  let best: number | null = null;
  let bestDist = Infinity;
  for (const line of commentable) {
    const dist = Math.abs(line - startLine);
    if (dist < bestDist && dist <= maxSnap) {
      best = line;
      bestDist = dist;
    }
  }
  return best === null ? null : { line: best, snapped: true };
}

function buildSummaryComment(result: ReviewResult, demoted: ConsensusFinding[]): string {
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
          : sanitizeInline(review.error ?? review.status))
    );
  }

  // Findings that couldn't be anchored to a diff line go here, so a bad
  // line number never silently drops a finding.
  if (demoted.length > 0) {
    lines.push(
      '',
      '### Findings not anchored to a diff line',
      ..._demotedLines(demoted)
    );
  }

  return lines.join('\n');
}

function _demotedLines(demoted: ConsensusFinding[]): string[] {
  return demoted.flatMap((f) => [
    '',
    `#### ${f.severity.toUpperCase()}: ${sanitizeInline(f.title)} — \`${f.file}:${f.startLine}\``,
    sanitizeBlock(f.description),
  ]);
}

export async function postGitHubReview(
  result: ReviewResult,
  metadata: PRMetadata,
  token?: string,
  files?: FileChange[],
  octokitClient?: Octokit
): Promise<void> {
  const octokit =
    octokitClient ??
    new Octokit({
      auth: token ?? process.env['GITHUB_TOKEN'],
    });

  // Get the latest commit SHA for the PR
  const prResponse = await octokit.pulls.get({
    owner: metadata.owner,
    repo: metadata.repo,
    pull_number: metadata.number,
  });
  const commitSha = prResponse.data.head.sha;

  // Commentable RIGHT-side lines per file, from the diff patches.
  const commentableByFile = new Map<string, Set<number>>();
  for (const file of files ?? []) {
    if (file.patch) commentableByFile.set(file.filename, commentableLines(file.patch));
  }

  const inlineComments: Array<{ path: string; line: number; body: string }> = [];
  const demoted: ConsensusFinding[] = [];

  for (const finding of result.findings) {
    if (!finding.file || finding.startLine <= 0) {
      demoted.push(finding);
      continue;
    }
    const commentable = commentableByFile.get(finding.file);
    // With no patch info we can't validate — post inline as before and let
    // the createReview fallback catch a rejection.
    const anchor: Anchor = commentable
      ? resolveAnchor(finding.startLine, commentable)
      : { line: finding.startLine, snapped: false };

    if (anchor === null) {
      demoted.push(finding);
      continue;
    }
    inlineComments.push({
      path: finding.file,
      line: anchor.line,
      body: buildCommentBody(finding),
    });
  }

  const reviewBody = buildSummaryComment(result, demoted);

  try {
    await octokit.pulls.createReview({
      owner: metadata.owner,
      repo: metadata.repo,
      pull_number: metadata.number,
      commit_id: commitSha,
      body: reviewBody,
      event: 'COMMENT',
      comments: inlineComments,
    });
  } catch (err) {
    // A single bad anchor 422s the whole review. Never lose the summary:
    // retry once with no inline comments.
    if (inlineComments.length === 0) throw err;
    await octokit.pulls.createReview({
      owner: metadata.owner,
      repo: metadata.repo,
      pull_number: metadata.number,
      commit_id: commitSha,
      body:
        reviewBody +
        '\n\n> ⚠ Inline comments could not be posted (diff-anchor rejection); findings are summarized above.',
      event: 'COMMENT',
      comments: [],
    });
  }
}
