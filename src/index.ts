#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadConfig } from './config/loader.js';
import { applyHarnessModelKeys } from './config/harness.js';
import {
  DEFAULT_MODELS,
  DEFAULT_THRESHOLDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_ASYNC_TIMEOUT_MS,
  DEFAULT_QUORUM_FRACTION,
  DEFAULT_MAX_RETRIES,
  DEFAULT_CONCURRENCY,
  DEFAULT_REASONING_EFFORT,
} from './config/defaults.js';
import { parseGitHubTarget, fetchPRDiff } from './resolver/github.js';
import { loadLocalDiff } from './resolver/local.js';
import { loadGitDiff } from './resolver/git.js';
import { loadPlanAsDiff } from './resolver/plan.js';
import { isPlanFocus, PLAN_FOCUS_MODES, type PlanFocus } from './prompts/plan.js';
import { chunkDiff } from './prepare/chunker.js';
import { buildPrompt } from './prepare/prompt-builder.js';
import { BUILTIN_ROLES, getRoleByName } from './roles/builtin.js';
import { resolveRoles, loadProjectRulesContent } from './roles/loader.js';
import { buildAssignments, detectProvider } from './roles/dispatcher.js';
import { runReviews } from './dispatch/runner.js';
import { mergeChunkReviews } from './dispatch/merge.js';
import {
  partitionAsyncAssignments,
  asyncTargetKey,
  resolveAsyncStoreDir,
  spoolAsyncCalls,
  launchAsyncWorkers,
  runAsyncWorker,
  collectAsyncResults,
  currentBranchLabel,
  MAX_ASYNC_CALLS_PER_ROUND,
} from './dispatch/async-lane.js';
import { evaluateCiGate } from './ci.js';
import { deduplicateFindings } from './consensus/deduper.js';
import { computeConsensus, applyReportThresholds } from './consensus/voter.js';
import { applyGating, resolveGatingConfig } from './consensus/gating.js';
import { printReviewSummary } from './output/terminal.js';
import { postGitHubReview } from './output/github.js';
import { toJson, writeJsonOutput } from './output/json.js';
import { toMarkdown, writeMarkdownOutput } from './output/markdown.js';
import {
  buildCouncilRunPlan,
  CouncilProgressReporter,
  formatCouncilRunPlan,
} from './output/progress.js';
import {
  resolveFinding,
  buildDiscussPrompts,
  runDiscussion,
  loadContextDocs,
} from './discuss.js';
import type { ModelReview, ReviewResult } from './consensus/types.js';
import type { Config } from './config/schema.js';
import type { Role } from './roles/types.js';
import type { Diff } from './resolver/types.js';
import {
  DEFAULT_CONVERGE_ATTEMPT_CAP,
  claimConvergeAttempt,
  ConvergeAttemptBudgetExceededError,
  convergeAttemptErrorExitCode,
  ConvergeAttemptStateError,
  resolveGitCommonDir,
} from './converge/attempt-budget.js';
import {
  DEFAULT_CONVERGE_ROUND_CAP,
  HARD_CONVERGE_ROUND_CAP,
  processRoundReport,
  recordVerdicts,
  ConvergeRoundCapError,
  ConvergeRunStateError,
} from './converge/run-state.js';
import {
  appendCalls,
  appendOutcomes,
  loadModelStats,
  loadModelWeights,
  resolveDataDir,
  DEFAULT_WINDOW_DAYS,
  MIN_OUTCOMES_FOR_WEIGHT,
} from './models/stats-store.js';
import { buildSeedRecords } from './models/seed.js';

const program = new Command();

program
  .name('rcl')
  .description('Review Council — multi-model AI code review')
  .version(
    JSON.parse(
      await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
    ).version
  );

// review command
program
  .command('review [target]')
  .description(
    'Review a PR, local diff, or uncommitted work. Target: owner/repo#N, GitHub PR URL, or path to .patch file; or use --staged/--working-tree'
  )
  .option('--staged', 'Review staged changes (git diff --cached) instead of a target')
  .option('--working-tree', 'Review all uncommitted changes (git diff HEAD) instead of a target')
  .option('--role <name>', 'Use a single named role')
  .option('--roles <names>', 'Comma-separated list of roles')
  .option(
    '--reviewer <pair>',
    'Explicit model:role pair (repeatable)',
    (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    },
    [] as string[]
  )
  .option(
    '--context <path>',
    'Context file or directory to include (repeatable)',
    (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    },
    [] as string[]
  )
  .option('--spec <path>', 'Specification file for spec-compliance role')
  .option('--models <models>', 'Comma-separated list of primary (SOTA) models')
  .option('--secondary-models <models>', 'Comma-separated list of secondary models (specialized roles only)')
  .option('--async-models <models>', 'Comma-separated list of async (non-blocking) bonus reviewers')
  .option('--focus <areas>', 'Comma-separated focus areas')
  .option('--post', 'Post review as GitHub PR comment')
  .option('--json', 'Output JSON to stdout')
  .option('--json-file <path>', 'Write JSON output to file')
  .option('--markdown <path>', 'Write Markdown report to file')
  .option('--ci', 'CI mode: exit non-zero if critical/important findings')
  .option('--config <path>', 'Path to config file')
  .action(async (target: string | undefined, opts) => {
    await runReview(target, opts);
  });

// review-plan command
program
  .command('review-plan <file>')
  .description('Council-review an implementation plan document before code exists')
  .option('--focus <mode>', `Focus the review: ${PLAN_FOCUS_MODES.join(' | ')} (default: comprehensive)`)
  .option('--role <name>', 'Use a single named role')
  .option('--roles <names>', 'Comma-separated list of roles')
  .option(
    '--reviewer <pair>',
    'Explicit model:role pair (repeatable)',
    (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    },
    [] as string[]
  )
  .option(
    '--context <path>',
    'Context file or directory to include (repeatable)',
    (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    },
    [] as string[]
  )
  .option('--spec <path>', 'Specification the plan should satisfy (enables spec-compliance role)')
  .option('--models <models>', 'Comma-separated list of primary (SOTA) models')
  .option('--secondary-models <models>', 'Comma-separated list of secondary models (specialized roles only)')
  .option('--async-models <models>', 'Comma-separated list of async (non-blocking) bonus reviewers')
  .option('--json', 'Output JSON to stdout')
  .option('--json-file <path>', 'Write JSON output to file')
  .option('--markdown <path>', 'Write Markdown report to file')
  .option('--config <path>', 'Path to config file')
  .action(async (file: string, opts) => {
    await runPlanReview(file, opts);
  });

