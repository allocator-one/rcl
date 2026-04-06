import chalk from 'chalk';
import type { ConsensusFinding, ReviewResult } from '../consensus/types.js';

const SEVERITY_COLORS = {
  critical: chalk.bgRed.white.bold,
  important: chalk.yellow.bold,
  minor: chalk.cyan,
  nitpick: chalk.gray,
};

const SEVERITY_ICONS = {
  critical: '🔴',
  important: '🟡',
  minor: '🔵',
  nitpick: '⚪',
};

const CONFIDENCE_COLORS = {
  'Very High': chalk.green.bold,
  High: chalk.green,
  Medium: chalk.yellow,
  Low: chalk.gray,
  Minimal: chalk.dim,
};

function confidenceBar(confidence: number): string {
  const bars = 10;
  const filled = Math.round(confidence * bars);
  const empty = bars - filled;
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

function severityBadge(severity: ConsensusFinding['severity']): string {
  const color = SEVERITY_COLORS[severity];
  return color(` ${severity.toUpperCase()} `);
}

function printDivider(width = 80): void {
  console.log(chalk.dim('─'.repeat(width)));
}

function printHeader(text: string, width = 80): void {
  const padded = ` ${text} `;
  const leftPad = Math.floor((width - padded.length) / 2);
  const rightPad = width - padded.length - leftPad;
  console.log(
    chalk.bold('═'.repeat(leftPad) + padded + '═'.repeat(rightPad))
  );
}

export function printReviewSummary(result: ReviewResult): void {
  console.log('');
  printHeader('REVIEW COUNCIL RESULTS');
  console.log('');

  const { stats } = result;
  console.log(
    chalk.bold('Reviews completed: ') +
      `${stats.successfulReviews}/${stats.totalReviews} ` +
      chalk.dim(`(${(stats.durationMs / 1000).toFixed(1)}s)`)
  );
  console.log(
    chalk.bold('Raw findings: ') +
      stats.totalRawFindings +
      chalk.dim(` → deduped to ${stats.totalDeduped}`)
  );
  console.log('');

  // Group by severity
  const bySeverity: Record<string, ConsensusFinding[]> = {
    critical: [],
    important: [],
    minor: [],
    nitpick: [],
  };
  for (const f of result.findings) {
    bySeverity[f.severity]?.push(f);
  }

  for (const severity of ['critical', 'important', 'minor', 'nitpick'] as const) {
    const findings = bySeverity[severity]!;
    if (findings.length === 0) continue;

    printDivider();
    console.log(
      SEVERITY_ICONS[severity] + ' ' +
        severityBadge(severity) +
        chalk.bold(` × ${findings.length}`)
    );
    console.log('');

    for (const finding of findings) {
      printFinding(finding);
    }
  }

  if (result.findings.length === 0) {
    printDivider();
    console.log(chalk.green.bold('\n✓ No issues found across all reviewers.\n'));
  }

  printDivider();
  printReviewerSummary(result);
  console.log('');
}

function printFinding(finding: ConsensusFinding): void {
  const { consensus } = finding;

  // Title line
  console.log(
    chalk.bold(`  ${finding.file}`) +
      chalk.dim(`:${finding.startLine}`) +
      (finding.endLine !== finding.startLine ? chalk.dim(`-${finding.endLine}`) : '')
  );
  console.log(`  ${chalk.bold(finding.title)}`);
  console.log('');

  // Description
  const descLines = finding.description.split('\n');
  for (const line of descLines) {
    console.log(`    ${chalk.white(line)}`);
  }
  console.log('');

  // Suggested fix
  if (finding.suggestedFix) {
    console.log(`    ${chalk.dim('Suggested fix:')}`);
    const fixLines = finding.suggestedFix.split('\n');
    for (const line of fixLines) {
      console.log(`    ${chalk.dim(line)}`);
    }
    console.log('');
  }

  // Consensus metadata
  const confColor = CONFIDENCE_COLORS[consensus.confidenceLabel];
  console.log(
    `    ${chalk.dim('Confidence:')} ${confColor(consensus.confidenceLabel)} ` +
      confidenceBar(consensus.confidence) +
      chalk.dim(` (${(consensus.confidence * 100).toFixed(0)}%)`)
  );

  if (consensus.elevated && consensus.original_severity) {
    console.log(
      `    ${chalk.dim('Elevated from:')} ${chalk.yellow(consensus.original_severity)} ` +
        chalk.dim(`[${consensus.elevation}]`)
    );
  }

  console.log(
    `    ${chalk.dim('Flagged by:')} ${consensus.roles.map((r) => chalk.cyan(r)).join(', ')}`
  );

  if (consensus.crossModel) {
    console.log(`    ${chalk.dim('Cross-model agreement:')} ${consensus.models.join(', ')}`);
  }

  if (consensus.disputed) {
    console.log(`    ${chalk.red('⚠ Disputed:')} ${chalk.dim(consensus.disputeDetails ?? '')}`);
  }

  console.log('');
}

function printReviewerSummary(result: ReviewResult): void {
  console.log(chalk.bold('\nReviewer Summary:'));
  console.log('');

  for (const review of result.reviews) {
    const statusIcon =
      review.status === 'success'
        ? chalk.green('✓')
        : review.status === 'timeout'
        ? chalk.yellow('⏱')
        : chalk.red('✗');

    const findingsStr =
      review.status === 'success'
        ? chalk.dim(`${review.findings.length} findings`)
        : chalk.red(review.error ?? review.status);

    console.log(
      `  ${statusIcon} ${chalk.bold(review.model)} ${chalk.dim('/')} ${chalk.cyan(review.role)} ` +
        chalk.dim(`(${(review.durationMs / 1000).toFixed(1)}s)`) +
        ` — ${findingsStr}`
    );
  }
}