// discuss command
program
  .command('discuss <question>')
  .description('Ask the models that flagged a finding a follow-up question (one round, from a saved report)')
  .requiredOption('--report <path>', 'Report JSON from a previous review (--json-file)')
  .requiredOption('--finding <id>', 'Finding id from the report; use <id>:<n> if the id is ambiguous')
  .option('--models <models>', 'Override which models answer (comma-separated)')
  .option(
    '--context <path>',
    'Code or doc file to attach as context (repeatable)',
    (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    },
    [] as string[]
  )
  .option('--json', 'Output JSON to stdout')
  .option('--config <path>', 'Path to config file')
  .action(async (question: string, opts) => {
    await runDiscuss(question, opts);
  });

// Machine-enforced cost/safety guard used by the rcl-converge workflow.
program
  .command('converge-attempt')
  .description('Atomically consume one persisted rcl-converge attempt before starting a review')
  // Optional-value syntax is deliberate: Commander otherwise exits before
  // the action, preventing --json callers from receiving structured errors
  // for a missing value. The action enforces both values as required.
  .option('--target [key]', 'Required stable repository-and-PR/branch convergence target key')
  .option(
    '--max-attempts [n]',
    `Explicit per-target cap override (default ${DEFAULT_CONVERGE_ATTEMPT_CAP} for a new target)`
  )
  .option('--json', 'Output the claim as JSON')
  .action(
    async (opts: {
      target?: string | boolean;
      maxAttempts?: string | boolean;
      json?: boolean;
    }) => {
      try {
        if (typeof opts.target !== 'string' || opts.target.trim() === '') {
          throw new ConvergeAttemptStateError('--target is required.');
        }
        let maxAttempts: number | undefined;
        if (opts.maxAttempts !== undefined) {
          maxAttempts = typeof opts.maxAttempts === 'string' ? Number(opts.maxAttempts) : NaN;
          if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
            throw new ConvergeAttemptStateError(
              'maxAttempts (--max-attempts) must be a positive safe integer.'
            );
          }
        }
        const claim = await claimConvergeAttempt({
          gitCommonDir: await resolveGitCommonDir(),
          target: opts.target,
          maxAttempts,
        });
        if (opts.json) {
          console.log(JSON.stringify(claim));
        } else {
          console.log(
            `Convergence attempt ${claim.attempt}/${claim.cap} claimed for ${claim.target}. ` +
              `State: ${claim.stateFile}`
          );
          if (claim.warning) console.error(chalk.yellow(claim.warning));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          err instanceof ConvergeAttemptBudgetExceededError
            ? err.code
            : err instanceof ConvergeAttemptStateError
              ? err.code
              : 'RCL_CONVERGE_ATTEMPT_ERROR';
        if (opts.json) {
          console.error(
            JSON.stringify({
              error: {
                code,
                message,
                ...(err instanceof ConvergeAttemptBudgetExceededError
                  ? { attemptsUsed: err.attemptsUsed, cap: err.cap, target: err.target }
                  : {}),
              },
            })
          );
        } else {
          console.error(chalk.red(message));
        }
        // Exit 2 is the expected consent boundary. Exit 3 means accounting or
        // infrastructure failed and raising the cap is not the remediation.
        process.exitCode = convergeAttemptErrorExitCode(err);
      }
    }
  );

/** Gating reason for legacy reports without RCL-23 annotations. */
function findingGatingReason(f: {
  severity: string;
  gating?: { reason: string };
}): string {
  if (f.gating) return f.gating.reason;
  return f.severity === 'critical' || f.severity === 'important' ? 'legacy-blocking' : 'none';
}

// Cross-round finding identity + machine-enforced round cap (RCL-24).
program
  .command('converge-report')
  .description(
    'Dedupe a round report against the converge run state, enforce the round cap, and classify findings as new/repeat/suppressed/regating'
  )
  .option('--target [key]', 'Stable convergence target key (same key as converge-attempt)')
  .option('--report [path]', 'Round report JSON (a --json-file output)')
  .option('--round [n]', 'Evidence round number (1-based)')
  .option(
    '--max-rounds [n]',
    `Round cap override (default ${DEFAULT_CONVERGE_ROUND_CAP}, hard maximum ${HARD_CONVERGE_ROUND_CAP})`
  )
  .option('--json', 'Output JSON')
  .action(
    async (opts: {
      target?: string | boolean;
      report?: string | boolean;
      round?: string | boolean;
      maxRounds?: string | boolean;
      json?: boolean;
    }) => {
      try {
        if (typeof opts.target !== 'string' || opts.target.trim() === '') {
          throw new ConvergeRunStateError('--target is required.');
        }
        if (typeof opts.report !== 'string' || opts.report.trim() === '') {
          throw new ConvergeRunStateError('--report is required.');
        }
        const round = typeof opts.round === 'string' ? Number(opts.round) : NaN;
        if (!Number.isSafeInteger(round) || round < 1) {
          throw new ConvergeRunStateError('--round must be a positive integer.');
        }
        let maxRounds: number | undefined;
        if (opts.maxRounds !== undefined) {
          maxRounds = typeof opts.maxRounds === 'string' ? Number(opts.maxRounds) : NaN;
          if (!Number.isSafeInteger(maxRounds)) {
            throw new ConvergeRunStateError(
              `--max-rounds must be an integer between 2 and ${HARD_CONVERGE_ROUND_CAP}.`
            );
          }
        }

        let report: ReviewResult;
        try {
          report = JSON.parse(await readFile(opts.report, 'utf-8')) as ReviewResult;
        } catch (err) {
          throw new ConvergeRunStateError(`Could not read report JSON: ${opts.report}`, {
            cause: err,
          });
        }
        if (!Array.isArray(report.findings)) {
          throw new ConvergeRunStateError(`Not an rcl report (no findings array): ${opts.report}`);
        }

        const result = await processRoundReport({
          gitCommonDir: await resolveGitCommonDir(),
          target: opts.target,
          round,
          findings: report.findings,
          ...(maxRounds !== undefined ? { maxRounds } : {}),
        });

        const classified = result.findings.map((f) => ({
          identity: f.identity,
          status: f.status,
          gating: findingGatingReason(f.finding),
          severity: f.finding.severity,
          file: f.finding.file,
          startLine: f.finding.startLine,
          endLine: f.finding.endLine,
          title: f.finding.title,
          ...(f.suppressReason ? { suppressReason: f.suppressReason } : {}),
        }));
        const actionable = classified.filter(
          (f) => (f.status === 'new' || f.status === 'regating') && f.gating !== 'none'
        );

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                target: opts.target,
                round,
                roundCap: result.roundCap,
                counts: result.counts,
                actionableGating: actionable.length,
                findings: classified,
              },
              null,
              2
            )
          );
          return;
        }

        console.log(
          `Round ${round}/${result.roundCap} for ${opts.target}: ` +
            `${result.counts.new} new, ${result.counts.repeat} repeat, ` +
            `${result.counts.suppressed} suppressed, ${result.counts.regating} regating · ` +
            `${actionable.length} actionable gating finding(s)`
        );
        for (const f of actionable) {
          console.log(`  [${f.status}] ${f.identity} ${f.file}:${f.startLine} — ${f.title}`);
        }
        for (const f of classified.filter((c) => c.status === 'suppressed')) {
          console.log(
            chalk.dim(`  [suppressed] ${f.identity} ${f.file}:${f.startLine} — ${f.suppressReason}`)
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          const code =
            err instanceof ConvergeRoundCapError || err instanceof ConvergeRunStateError
              ? err.code
              : 'RCL_CONVERGE_REPORT_ERROR';
          console.error(JSON.stringify({ error: { code, message } }));
        } else {
          console.error(chalk.red(message));
        }
        // Exit 2 = round-cap consent boundary (mirrors converge-attempt);
        // exit 3 = state/infrastructure failure.
        process.exitCode = err instanceof ConvergeRoundCapError ? 2 : 3;
      }
    }
  );

// Record triage outcomes for finding identities (RCL-24; the precision
// history these verdicts build feeds RCL-27's model weighting).
program
  .command('converge-verdict')
  .description('Record fixed/dismissed triage verdicts for finding identities in the converge run state')
  .option('--target [key]', 'Stable convergence target key')
  .option('--round [n]', 'Evidence round the triage belongs to')
  .option(
    '--fixed <key>',
    'Finding identity verified and fixed (repeatable)',
    (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    },
    [] as string[]
  )
  .option(
    '--dismissed <key=reason>',
    'Finding identity dismissed, with reason (repeatable)',
    (val: string, prev: string[]) => {
      prev.push(val);
      return prev;
    },
    [] as string[]
  )
  .option('--json', 'Output JSON')
  .action(
    async (opts: {
      target?: string | boolean;
      round?: string | boolean;
      fixed: string[];
      dismissed: string[];
      json?: boolean;
    }) => {
      try {
        if (typeof opts.target !== 'string' || opts.target.trim() === '') {
          throw new ConvergeRunStateError('--target is required.');
        }
        const round = typeof opts.round === 'string' ? Number(opts.round) : NaN;
        if (!Number.isSafeInteger(round) || round < 1) {
          throw new ConvergeRunStateError('--round must be a positive integer.');
        }
        const verdicts = [
          ...opts.fixed.map((key) => ({ key, verdict: 'fixed' as const })),
          ...opts.dismissed.map((entry) => {
            const eq = entry.indexOf('=');
            return eq === -1
              ? { key: entry, verdict: 'dismissed' as const }
              : {
                  key: entry.slice(0, eq),
                  verdict: 'dismissed' as const,
                  reason: entry.slice(eq + 1),
                };
          }),
        ];
        if (verdicts.length === 0) {
          throw new ConvergeRunStateError('Nothing to record: pass --fixed and/or --dismissed.');
        }
        const updated = await recordVerdicts({
          gitCommonDir: await resolveGitCommonDir(),
          target: opts.target,
          round,
          verdicts,
        });
        // Feed the cross-run precision history (RCL-27) — fail-soft, the
        // verdicts above are already durably recorded.
        try {
          const ts = new Date().toISOString();
          await appendOutcomes(
            updated
              .filter((e) => e.verdict !== undefined && e.models.length > 0)
              .map((e) => ({
                ts,
                verdict: e.verdict!,
                models: e.models,
                severity: e.severity,
                target: opts.target as string,
                findingKey: e.key,
                source: 'live' as const,
              }))
          );
        } catch {
          // Advisory history; verdict recording must not fail over it.
        }
        if (opts.json) {
          console.log(JSON.stringify({ target: opts.target, round, recorded: verdicts.length }));
        } else {
          console.log(`Recorded ${verdicts.length} verdict(s) for ${opts.target} round ${round}.`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.error(JSON.stringify({ error: { code: 'RCL_CONVERGE_VERDICT', message } }));
        } else {
          console.error(chalk.red(message));
        }
        process.exitCode = 3;
      }
    }
  );

// Detached async-lane worker (RCL-25) — launched by the review process for
// each async (non-blocking) reviewer call; not for interactive use.
program
  .command('async-worker', { hidden: true })
  .requiredOption('--spool <path>', 'Spool file written by the launching review')
  .action(async (opts: { spool: string }) => {
    try {
      await runAsyncWorker(opts.spool);
    } catch {
      // Nothing is awaiting this process; a failed worker simply leaves no
      // result to merge. Exit non-zero for post-mortem visibility only.
      process.exitCode = 1;
    }
  });

// Per-model triage history (RCL-27): trailing precision, volume, latency,
// dead-call rate, and the consensus weight each model earns from them.
const modelsCmd = program
  .command('models')
  .description('Per-model trailing precision, volume, latency, dead-call rate, and consensus weight');

modelsCmd
  .command('show', { isDefault: true })
  .description(`Print per-model stats over the trailing window (default ${DEFAULT_WINDOW_DAYS} days)`)
  .option('--window <days>', 'Trailing window in days', String(DEFAULT_WINDOW_DAYS))
  .option('--json', 'Output JSON')
  .action(async (opts: { window: string; json?: boolean }) => {
    const windowDays = Number(opts.window);
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      console.error(chalk.red('--window must be a positive number of days.'));
      process.exitCode = 1;
      return;
    }
    const stats = await loadModelStats({ windowDays });
    if (opts.json) {
      console.log(JSON.stringify({ windowDays, dataDir: resolveDataDir(), models: stats }, null, 2));
      return;
    }
    if (stats.length === 0) {
      console.log(
        `No model history in ${resolveDataDir()} yet. Converge runs record it automatically; ` +
          'seed from recovered artifacts with `rcl models seed --from <dir>`.'
      );
      return;
    }
    console.log('\n' + chalk.bold(`Model history — trailing ${windowDays} days`) + '\n');
    const pct = (v: number | undefined): string => (v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
    console.log(
      chalk.dim(
        'model'.padEnd(46) +
          'precision (n)'.padEnd(16) +
          'calls'.padEnd(8) +
          'dead'.padEnd(7) +
          'p50'.padEnd(8) +
          'weight'
      )
    );
    for (const s of stats) {
      const precision =
        s.outcomes > 0 ? `${pct(s.precision)} (${s.outcomes})` : '— (0)';
      const weightNote = s.outcomes < MIN_OUTCOMES_FOR_WEIGHT ? ' (neutral)' : '';
      console.log(
        s.model.padEnd(46) +
          precision.padEnd(16) +
          String(s.calls).padEnd(8) +
          pct(s.deadRate).padEnd(7) +
          (s.p50Ms !== undefined ? `${(s.p50Ms / 1000).toFixed(0)}s` : '—').padEnd(8) +
          s.weight.toFixed(2) +
          chalk.dim(weightNote)
      );
    }
    console.log(
      chalk.dim(
        `\nWeights (0.5 + precision, clamped to [0.5, 1.5]; neutral 1 under ${MIN_OUTCOMES_FOR_WEIGHT} outcomes) ` +
          'scale each model’s consensus vote in reviews and gating.\n'
      )
    );
  });

modelsCmd
  .command('seed')
  .description('Backfill the model-stats store from a directory of rcl reports and converge ledgers')
  .requiredOption('--from <dir>', 'Directory holding rcl-report-*.json and rcl-converge-*-ledger.md files')
  .option('--json', 'Output JSON')
  .action(async (opts: { from: string; json?: boolean }) => {
    try {
      const { calls, outcomes, ...summary } = await buildSeedRecords(opts.from);
      await appendCalls(calls);
      await appendOutcomes(outcomes);
      if (opts.json) {
        console.log(JSON.stringify({ ...summary, dataDir: resolveDataDir() }, null, 2));
      } else {
        console.log(
          `Seeded ${summary.callsSeeded} call record(s) from ${summary.reportsScanned} report(s) and ` +
            `${summary.outcomesSeeded} outcome record(s) from ${summary.ledgersScanned} ledger(s) ` +
            `(${summary.unmatchedBullets}/${summary.bullets} ledger bullets could not be matched) → ${resolveDataDir()}`
        );
      }
    } catch (err) {
      console.error(chalk.red(`Seed failed: ${err instanceof Error ? err.message : String(err)}`));
      process.exitCode = 1;
    }
  });

// roles subcommand
const rolesCmd = program.command('roles').description('Manage and inspect roles');

rolesCmd
  .command('list')
  .description('List all built-in roles')
  .action(() => {
    console.log('\n' + chalk.bold('Built-in Roles:') + '\n');
    for (const role of BUILTIN_ROLES) {
      const tag = role.isSpecialized ? chalk.dim('[specialized]') : chalk.blue('[general]');
      console.log(
        `  ${chalk.cyan(role.name.padEnd(22))} ${tag}  ${chalk.dim(role.description)}`
      );
    }
    console.log('');
  });

rolesCmd
  .command('show <name>')
  .description('Show details for a specific role')
  .action((name: string) => {
    const role = getRoleByName(name);
    if (!role) {
      console.error(chalk.red(`Role "${name}" not found.`));
      console.log('Run `rcl roles list` to see available roles.');
      process.exit(1);
    }

    console.log('\n' + chalk.bold(`Role: ${role.name}`) + '\n');
    console.log(chalk.dim('Description:'), role.description);
    console.log(chalk.dim('Type:'), role.isSpecialized ? 'specialized' : 'general');
    console.log(chalk.dim('Focus:'), role.focus.join(', '));
    if (role.severityBias) {
      console.log(chalk.dim('Severity bias:'), JSON.stringify(role.severityBias));
    }
    console.log('\n' + chalk.dim('System Prompt:'));
    console.log(role.systemPrompt);
    console.log('');
  });

type Spinner = ReturnType<typeof ora>;

/** CLI options shared by every council-running command. */
interface CouncilCliOpts {
  role?: string;
  roles?: string;
  reviewer?: string[];
  context?: string[];
  spec?: string;
  models?: string;
  secondaryModels?: string;
  asyncModels?: string;
  post?: boolean;
  json?: boolean;
  jsonFile?: string;
  markdown?: string;
  ci?: boolean;
  config?: string;
}

interface PreparedCouncil {
  config: Config;
  roleMap: Map<string, Role>;
  assignments: ReturnType<typeof buildAssignments>;
  /** Async bonus reviewers — fired with the round, never awaited (RCL-25). */
  asyncAssignments: ReturnType<typeof buildAssignments>;
  /** Resolved early so a bad gating config fails BEFORE the council spends. */
  gatingConfig: ReturnType<typeof resolveGatingConfig>;
  contextFiles: string[];
}

/**
 * Shared front half of every council command: config, role resolution,
 * assignments. `fallbackRoles` is used only when neither CLI flags nor
 * config request roles (plan review defaults to a plan-suited subset).
 */
/**
 * Harness key distribution runs BEFORE loadConfig: the loader's default-fleet
 * degradation (dropping openrouter models without OPENROUTER_API_KEY) must
 * see any injected keys.
 */
async function fetchHarnessKeys(spinner: Spinner): Promise<void> {
  const { note } = await applyHarnessModelKeys();
  if (note) {
    spinner.info(note);
    spinner.start('Loading configuration...');
  }
}

async function prepareCouncil(
  spinner: Spinner,
  opts: CouncilCliOpts,
  fallbackRoles?: string[]
): Promise<PreparedCouncil> {
  await fetchHarnessKeys(spinner);
  const config = await loadConfig(opts.config);

  // Validate mutually exclusive role options
  const roleOptionCount = [opts.role, opts.roles, opts.reviewer?.length].filter(Boolean).length;
  if (roleOptionCount > 1) {
    spinner.fail('--role, --roles, and --reviewer are mutually exclusive');
    process.exit(1);
  }

  // Override models from CLI
  if (opts.models) {
    config.models = opts.models.split(',').map((s) => s.trim()).filter(Boolean);
    // Clear secondary and async models unless explicitly provided — don't
    // leak code to default providers the user overrode away from.
    if (opts.secondaryModels === undefined) {
      config.secondaryModels = [];
    }
    if (opts.asyncModels === undefined) {
      config.asyncModels = [];
    }
  }
  if (opts.secondaryModels !== undefined) {
    config.secondaryModels = opts.secondaryModels.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (opts.asyncModels !== undefined) {
    config.asyncModels = opts.asyncModels.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Determine roles to use
  let requestedRoles: string[] | undefined;
  let explicitReviewers: Array<{ model: string; role: string }> | undefined;

  if (opts.role) {
    requestedRoles = [opts.role];
  } else if (opts.roles) {
    requestedRoles = opts.roles.split(',').map((s) => s.trim());
  } else if (opts.reviewer && opts.reviewer.length > 0) {
    explicitReviewers = opts.reviewer.map((pair) => {
      const colonIdx = pair.indexOf(':');
      if (colonIdx < 0) {
        throw new InvalidArgumentError(`Invalid reviewer pair "${pair}". Use model:role format.`);
      }
      return {
        model: pair.slice(0, colonIdx),
        role: pair.slice(colonIdx + 1),
      };
    });
  } else if (fallbackRoles && !config.roles?.length) {
    requestedRoles = fallbackRoles;
  }

  // Load spec file
  let specContent: string | undefined;
  const specPath = opts.spec ?? config.spec;
  if (specPath) {
    try {
      specContent = await readFile(specPath, 'utf-8');
    } catch {
      spinner.warn(`Could not read spec file: ${specPath}`);
    }
  }

  // A resolved spec makes the spec-compliance role useful for plan review
  // too — the plan gets checked against the higher-level spec.
  if (requestedRoles === fallbackRoles && requestedRoles && specContent) {
    requestedRoles = [...requestedRoles, 'spec-compliance'];
  }

  // Load project rules
  const projectRulesContent = await loadProjectRulesContent();

  // Resolve roles
  const roles = await resolveRoles(
    config,
    requestedRoles,
    projectRulesContent ?? undefined,
    specContent
  );

  if (roles.length === 0) {
    spinner.fail('No roles resolved. Check your --role/--roles flags.');
    process.exit(1);
  }

  // Build role map for voter
  const roleMap = new Map<string, Role>();
  for (const role of roles) {
    roleMap.set(role.name, role);
  }

  const models = config.models ?? [...DEFAULT_MODELS];
  const secondaryModels = config.secondaryModels ?? [];
  const built = buildAssignments({
    models,
    roles,
    secondaryModels,
    explicitReviewers,
    roleMap,
  });

  // Async lane (RCL-25): async models run the general role(s) only.
  // Membership in `models` wins over `asyncModels` — an explicit blocking
  // seat is an explicit choice, so the model stays blocking and gets no
  // duplicate async seat. Async models appearing only in `secondaryModels`
  // are partitioned OUT of the blocking path below. Explicit --reviewer
  // pairs mean exact manual control: every pair runs as given — even a
  // model that is usually async — and no bonus seats are added, so the
  // async roster must not partition pairs away.
  const asyncModels = explicitReviewers
    ? []
    : (config.asyncModels ?? []).filter((m) => !models.includes(m));
  const { blocking: assignments } = partitionAsyncAssignments(built, asyncModels);
  const generalRoles = roles.filter((r) => !r.isSpecialized);
  const asyncAssignments =
    explicitReviewers || asyncModels.length === 0 || generalRoles.length === 0
      ? []
      : buildAssignments({ models: asyncModels, roles: generalRoles, roleMap });

  const contextFiles = [...(opts.context ?? []), ...(config.context ?? [])];

  // Resolve gating now: a config error (e.g. an aggregator-routed verifier)
  // must fail before any model time is spent, and the verifier is chosen
  // under roster containment — never a provider outside the configured fleet.
  const gatingConfig = resolveGatingConfig(config.gating, [
    ...models,
    ...secondaryModels,
    ...(config.asyncModels ?? []),
  ]);

  return { config, roleMap, assignments, asyncAssignments, gatingConfig, contextFiles };
}

async function runReview(target: string | undefined, opts: CouncilCliOpts & {
  staged?: boolean;
  workingTree?: boolean;
  focus?: string;
}): Promise<void> {
  const spinner = ora('Loading configuration...').start();

  try {
    // Exactly one review source: a positional target, --staged, or --working-tree
    const sourceCount = [target, opts.staged, opts.workingTree].filter(Boolean).length;
    if (sourceCount === 0) {
      spinner.fail('Missing review target. Provide owner/repo#N, a patch file, --staged, or --working-tree.');
      process.exit(1);
    }
    if (sourceCount > 1) {
      spinner.fail('A positional target, --staged, and --working-tree are mutually exclusive');
      process.exit(1);
    }

    const prepared = await prepareCouncil(spinner, opts);
    const { config } = prepared;

    const gitMode = opts.staged ? 'staged' : opts.workingTree ? 'working-tree' : undefined;
    spinner.text = `Resolving diff for: ${target ?? `--${gitMode}`}`;

    // Resolve diff
    let diff;
    if (gitMode) {
      diff = await loadGitDiff(gitMode);
    } else if (
      target!.endsWith('.patch') ||
      target!.endsWith('.diff') ||
      target!.startsWith('./') ||
      target!.startsWith('/')
    ) {
      diff = await loadLocalDiff(target!);
    } else {
      const prTarget = parseGitHubTarget(target!);
      diff = await fetchPRDiff(prTarget, config.githubToken);
    }

    if (diff.files.length === 0) {
      spinner.warn(
        gitMode === 'staged'
          ? 'No staged changes to review.'
          : gitMode === 'working-tree'
            ? 'No uncommitted changes to review.'
            : 'No files found in diff. Nothing to review.'
      );
      process.exit(0);
    }

    // Stable across rounds of the same converge run, so round N+1 finds the
    // async results round N fired. Git modes carry the branch name so two
    // branches reviewed in one repository never exchange async results.
    const asyncTargetLabel = diff.metadata
      ? `${diff.metadata.owner}/${diff.metadata.repo}#${diff.metadata.number}`
      : (target ?? `git-${gitMode}-${await currentBranchLabel()}`);

    await executeCouncil(spinner, prepared, diff, opts, { asyncTargetLabel });
  } catch (err) {
    spinner.fail(String(err));
    if (process.env['RCL_DEBUG']) {
      console.error(err);
    }
    process.exit(1);
  }
}

/**
 * Shared back half of every council command: chunking, prompt building,
 * dispatch, consensus, and every output surface.
 */
async function executeCouncil(
  spinner: Spinner,
  prepared: PreparedCouncil,
  diff: Diff,
  opts: CouncilCliOpts,
  extra?: { focus?: PlanFocus; asyncTargetLabel?: string }
): Promise<void> {
  const { config, roleMap, assignments, asyncAssignments, contextFiles } = prepared;
  const planContext = extra?.focus !== undefined ? { focus: extra.focus } : undefined;

  // Chunk the diff
  const chunks = chunkDiff(diff.files);

  spinner.text = `Building prompts (${chunks.length} chunk(s), ${assignments.length} reviewer(s))...`;

  // Fan out every assignment across every chunk so the whole diff is
  // reviewed, not just the first ~2000 lines. The spec is NOT passed as a
  // context doc: resolveRoles already embeds it in the spec-compliance
  // role's system prompt, and duplicating it doubled that reviewer's cost.
  const chunkAssignments = chunks.flatMap((chunk) =>
    assignments.map((assignment) => ({ assignment, chunk }))
  );
  const prompts = await Promise.all(
    chunkAssignments.map(({ assignment, chunk }) =>
      buildPrompt(chunk, assignment.role, {
        contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
        plan: planContext,
      })
    )
  );

  // Async lane (RCL-25): fire the async reviewers with the round, never
  // await them; collect whatever arrived from earlier rounds after the
  // blocking council returns. Best-effort by design — a broken lane must
  // never fail or slow the blocking round.
  const asyncTargetLabel = extra?.asyncTargetLabel;
  let asyncStoreDir: string | undefined;
  let asyncKey: string | undefined;
  let asyncLaunched = 0;
  if (
    asyncTargetLabel !== undefined &&
    (asyncAssignments.length > 0 || (config.asyncModels?.length ?? 0) > 0)
  ) {
    try {
      asyncStoreDir = await resolveAsyncStoreDir();
      asyncKey = asyncTargetKey(asyncTargetLabel);
      let asyncChunkAssignments = chunks.flatMap((chunk) =>
        asyncAssignments.map((assignment) => ({ assignment, chunk }))
      );
      if (asyncChunkAssignments.length > MAX_ASYNC_CALLS_PER_ROUND) {
        console.warn(
          `Async lane: capping ${asyncChunkAssignments.length} async calls at ` +
            `${MAX_ASYNC_CALLS_PER_ROUND} (one detached process each); the rest are dropped.`
        );
        asyncChunkAssignments = asyncChunkAssignments.slice(0, MAX_ASYNC_CALLS_PER_ROUND);
      }
      if (asyncChunkAssignments.length > 0) {
        const asyncPrompts = await Promise.all(
          asyncChunkAssignments.map(({ assignment, chunk }) =>
            buildPrompt(chunk, assignment.role, {
              contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
              plan: planContext,
            })
          )
        );
        const spools = await spoolAsyncCalls(
          asyncChunkAssignments.map(({ assignment }, i) => ({
            model: assignment.model,
            role: assignment.role.name,
            provider: assignment.provider,
            systemPrompt: asyncPrompts[i]!.systemPrompt,
            userPrompt: asyncPrompts[i]!.userPrompt,
          })),
          {
            storeDir: asyncStoreDir,
            targetKey: asyncKey,
            timeoutMs: config.asyncTimeout ?? DEFAULT_ASYNC_TIMEOUT_MS,
            maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
            reasoningEffort: config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
          }
        );
        launchAsyncWorkers(spools);
        asyncLaunched = spools.length;
      }
    } catch (err) {
      console.warn(`Async reviewer lane unavailable: ${String(err)}`);
      asyncStoreDir = undefined;
    }
  }

  const startTime = Date.now();
  const totalCalls = chunkAssignments.length;
  const timeoutMs = config.timeout ?? DEFAULT_TIMEOUT_MS;
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const runPlan = buildCouncilRunPlan({
    totalCalls,
    reviewers: assignments.length,
    chunks: chunks.length,
    concurrency,
    timeoutMs,
  });
  const planText = formatCouncilRunPlan(runPlan);
  const interactive = process.stderr.isTTY === true;
  if (interactive) {
    spinner.text = planText;
    spinner.start();
  } else {
    spinner.stop();
    process.stderr.write(`${planText}\n`);
  }

  const progress = new CouncilProgressReporter({
    totalCalls,
    interactive,
    updateInteractive: (text) => {
      spinner.text = text;
    },
    writeLine: (text) => {
      process.stderr.write(`${text}\n`);
    },
  });
  progress.start();

  let chunkReviews: ModelReview[];
  try {
    chunkReviews = await runReviews(
      chunkAssignments.map((ca) => ca.assignment),
      prompts,
      {
        // Fall back to the shared constants, never to inline literals:
        // duplicated defaults drift (this read 120_000 after the default
        // moved to 600_000).
        timeoutMs,
        maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
        concurrency,
        reasoningEffort: config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
        // Quorum closure (RCL-26): the round stops waiting once the quorum
        // fraction of calls has completed; the blocking council's own models
        // are core and never canceled.
        quorum: {
          fraction: config.quorumFraction ?? DEFAULT_QUORUM_FRACTION,
          coreModels: config.models ?? DEFAULT_MODELS,
        },
        onReviewComplete: (review) => progress.complete(review),
      }
    );
  } finally {
    progress.stop();
  }

  // Merge async results that have arrived from earlier rounds of this
  // target (marked async), then collapse per-chunk reviews back to one per
  // (model, role) reviewer.
  let arrivedAsync: ModelReview[] = [];
  if (asyncStoreDir && asyncKey) {
    try {
      arrivedAsync = await collectAsyncResults(asyncStoreDir, asyncKey);
    } catch (err) {
      console.warn(`Could not collect async reviewer results: ${String(err)}`);
    }
  }
  const reviews = mergeChunkReviews([...chunkReviews, ...arrivedAsync]);

  // RCL-27: every call feeds the cross-run model history (fail-soft — the
  // stats store must never break a review).
  try {
    const ts = new Date().toISOString();
    await appendCalls(
      [...chunkReviews, ...arrivedAsync].map((r) => ({
        ts,
        model: r.model,
        role: r.role,
        durationMs: r.durationMs,
        status: r.status,
        source: 'live' as const,
      }))
    );
  } catch {
    // Stats are advisory; reviews must not fail over them.
  }

  // Trailing-precision weights scale each model's consensus vote. An empty
  // history means no weighting (and no weight noise in the report).
  let modelWeights: Map<string, number> | undefined;
  try {
    const loaded = await loadModelWeights();
    if (loaded.size > 0) modelWeights = loaded;
  } catch {
    modelWeights = undefined;
  }

  spinner.text = 'Computing consensus...';

  // Deduplicate and compute consensus
  const groups = deduplicateFindings(
    reviews,
    config.thresholds?.jaccardThreshold ?? DEFAULT_THRESHOLDS.jaccardThreshold,
    config.thresholds?.dedupeLineWindow ?? DEFAULT_THRESHOLDS.dedupeLineWindow,
    config.thresholds?.minConsensusScore ?? DEFAULT_THRESHOLDS.minConsensusScore
  );

  const consensusFindings = computeConsensus(
    groups,
    reviews,
    roleMap,
    {
      lineWindow: config.thresholds?.dedupeLineWindow,
      jaccardThreshold: config.thresholds?.jaccardThreshold,
    },
    modelWeights
  );

  const { kept: reportFindings, dropped: droppedFindings } = applyReportThresholds(
    consensusFindings,
    {
      minConfidence: config.thresholds?.minConfidence,
      minConsensusScore: config.thresholds?.minConsensusScore,
    }
  );

  // Convergence gating (RCL-23): annotate every kept finding with why it
  // does or does not gate; single-model blocking findings get one batched
  // refutation call to a fast direct-API model.
  const { gatingConfig } = prepared;
  let finalFindings = reportFindings;
  let gatedAppendix = droppedFindings;
  let verificationStats: ReviewResult['stats']['verification'];
  if (gatingConfig.mode === 'verified-consensus') {
    spinner.text = 'Verifying single-model findings...';
    try {
      const gated = await applyGating(reportFindings, {
        minModels: gatingConfig.minModels,
        verificationModel: gatingConfig.verificationModel,
        verificationTimeoutMs: gatingConfig.verificationTimeoutMs,
        diffFiles: diff.files,
        ...(modelWeights ? { modelWeights } : {}),
      });
      finalFindings = gated.findings;
      verificationStats = gated.verification;
      // Appendix findings never block convergence; mark them so the report
      // JSON carries a gating reason on every finding.
      gatedAppendix = droppedFindings.map((f) => ({ ...f, gating: { reason: 'none' as const } }));
    } catch (err) {
      // Never abort a completed council run over the gating pass — fall
      // back to unannotated findings, which the CI gate reads with the
      // stricter legacy severity rule.
      console.warn(
        `Gating pass failed (${String(err)}); falling back to severity gating for this round.`
      );
    }
  }

  const keepAppendix = config.output?.belowThresholdAppendix ?? true;
  const totalRawFindings = reviews.reduce((sum, r) => sum + r.findings.length, 0);
  const result: ReviewResult = {
    reviews,
    findings: finalFindings,
    ...(keepAppendix && gatedAppendix.length > 0
      ? { belowThresholdFindings: gatedAppendix }
      : {}),
    stats: {
      totalReviews: reviews.length,
      successfulReviews: reviews.filter((r) => r.status === 'success').length,
      totalRawFindings,
      totalDeduped: consensusFindings.length,
      belowThreshold: droppedFindings.length,
      durationMs: Date.now() - startTime,
      ...(asyncLaunched > 0 ? { asyncLaunched } : {}),
      ...(arrivedAsync.length > 0
        ? { asyncMerged: mergeChunkReviews(arrivedAsync).length }
        : {}),
      // Per-call (pre-merge) so a straggler canceled on one chunk stays
      // visible even when its other chunks succeeded.
      ...(chunkReviews.some((r) => r.status === 'canceled')
        ? {
            canceledCalls: chunkReviews
              .filter((r) => r.status === 'canceled')
              .map((r) => ({ model: r.model, role: r.role, elapsedMs: r.durationMs })),
          }
        : {}),
      ...(verificationStats ? { verification: verificationStats } : {}),
      // Applied weights for this run's models, so the report shows what
      // scaled the votes (RCL-27).
      ...(modelWeights
        ? {
            modelWeights: Object.fromEntries(
              [...new Set(reviews.map((r) => r.model))].map((m) => [
                m,
                modelWeights.get(m) ?? 1,
              ])
            ),
          }
        : {}),
    },
  };

  spinner.succeed('Review complete');
  // Status lines go to stderr: stdout may be a machine-read JSON stream
  // (`--json | jq`), which a stray status line would corrupt.
  if (asyncLaunched > 0) {
    process.stderr.write(
      chalk.dim(
        `Fired ${asyncLaunched} async reviewer call(s) — results merge into the next round of this target.`
      ) + '\n'
    );
  }
  if (arrivedAsync.length > 0) {
    process.stderr.write(
      chalk.dim(
        `Merged ${mergeChunkReviews(arrivedAsync).length} async reviewer result(s) from an earlier round.`
      ) + '\n'
    );
  }

  // Output
  if (opts.json) {
    console.log(toJson(result));
  } else {
    printReviewSummary(result);
  }

  if (opts.jsonFile) {
    await writeJsonOutput(result, opts.jsonFile);
    console.log(chalk.dim(`JSON written to: ${opts.jsonFile}`));
  }

  if (opts.markdown) {
    await writeMarkdownOutput(result, opts.markdown);
    console.log(chalk.dim(`Markdown written to: ${opts.markdown}`));
  }

  if (opts.post && !diff.metadata) {
    console.log(chalk.yellow('--post ignored: no PR to post to for a local diff.'));
  }
  if (opts.post && diff.metadata) {
    const postSpinner = ora('Posting review to GitHub...').start();
    try {
      await postGitHubReview(result, diff.metadata, config.githubToken, diff.files);
      postSpinner.succeed('Review posted to GitHub');
    } catch (err) {
      postSpinner.fail(`Failed to post to GitHub: ${String(err)}`);
    }
  }

  // CI mode: fail on a fully-failed run or on blocking findings
  if (opts.ci) {
    const verdict = evaluateCiGate(result);
    if (verdict.exitCode !== 0) {
      console.error(chalk.red(`\n${verdict.message}`));
      process.exit(verdict.exitCode);
    }
    }
}

async function runDiscuss(
  question: string,
  opts: {
    report: string;
    finding: string;
    models?: string;
    context?: string[];
    json?: boolean;
    config?: string;
  }
): Promise<void> {
  const spinner = ora('Loading report...').start();

  try {
    await fetchHarnessKeys(spinner);
    const config = await loadConfig(opts.config);

    let result: ReviewResult;
    try {
      result = JSON.parse(await readFile(opts.report, 'utf-8')) as ReviewResult;
    } catch {
      throw new Error(`Could not read report JSON: ${opts.report}`);
    }
    if (!Array.isArray(result.findings)) {
      throw new Error(`Not an rcl report (no findings array): ${opts.report}`);
    }

    const finding = resolveFinding(result, opts.finding);
    const models = opts.models
      ? opts.models.split(',').map((s) => s.trim()).filter(Boolean)
      : finding.consensus.models;
    if (models.length === 0) {
      throw new Error('No models to ask: the finding lists none and --models was not given.');
    }

    const contextDocs = await loadContextDocs(opts.context ?? []);
    const prompts = buildDiscussPrompts({ finding, question, contextDocs });

    spinner.text = `Asking ${models.length} model(s) about "${finding.title.slice(0, 60)}"...`;

    const answers = await runDiscussion(models, prompts, {
      timeoutMs: config.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      reasoningEffort: config.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    });

    spinner.succeed(`Discussion complete (${answers.filter((a) => a.status === 'success').length}/${answers.length} answered)`);

    if (opts.json) {
      console.log(JSON.stringify({ finding: { id: finding.id, file: finding.file, title: finding.title }, question, answers }, null, 2));
      return;
    }

    console.log('');
    console.log(chalk.bold(`Finding: `) + `${finding.title}`);
    console.log(chalk.dim(`${finding.file}:${finding.startLine}–${finding.endLine} · ${finding.severity} · ${finding.consensus.disputed ? 'disputed' : finding.consensus.tier}`));
    console.log(chalk.bold(`Question: `) + question);

    for (const answer of answers) {
      console.log('');
      console.log(chalk.dim('─'.repeat(80)));
      if (answer.status === 'success') {
        console.log(chalk.cyan.bold(answer.model) + chalk.dim(` (${(answer.durationMs / 1000).toFixed(1)}s)`));
        console.log('');
        console.log(answer.text);
      } else {
        console.log(
          chalk.cyan.bold(answer.model) +
            ' ' +
            chalk.red(answer.status === 'timeout' ? '⏱ timed out' : `✗ ${answer.error ?? 'error'}`)
        );
      }
    }
    console.log('');
  } catch (err) {
    spinner.fail(String(err));
    if (process.env['RCL_DEBUG']) {
      console.error(err);
    }
    process.exit(1);
  }
}

/**
 * Roles whose instincts transfer to reviewing a design document. Used only
 * when neither CLI flags nor config request roles; spec-compliance joins
 * when a spec is resolved (see prepareCouncil).
 */
const PLAN_DEFAULT_ROLES = ['general', 'architecture', 'edge-case-hunter'];

async function runPlanReview(
  file: string,
  opts: CouncilCliOpts & { focus?: string }
): Promise<void> {
  const spinner = ora('Loading configuration...').start();

  try {
    let focus: PlanFocus | undefined;
    if (opts.focus) {
      if (!isPlanFocus(opts.focus)) {
        spinner.fail(
          `Invalid --focus "${opts.focus}". Use one of: ${PLAN_FOCUS_MODES.join(', ')}.`
        );
        process.exit(1);
      }
      focus = opts.focus;
    }

    const prepared = await prepareCouncil(spinner, opts, PLAN_DEFAULT_ROLES);

    spinner.text = `Loading plan: ${file}`;
    const diff = await loadPlanAsDiff(file);

    // Plan reviews get an async lane too: re-reviewing the same plan file
    // collects what the previous run fired.
    await executeCouncil(spinner, prepared, diff, opts, {
      focus,
      asyncTargetLabel: `plan:${file}`,
    });
  } catch (err) {
    spinner.fail(String(err));
    if (process.env['RCL_DEBUG']) {
      console.error(err);
    }
    process.exit(1);
  }
}

program.parse();
