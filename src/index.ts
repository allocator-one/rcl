#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { readdir, readFile, writeFile } from 'fs/promises';
import { hostname } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadConfig } from './config/loader.js';
import { applyHarnessModelKeys } from './config/harness.js';
import {
  DEFAULT_MODELS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_ASYNC_TIMEOUT_MS,
  DEFAULT_QUORUM_FRACTION,
  DEFAULT_MAX_RETRIES,
  DEFAULT_CONCURRENCY,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_THRESHOLDS,
} from './config/defaults.js';
import { parseGitHubTarget, fetchPRDiff, isGitHubTarget } from './resolver/github.js';
import { loadLocalDiff } from './resolver/local.js';
import { loadGitDiff, resolveGitHeads } from './resolver/git.js';
import { loadPlanAsDiff } from './resolver/plan.js';
import { isPlanFocus, PLAN_FOCUS_MODES, type PlanFocus } from './prompts/plan.js';
import { chunkDiff } from './prepare/chunker.js';
import { buildPrompt, loadContextDocs as loadPromptContextDocs } from './prepare/prompt-builder.js';
import { BUILTIN_ROLES, getRoleByName } from './roles/builtin.js';
import { resolveRoles, loadProjectRulesContent } from './roles/loader.js';
import { buildAssignments, detectProvider } from './roles/dispatcher.js';
import { runReviews } from './dispatch/runner.js';
import { mergeChunkReviews } from './dispatch/merge.js';
import { capturePreparedCouncil, type CapturedPreparedCouncil } from './dispatch/capture-council.js';
import { bindOriginalCouncil, executeCapturedOriginal } from './dispatch/original-execution.js';
import { assertOriginalLaunchBudget, createOriginalLaunch, type OriginalLaunch } from './dispatch/original-launch.js';
import { createCheckpointLateAudit, type CheckpointLateAudit } from './dispatch/late-audit.js';
import type { CheckpointJournal } from './dispatch/checkpoint.js';
import { withNativeTarget, type NativeTargetOwnership } from './converge/target-ownership.js';
import { retainedLaunchInputSha256, processRetainedRoundReport } from './converge/retained-report.js';
import { AGGREGATION_ALGORITHM, captureAggregationInputs } from './report/aggregation-inputs.js';
import { assembleCheckpointReview, type CheckpointAssemblyInput } from './report/checkpoint-assembly.js';
import { projectCheckpointReport, type CheckpointReportProjection } from './report/checkpoint-projection.js';
import { captureSupplementalAsync } from './report/supplemental-async.js';
import { describeReviewerEvidence } from './report/reviewer-evidence.js';
import { serializeReviewerArtifact } from './report/reviewer-artifact.js';
import { inspectReviewerStatus, formatReviewerStatus, inspectReviewerRecoveryPreview, formatReviewerRecoveryPreview } from './evidence/reviewer-status.js';
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
import { resolveGatingConfig } from './consensus/gating.js';
import { printReviewSummary } from './output/terminal.js';
import { postGitHubReview } from './output/github.js';
import { renderReportArtifacts, writeReportArtifacts } from './output/artifacts.js';
import { assembleCompletedReview, type CompletedReviewInput, type AssemblyDependencies } from './report/assembly.js';
import {
  assertReviewWorkWithinLimit,
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
  findingGatingReason,
  ConvergeRoundCapError,
  ConvergeRunStateError,
} from './converge/run-state.js';
import { applyRoundGap, previewRoundGap } from './converge/round-gap.js';
import { guardReviewLaunch, ReviewLaunchRefused, type GuardedLaunchCompletion, type GuardedLaunchOptions } from './converge/launch-guard.js';
import { validateLaunchOutputs, validateLaunchProviders } from './converge/launch-preflight.js';
import { writeExclusive, serializeRecoveryDocument } from './evidence/original-run/journal.js';
import { readStable, sha256 } from './telemetry/recovery/files.js';
import {
  appendCalls,
  appendOutcomes,
  loadModelStats,
  resolveDataDir,
  DEFAULT_WINDOW_DAYS,
  MIN_OUTCOMES_FOR_WEIGHT,
} from './models/stats-store.js';
import { buildSeedRecords } from './models/seed.js';
import {
  buildRoster,
  configDigest,
  diffDigest,
  describeRunTarget,
  detectRunner,
  parseSpecSource,
  resolveConvergeContext,
  sha256Hex,
  stableStringify,
  validateSha,
  type ConvergeContext,
  type RunHeaderInput,
  type SpecSource,
} from './report/run-header.js';
import { assertExpectedHead, resolveReviewTarget } from './resolver/target.js';
import {
  createTelemetryRuntime,
  deliverRun,
  evidenceRequirementConflict,
  emitConvergeEvents,
  flushOutbox,
  flushOutboxAtStart,
  type DeliveryOutcome,
  type TelemetryRuntime,
  loadHarnessSettings,
  resolveTelemetryLevel,
} from './telemetry/deliver.js';
import { sanitizeForDelivery } from './telemetry/envelope.js';
import { Quarantine, QUARANTINE_DIR } from './telemetry/quarantine.js';
import { scrubText } from './telemetry/scrub.js';
import { buildEvent, roundIdentities, type WireEvent } from './telemetry/events.js';
import { credentialHost, type HarnessCredential } from './telemetry/credentials.js';
import { attestRun, renewAttestation, type Attestation } from './telemetry/attest.js';
import type { TelemetryLevel } from './telemetry/envelope.js';
import { uuidv7 } from './report/uuid.js';
import { runEvidenceStatus } from './evidence/status.js';
import { runEvidenceShow } from './evidence/show.js';
import { runFindingRecovery, type FindingRecoveryOptions } from './evidence/recover-finding.js';
import { runOriginalRecovery, type OriginalRunOptions } from './evidence/recover-run.js';
import { runFindingRetriage, type FindingRetriageOptions } from './evidence/retriage-finding.js';
import { fetchServerModelStats, loadMergedWeights, mergeWeights } from './models/server-stats.js';
import { runBackfill } from './telemetry/backfill.js';
import { runRefutationRecovery, type RefutationRecoveryOptions } from './telemetry/recovery/command.js';
import { parseRepoName } from './evidence/target.js';
import { text } from './evidence/format.js';
import { loadConvergeRunState, roundRunId } from './converge/run-state.js';

const RCL_VERSION: string = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')
).version;

const program = new Command();

program
  .name('rcl')
  .description('Review Council — multi-model AI code review')
  .version(RCL_VERSION);

// Commands that perform work first deliver what an earlier one could not, bounded to
// five seconds so an offline machine never stalls (IO-12475 section 8.4).
// The telemetry commands manage the outbox themselves; the detached async
// worker is not a user command.
program.hook('preAction', async (_thisCommand, actionCommand) => {
  const name = actionCommand.name();
  // Reads and explicit repairs must not flush unrelated evidence, even in preview.
  if (actionCommand.parent?.name() === 'reviewers') return;
  if (actionCommand.parent?.name() === 'evidence' && (name === 'show' || name === 'status')) return;
  if (name === 'converge-report' || name === 'converge-gap' || name === 'recover-run' || name === 'recover-finding' || name === 'retriage-finding' || name === 'telemetry' || actionCommand.parent?.name() === 'telemetry' || name.includes('worker')) return;
  const flags = actionCommand.opts<{ telemetry?: boolean }>();
  if (flags.telemetry === false || (process.env['RCL_TELEMETRY'] ?? '').trim().toLowerCase() === 'off') return;
  try {
    // One cheap readdir before any credential or config work: most commands
    // find an empty outbox and pay nothing.
    const entries = await readdir(join(resolveDataDir(), 'outbox')).catch(() => [] as string[]);
    if (entries.length === 0) return;
    await flushOutboxAtStart(await createTelemetryRuntime({ rclVersion: RCL_VERSION }));
  } catch {
    // Never let the outbox stop the command the user asked for.
  }
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `--evidence-required` with telemetry switched off cannot be honored; say so
 * before spending the council. The flag and the environment are known up
 * front; the project config's `harness.telemetry: off` is checked again once
 * the config is loaded, still before any reviewer call.
 */
function assertEvidenceCanBeRequired(
  opts: { evidenceRequired?: boolean; telemetry?: boolean },
  config?: Pick<Config, 'harness'>
): void {
  const conflict = evidenceRequirementConflict(opts, config, process.env);
  if (conflict !== undefined) throw new Error(conflict);
}

/**
 * With `--evidence-required`, resolve where the evidence would go before any
 * reviewer is paid: an unmanaged repository or a missing credential makes
 * delivery impossible, and that is worth knowing at once.
 */
async function assertEvidenceDeliverable(
  opts: { evidenceRequired?: boolean; telemetry?: boolean },
  config: Config,
  credential?: HarnessCredential
): Promise<void> {
  if (!opts.evidenceRequired) return;
  const runtime = await createTelemetryRuntime({
    rclVersion: RCL_VERSION,
    config,
    noTelemetry: opts.telemetry === false,
    ...(credential ? { credential } : {}),
  });
  if (!runtime.repoManaged) {
    throw new Error('--evidence-required needs a Harness-managed repository (one carrying .harness-cli/config.json); this one is not.');
  }
  if (runtime.level === 'off') throw new Error('--evidence-required contradicts the resolved telemetry level off.');
  if (!runtime.sink) throw new Error(`--evidence-required needs a Harness credential: ${runtime.note ?? 'none available'}.`);
}

/** `--attest` records the full report or nothing: the resolved telemetry level must be `full`. */
function attestLevelMessage(level: TelemetryLevel): string {
  return `--attest needs the telemetry level full (resolved: ${level}): an attested run carries its full report as evidence. Check RCL_TELEMETRY and harness.telemetry in the project config.`;
}

/**
 * `--attest` (RCL-40), before any key, config or reviewer work: the target
 * must be a pull request, the telemetry level must resolve to `full` from the
 * environment and the project config (the file `--config` names included),
 * and only then is the job's OIDC token requested and exchanged. An attested
 * review is recorded or it does not run; the caller treats evidence as
 * required from here on.
 */
async function attestBeforeReview(
  spinner: Spinner,
  opts: CouncilCliOpts,
  target: string | undefined,
  gitMode: string | undefined
): Promise<Attestation> {
  if (gitMode || target === undefined || !isGitHubTarget(target)) {
    throw new Error(
      '--attest applies to a pull request target (owner/repo#N or a GitHub PR URL): Harness attests a run of the pull request it re-reads, not a local diff or a patch file.'
    );
  }
  if (opts.telemetry === false) {
    throw new Error('--attest contradicts --no-telemetry: an attested review is recorded or it does not run.');
  }
  const level = resolveTelemetryLevel(await loadHarnessSettings(process.cwd(), opts.config), { noTelemetry: false }, process.env);
  if (level !== 'full') throw new Error(attestLevelMessage(level));

  spinner.text = 'Attesting to Harness as this GitHub Actions run...';
  const attestation = await attestRun({ runId: uuidv7(), rclVersion: RCL_VERSION });
  spinner.info(
    `Attested: run-bound credential from ${credentialHost(attestation.credential)} for run ${attestation.runId} (expires ${attestation.expiresAt})`
  );
  spinner.start('Loading configuration...');
  return attestation;
}

/** Converge commands report their events fail-soft; nothing they do depends on it. */
async function reportConvergeEvents(events: WireEvent[]): Promise<void> {
  try {
    await emitConvergeEvents(await createTelemetryRuntime({ rclVersion: RCL_VERSION }), events);
  } catch {
    // Evidence of the loop is advisory next to the loop's own durable state.
  }
}

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
  .option('--head-sha <sha>', 'Exact head commit a patch file was taken from (patch files only)')
  .option('--base-sha <sha>', 'Exact base commit a patch file was taken from (patch files only)')
  .option('--expect-head-sha <sha>', 'Fail fast unless the resolved head commit equals this SHA')
  .option('--spec-source <source>', 'Where --spec came from: flag | repo_file | harness_issue:<ID>')
  .option('--converge-target <key>', 'Converge target this round belongs to (or RCL_CONVERGE_TARGET)')
  .option('--for-pr <owner/repo#N>', 'The pull request a patch-file review is evidence for (or RCL_FOR_PR): Harness verifies its head against that pull request')
  .option('--round <n>', 'Converge round number (or RCL_CONVERGE_ROUND)')
  .option('--attempt <n>', 'Converge attempt number (or RCL_CONVERGE_ATTEMPT)')
  .option('--guarded-converge', 'Validate and claim inside this review process; derive the round from native state')
  .option('--retain-reviewers', 'Privately retain exact reviewer inputs and results for guarded patch reviews')
  .option('--launch-intent <intent>', 'Guarded intent: review, stop-upstream, stop-review, or retry-delivery')
  .option('--retry-reason <reason>', 'Explicit bounded recovery decision for a previous failed or unknown launch; never resets caps')
  .option('--max-attempts <n>', 'Guarded convergence: explicitly authorized attempt cap (omitting preserves the cap)')
  .option('--max-rounds <n>', 'Guarded convergence: explicitly authorized round cap (2–99; omitting preserves the cap)')
  .option('--no-telemetry', 'Do not deliver this review as evidence to Harness')
  .option('--evidence-required', 'Exit 4 unless Harness acknowledged the evidence (spools first; retry with rcl telemetry flush)')
  .option('--config <path>', 'Path to config file')
  .option(
    '--attest',
    'GitHub Actions gate workflow only: exchange the job OIDC token for a run-bound Harness credential and record this review as attested (needs id-token: write and HARNESS_API_URL; implies --evidence-required; no fallback to another credential)'
  )
  .action(async (target: string | undefined, opts) => {
    await runReview(target, opts);
  });

const reviewersCommand = program.command('reviewers').description('Inspect retained reviewer work without provider calls');
reviewersCommand.command('status <target>')
  .description('Read a selected local checkpoint; does not authorize recovery or approve a review')
  .requiredOption('--run <uuid>', 'Exact retained run UUID')
  .option('--json', 'Print machine-readable status')
  .action(async (target: string, opts: { run: string; json?: boolean }) => {
    try {
      const status = await inspectReviewerStatus({ commonDir: await resolveGitCommonDir(), target, runId: opts.run });
      console.log(opts.json ? JSON.stringify(status, null, 2) : formatReviewerStatus(status));
    } catch (error) {
      console.error(scrubText(error instanceof Error ? error.message : String(error), 500));
      process.exitCode = 1;
    }
  });

reviewersCommand.command('preview <target>')
  .description('Plan missing assignments from a sealed local source without spending attempts or calling providers')
  .requiredOption('--run <uuid>', 'Exact retained source run UUID')
  .requiredOption('--max-additional-calls <n>', 'Proposed finite call budget for a new successor')
  .requiredOption('--max-attempts-per-cell <n>', 'Proposed total attempt limit per original assignment, including its history')
  .requiredOption('--time-budget-ms <n>', 'Proposed duration for a new successor; does not renew an existing deadline')
  .option('--json', 'Print machine-readable preview')
  .action(async (target: string, opts: { run: string; maxAdditionalCalls: string; maxAttemptsPerCell: string; timeBudgetMs: string; json?: boolean }) => {
    try {
      const integer = (value: string): number => /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
      const preview = await inspectReviewerRecoveryPreview({ commonDir: await resolveGitCommonDir(), target, runId: opts.run,
        maxAdditionalCalls: integer(opts.maxAdditionalCalls), maxAttemptsPerCell: integer(opts.maxAttemptsPerCell), timeBudgetMs: integer(opts.timeBudgetMs) });
      console.log(opts.json ? JSON.stringify(preview, null, 2) : formatReviewerRecoveryPreview(preview));
    } catch (error) {
      console.error(scrubText(error instanceof Error ? error.message : String(error), 500));
      process.exitCode = 1;
    }
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
  .option('--spec-source <source>', 'Where --spec came from: flag | repo_file | harness_issue:<ID>')
  .option('--converge-target <key>', 'Converge target this round belongs to (or RCL_CONVERGE_TARGET)')
  .option('--for-pr <owner/repo#N>', 'The pull request a patch-file review is evidence for (or RCL_FOR_PR): Harness verifies its head against that pull request')
  .option('--round <n>', 'Converge round number (or RCL_CONVERGE_ROUND)')
  .option('--attempt <n>', 'Converge attempt number (or RCL_CONVERGE_ATTEMPT)')
  .option('--no-telemetry', 'Do not deliver this review as evidence to Harness')
  .option('--evidence-required', 'Exit 4 unless Harness acknowledged the evidence (spools first; retry with rcl telemetry flush)')
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
        await reportConvergeEvents([
          buildEvent({
            kind: 'attempt_claimed',
            convergeTarget: claim.target,
            attempt: claim.attempt,
            // The claim's local state path and process id stay on this machine.
            payload: { attempt: claim.attempt, cap: claim.cap },
          }),
          // An explicit --max-attempts is consent evidence, whatever it was before.
          ...(maxAttempts !== undefined
            ? [buildEvent({ kind: 'cap_changed', convergeTarget: claim.target, attempt: claim.attempt, payload: { kind: 'attempts', to: claim.cap } })]
            : []),
        ]);
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


// Cross-round finding identity + machine-enforced round cap (RCL-24).
program
  .command('converge-gap')
  .description('Preview, apply or resume one evidenced missing-terminal-report audit gap; never creates a round, finding, verdict or attempt')
  .option('--preview')
  .option('--apply')
  .option('--resume')
  .requiredOption('--manifest <path>', 'Exclusive preview manifest; existing reviewed manifest for apply/resume')
  .option('--target <target>')
  .option('--gap-round <number>')
  .option('--admitting-round <number>')
  .option('--attempt <number>')
  .option('--run <uuid>')
  .option('--report <path>', 'Exact original report JSON')
  .option('--report-sha256 <sha256>')
  .option('--incomplete <path>', 'Available incomplete-run evidence; does not prove global absence')
  .option('--incomplete-sha256 <sha256>')
  .option('--evidence <path>', 'Optional JSON array of additional {path, sha256} selections')
  .option('--manifest-sha256 <sha256>', 'Exact reviewed manifest bytes; required for apply/resume')
  .option('--json')
  .action(async (opts: Record<string, string | boolean | undefined>) => {
    try {
      if ([opts.preview, opts.apply, opts.resume].filter(Boolean).length !== 1) throw new Error('choose_exactly_one_round_gap_mode');
      const gitCommonDir = await resolveGitCommonDir();
      let result: unknown;
      if (opts.preview) {
        if (opts.manifestSha256 !== undefined) throw new Error('preview_does_not_accept_manifest_digest');
        if (![opts.target, opts.gapRound, opts.admittingRound, opts.attempt, opts.run, opts.report, opts.reportSha256, opts.incomplete, opts.incompleteSha256].every(value => typeof value === 'string')) throw new Error('round_gap_preview_arguments_required');
        const evidence = typeof opts.evidence === 'string' ? JSON.parse((await readStable(opts.evidence, 1024 * 1024)).text) : undefined;
        const manifest = await previewRoundGap({ target: opts.target as string, gapRound: Number(opts.gapRound), admittingRound: Number(opts.admittingRound), attempt: Number(opts.attempt), runId: opts.run as string,
          reportPath: opts.report as string, reportSha256: opts.reportSha256 as string,
          incompletePath: opts.incomplete as string, incompleteSha256: opts.incompleteSha256 as string, ...(evidence !== undefined ? { evidence } : {}) }, gitCommonDir);
        await writeExclusive(opts.manifest as string, manifest, 1024 * 1024);
        result = { mode: 'preview', manifest, manifestSha256: sha256(serializeRecoveryDocument(manifest)), accounting: 'unchanged', scope: 'local audit only; no admission or approval' };
      } else {
        if ([opts.target,opts.gapRound,opts.admittingRound,opts.attempt,opts.run,opts.report,opts.reportSha256,opts.incomplete,opts.incompleteSha256,opts.evidence].some(v => v !== undefined)) throw new Error('apply_uses_only_pinned_manifest');
        result = { mode: opts.apply ? 'apply' : 'resume', result: await applyRoundGap({ manifest: opts.manifest as string, manifestSha256: opts.manifestSha256 as string, mode: opts.apply ? 'apply' : 'resume' }, gitCommonDir), accounting: 'unchanged', scope: 'local audit only; no admission or approval' };
      }
      console.log(JSON.stringify(result));
    } catch (error) { console.error(JSON.stringify({ error: { code: 'RCL_CONVERGE_GAP', message: error instanceof Error ? error.message : String(error) } })); process.exitCode = 3; }
  });

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
        let reportBytes: string;
        let reportSha256: string;
        try {
          const source = await readFile(opts.report);
          reportBytes = source.toString('utf8');
          if (!Buffer.from(reportBytes, 'utf8').equals(source)) throw new Error('Report must contain valid UTF-8.');
          report = JSON.parse(reportBytes) as ReviewResult;
          reportSha256 = sha256(source);
        } catch (err) {
          throw new ConvergeRunStateError(`Could not read report JSON: ${opts.report}`, {
            cause: err,
          });
        }
        if (!Array.isArray(report.findings)) {
          throw new ConvergeRunStateError(`Not an rcl report (no findings array): ${opts.report}`);
        }

        // The round remembers the report's run id only when it is a UUID and
        // the report was produced for this converge target (a report copied
        // from another target must not bind its run to this loop).
        const reportRunId =
          typeof report.run?.id === 'string' && UUID_PATTERN.test(report.run.id) ? report.run.id : undefined;
        // A report without a converge target (a plain `rcl review`, or one
        // copied in) is not this loop's evidence either.
        const reportTarget = report.run?.converge?.target;
        const runId =
          reportRunId !== undefined && typeof reportTarget === 'string' && reportTarget.trim() === opts.target.trim()
            ? reportRunId
            : undefined;
        if (reportRunId !== undefined && runId === undefined) {
          console.error(
            chalk.yellow(
              `Report run ${reportRunId} ${reportTarget === undefined ? 'carries no converge target' : `belongs to converge target ${reportTarget}`}, not ${opts.target}; the round keeps no run id.`
            )
          );
        }
        const gitCommonDir = await resolveGitCommonDir(), convergeTarget = opts.target.trim();
        const result = await withNativeTarget(gitCommonDir, convergeTarget, async ownership => {
          // Resolve the route while owning the target: deleting a report marker
          // cannot make an already retained launch fall through legacy intake.
          const state = await loadConvergeRunState(gitCommonDir, convergeTarget);
          if (report.run?.reviewer_evidence !== undefined || state?.lastLaunch?.reviewerHealth !== undefined) {
            return processRetainedRoundReport({ gitCommonDir, target: convergeTarget, round, reportBytes,
              currentHeadSha: (await resolveGitHeads()).headSha ?? '', ownership,
              ...(maxRounds !== undefined ? { maxRounds } : {}) });
          }
          return processRoundReport({ gitCommonDir, target: convergeTarget, round, findings: report.findings,
            reportSha256, ownership, ...(maxRounds !== undefined ? { maxRounds } : {}),
            ...(runId !== undefined ? { runId } : {}) });
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
        await reportConvergeEvents([
          buildEvent({
            kind: 'round_processed',
            convergeTarget: opts.target,
            round,
            ...(runId !== undefined ? { runId } : {}),
            payload: {
              round,
              round_cap: result.roundCap,
              counts: result.counts,
              actionable_gating: actionable.length,
              // Which identity each sighting was matched to, so the server
              // can apply standing verdicts to keys that moved (IO-12601).
              identities: roundIdentities(result.findings),
            },
          }),
          ...(maxRounds !== undefined
            ? [buildEvent({ kind: 'cap_changed', convergeTarget: opts.target, round, payload: { kind: 'rounds', to: result.roundCap } })]
            : []),
        ]);

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
    '--fixed-reason <key=reason>',
    'Current fix explanation for an identity also passed to --fixed (repeatable)',
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
      fixedReason: string[];
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
        const fixedReasons = new Map<string, string>();
        for (const assignment of opts.fixedReason) {
          const eq = assignment.indexOf('=');
          const key = assignment.slice(0, eq);
          const reason = assignment.slice(eq + 1);
          if (eq < 1 || reason.trim() === '' || !opts.fixed.includes(key)) {
            throw new ConvergeRunStateError('--fixed-reason requires key=reason for an identity also passed to --fixed.');
          }
          if (fixedReasons.has(key)) {
            throw new ConvergeRunStateError(`Duplicate --fixed-reason for finding "${key}".`);
          }
          fixedReasons.set(key, reason);
        }
        const verdicts = [
          ...opts.fixed.map((key) => ({ key, verdict: 'fixed' as const, reason: fixedReasons.get(key) })),
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
        if (new Set(verdicts.map(({ key }) => key)).size !== verdicts.length) {
          throw new ConvergeRunStateError('Pass each finding identity only once, as either fixed or dismissed.');
        }
        const { entries: updated, resolution } = await recordVerdicts({
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
                severity: e.verdictSeverity ?? e.severity,
                target: opts.target as string,
                findingKey: e.key,
                source: 'live' as const,
              }))
          );
        } catch (err) {
          // Advisory history; verdict recording must not fail over it —
          // but say so, or a broken store silently stops learning.
          console.warn(
            `Model-stats store unavailable (outcomes not recorded): ${String(err)}`
          );
        }
        // The run id binding is advisory: an unreadable state file must not
        // fail a command whose verdicts are already recorded.
        let roundRun: string | undefined;
        try {
          roundRun = roundRunId(await loadConvergeRunState(await resolveGitCommonDir(), opts.target), round);
        } catch {
          roundRun = undefined;
        }
        await reportConvergeEvents([
          buildEvent({
            kind: 'verdicts_recorded',
            convergeTarget: opts.target,
            round,
            ...(roundRun !== undefined ? { runId: roundRun } : {}),
            payload: {
              verdicts: updated.map((e) => ({
                identity_key: e.key,
                verdict: e.verdict,
                // Verdict reasons are user-authored prose: scrubbed like every other free text that leaves the machine.
                ...(e.verdictReason !== undefined ? { reason: scrubText(e.verdictReason, 500) } : {}),
                severity: e.verdictSeverity ?? e.severity,
                models: e.models,
              })),
            },
          }),
          ...(resolution
            ? [
                buildEvent({
                  kind: 'resolution',
                  convergeTarget: opts.target,
                  round,
                  ...(roundRun !== undefined ? { runId: roundRun } : {}),
                  payload: {
                    status: resolution.status,
                    actionable: resolution.actionable,
                    unresolved: resolution.unresolved.length,
                    fixed_this_round: resolution.fixedThisRound,
                  },
                }),
              ]
            : []),
        ]);
        if (opts.json) {
          console.log(
            JSON.stringify({
              target: opts.target,
              round,
              recorded: verdicts.length,
              ...(resolution ? { resolution } : {}),
            })
          );
        } else {
          console.log(`Recorded ${verdicts.length} verdict(s) for ${opts.target} round ${round}.`);
          if (resolution) {
            switch (resolution.status) {
              case 'converged-dismissal-only':
                console.log(
                  `Round ${round} resolution: all ${resolution.actionable} gating finding(s) dismissed, ` +
                    'nothing fixed — the reviewed patch is unchanged, so this round CONVERGES. ' +
                    'No confirmation round is required (RCL-30).'
                );
                break;
              case 'fixes-pending-fresh-round':
                console.log(
                  `Round ${round} resolution: ${resolution.fixedThisRound} fix(es) recorded — ` +
                    'the patch changes; commit, push, and run a fresh exact-head round.'
                );
                break;
              case 'unresolved':
                console.log(
                  `Round ${round} resolution: ${resolution.unresolved.length} gating identity(ies) ` +
                    `still untriaged: ${resolution.unresolved.join(', ')}`
                );
                break;
            }
          }
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

// Evidence delivery operations (IO-12475 section 8.10).
const telemetry = program
  .command('telemetry')
  .description('Evidence delivery to Harness: credentials, queued deliveries and retained rejected reports');

telemetry
  .command('rejected')
  .description('Inspect immutable retained evidence without delivering or retrying it')
  .option('--run <id>', 'Select one retained original run')
  .option('--json', 'Output JSON')
  .action(async (opts: { run?: string; json?: boolean }) => {
    const store = new Quarantine(join(resolveDataDir(), QUARANTINE_DIR));
    try {
      const selected = opts.run ? await store.inspect(opts.run) : undefined;
      const entries = opts.run ? (selected ? [selected] : []) : await store.list();
      if (opts.json) console.log(JSON.stringify({ dir: store.dir, entries }, null, 2));
      else {
        console.log(`Retained evidence: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — no automatic retry`);
        for (const entry of entries) console.log(`  ${entry.runId} ${entry.status} ${entry.path}${entry.error ? ` (${entry.error})` : ''}`);
      }
      if ((opts.run && entries.length === 0) || entries.some((e) => e.status !== 'complete')) process.exitCode = 1;
    } catch (error) {
      console.error(`Cannot inspect retained evidence: ${scrubText(error instanceof Error ? error.message : String(error), 200)}`);
      process.exitCode = 1;
    }
  });

telemetry
  .command('status')
  .description('Show the telemetry level, the credential source and every spooled delivery')
  .option('--json', 'Output JSON')
  .action(async (opts: { json?: boolean }) => {
    const runtime = await createTelemetryRuntime({ rclVersion: RCL_VERSION, requireRepo: false });
    const entries = await runtime.outbox.list();
    const loss = await runtime.outbox.pendingLoss();
    const refused = await runtime.outbox.refusedLoss();
    const status = {
      level: runtime.level,
      repoManaged: runtime.repoManaged,
      credential: runtime.credential
        ? { source: runtime.credential.source, host: credentialHost(runtime.credential) }
        : null,
      note: runtime.note ?? null,
      outbox: { dir: runtime.outbox.dir, entries, pendingLoss: loss, refusedLoss: refused },
    };
    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`Telemetry level: ${status.level}`);
    console.log(
      status.repoManaged
        ? 'Repository: Harness-managed (.harness-cli/config.json found) — reviews here are delivered'
        : 'Repository: not Harness-managed — reviews here are not delivered; the outbox still flushes'
    );
    console.log(
      status.credential
        ? `Credential: ${status.credential.source} → ${status.credential.host}`
        : `Credential: none${status.note ? ` (${status.note})` : ''}`
    );
    console.log(`Outbox: ${runtime.outbox.dir} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`);
    for (const entry of entries) {
      console.log(
        `  ${entry.id} ${entry.meta.kind} spooled ${entry.meta.spooled_at} attempts ${entry.meta.attempts} ` +
          `${entry.bytes} bytes artifacts [${entry.artifacts.join(', ')}] events ${entry.events}` +
          (entry.meta.envelope_delivered ? ' (envelope delivered)' : '') +
          (entry.failed ? chalk.red(` FAILED: ${entry.failed.reason}`) : '')
      );
    }
    if (loss.length > 0) {
      console.log(chalk.yellow(`Artifacts not spooled (outbox over its cap) for ${loss.length} run(s); reported on the next flush.`));
    }
    if (refused.length > 0) {
      console.log(
        chalk.yellow(`${refused.length} loss report(s) the server refused are kept under ${runtime.outbox.dir}/loss (*.refused); they are not retried.`)
      );
    }
  });

telemetry
  .command('flush')
  .description('Deliver every spooled envelope, artifact and event batch (runs to completion)')
  .option('--run <id>', 'Flush one spooled run only')
  .option('--json', 'Output JSON')
  .action(async (opts: { run?: string; json?: boolean }) => {
    const runtime = await createTelemetryRuntime({ rclVersion: RCL_VERSION, requireRepo: false });
    if (!runtime.sink) {
      const reason = runtime.level === 'off' ? 'telemetry is off' : runtime.note ?? 'no Harness credential';
      console.error(chalk.red(`Cannot flush: ${reason}.`));
      process.exitCode = 1;
      return;
    }
    const summary = await flushOutbox(runtime, opts.run ? { runId: opts.run } : {});
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(
        `Delivered ${summary.delivered.length}, remaining ${summary.remaining.length}, failed ${summary.failed.length}, dropped ${summary.dropped.length}` +
          (summary.stopped ? ` (stopped: ${summary.stopped})` : '') +
          (summary.lossPending ? `; ${summary.lossPending} loss report(s) still pending` : '')
      );
      for (const id of summary.delivered) console.log(`  delivered ${id}`);
      for (const f of summary.failed) console.log(chalk.red(`  failed ${f.id}: ${f.reason}`));
      for (const d of summary.dropped) console.log(chalk.dim(`  dropped ${d.id}: ${d.reason}`));
      for (const id of summary.remaining) console.log(chalk.yellow(`  remaining ${id}`));
    }
    if (summary.remaining.length > 0 || summary.failed.length > 0) process.exitCode = 1;
  });

// Evidence reads (RCL-41): what Harness holds about a pull request's gate
// and about one run. The skills gate on `evidence status`'s exit code: 0 only
// when the judged projection is converged, 1 for any other status, 2 when the
// pull request cannot be named, 3 when the read could not be answered.
const evidenceCmd = program
  .command('evidence')
  .description('Read Review Council evidence on Harness: a pull request’s gate status, one run’s record');

function evidenceDeps() {
  return {
    rclVersion: RCL_VERSION,
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(chalk.red(line)),
  };
}

evidenceCmd
  .command('status [pr]')
  .description(
    'Gate status of a pull request — N or #N against the current remote, owner/repo#N, or a URL; exit 0 only when the judged projection is converged'
  )
  .option('--enforced', 'Judge the enforced projection instead of the advisory one')
  .option('--json', 'Print the API status object')
  .action(async (pr: string | undefined, opts: { enforced?: boolean; json?: boolean }) => {
    process.exitCode = await runEvidenceStatus(pr, opts, evidenceDeps());
  });

evidenceCmd
  .command('show [run-id]')
  .description('One recorded run: header, reviewer health, artifacts, findings with identity, gating reason and verdict')
  .option('--json', 'Print the API run object')
  .action(async (runId: string | undefined, opts: { json?: boolean }) => {
    process.exitCode = await runEvidenceShow(runId ?? '', opts, evidenceDeps());
  });

evidenceCmd
  .command('recover-run')
  .description('Preview, apply or resume delivery of one immutable original asserted run; no review, events or native accounting')
  .option('--preview', 'Validate sources and scoped remote reads; write only a new exclusive manifest')
  .option('--apply', 'Start the explicitly pinned manifest operation')
  .option('--resume', 'Resume the same journal through fresh exact run/artifact reads')
  .requiredOption('--manifest <path>', 'Exclusive preview manifest; existing manifest for apply/resume')
  .option('--manifest-sha256 <sha256>', 'Required exact reviewed manifest digest for apply/resume')
  .option('--run <uuid>', 'Original run UUID (preview)')
  .option('--for-pr <owner/repo#N>', 'Original repository and pull request (preview)')
  .option('--head <sha>', 'Original full reviewed head SHA (preview)')
  .option('--report-json <path>', 'Original bounded regular UTF-8 JSON file (preview)')
  .option('--report-sha256 <sha256>', 'Exact original JSON digest (preview)')
  .option('--report-md <path>', 'Optional original Markdown file (preview)')
  .option('--markdown-sha256 <sha256>', 'Required digest when selecting original Markdown')
  .option('--original-mode <mode>', 'Required operator assertion: asserted; CI/attested originals unsupported')
  .option('--original-prose <mode>', 'Explicit original finding-prose representation: control-code-units-v1')
  .option('--json', 'Print machine-readable operation status and diagnostics')
  .action(async (opts: OriginalRunOptions) => {
    process.exitCode = await runOriginalRecovery(opts, evidenceDeps());
  });

evidenceCmd
  .command('recover-finding')
  .description('Preview an unpaid, attributed correction of one recorded finding identity; never reruns review or changes native history')
  .requiredOption('--target <target>', 'The retained native convergence target')
  .requiredOption('--run <uuid>', 'The immutable Harness run ID')
  .requiredOption('--report-sha256 <sha256>', 'The original report JSON digest')
  .requiredOption('--finding-ref <ref>', 'The exact finding ref within the run')
  .requiredOption('--identity <key>', 'The native canonical identity from retained state')
  .requiredOption('--for-pr <owner/repo#N>', 'The expected pull request, explicitly named')
  .option('--submit', 'Submit the correction; without this flag only read and preview')
  .action(async (opts: FindingRecoveryOptions) => {
    process.exitCode = await runFindingRecovery(opts, evidenceDeps());
  });

evidenceCmd
  .command('retriage-finding')
  .description('Preview a fresh dismissal of one recorded finding at its actual severity; no rematching or native history changes')
  .requiredOption('--target <target>', 'The recorded convergence target, or an event label for a standalone attested run')
  .requiredOption('--run <uuid>', 'The immutable Harness run ID')
  .requiredOption('--report-sha256 <sha256>', 'The original stored report JSON digest')
  .requiredOption('--finding-ref <ref>', 'The exact finding ref within the run')
  .requiredOption('--for-pr <owner/repo#N>', 'The expected pull request, explicitly named')
  .requiredOption('--reason-file <path>', 'UTF-8 file containing the explicit source-backed reason for this new judgment')
  .option('--submit', 'Submit the fresh verdict; without this flag only read and preview')
  .action(async (opts: FindingRetriageOptions) => {
    process.exitCode = await runFindingRetriage(opts, evidenceDeps());
  });

telemetry
  .command('recover-refutations')
  .description('Discover original refutations and write a reviewed recovery manifest; dry-run by default')
  .requiredOption('--manifest <path>', 'New private manifest path, or the reviewed manifest with --apply')
  .option('--root <path>', 'Discovery root; repeat to replace the default roots', (value: string, previous: string[] = []) => [...previous, value])
  .option('--exclude-sha256 <digest>', 'Explicit synthetic report digest; repeat as needed', (value: string, previous: string[] = []) => [...previous, value])
  .option('--inventory-only', 'Offline discovery artifact without a destination; cannot be applied')
  .option('--apply', 'Revalidate and apply only the reviewed manifest selections')
  .option('--output <path>', 'New outcome path for apply; defaults to a unique file beside the manifest')
  .action(async (opts: RefutationRecoveryOptions) => {
    process.exitCode = await runRefutationRecovery(opts, evidenceDeps());
  });

telemetry
  .command('backfill')
  .description('Post recovered pre-3.0 reports and converge ledgers as backfill evidence (deterministic ids: running twice adds nothing)')
  .requiredOption('--from <dir>', 'Directory of rcl-report-*.json reports and rcl-converge-*-ledger.md ledgers')
  .requiredOption('--repo <owner/repo>', 'The GitHub repository the reports reviewed')
  .option('--dry-run', 'Build the runs and report counts without posting')
  .option('--json', 'Output JSON')
  .action(async (opts: { from: string; repo: string; dryRun?: boolean; json?: boolean }) => {
    const repo = parseRepoName(opts.repo);
    if (repo === null) {
      console.error(chalk.red('--repo must be a GitHub owner/repo.'));
      process.exitCode = 2;
      return;
    }
    // A dry run builds and counts; it needs no credential and sends nothing.
    // The ids still depend on the host, so a credential is used for them when
    // there is one and a placeholder named otherwise.
    const runtime = await createTelemetryRuntime({ rclVersion: RCL_VERSION, requireRepo: false });
    let host: string;
    if (runtime.sink && runtime.credential) {
      host = credentialHost(runtime.credential);
    } else if (opts.dryRun) {
      host = 'no-credential';
    } else {
      const reason = runtime.level === 'off' ? 'telemetry is off' : runtime.note ?? 'no Harness credential';
      console.error(chalk.red(`Cannot backfill: ${reason}.`));
      process.exitCode = 1;
      return;
    }
    let summary;
    try {
      summary = await runBackfill(
        { dir: opts.from, repo: `${repo.owner}/${repo.repo}`, rclVersion: RCL_VERSION, ...(opts.dryRun ? { dryRun: true } : {}) },
        {
          ...(runtime.sink ? { sink: runtime.sink } : {}),
          host,
          placeholderHost: host === 'no-credential',
          ...(opts.json ? {} : { progress: (line: string) => console.log(chalk.dim(text(line, 400))) }),
        }
      );
    } catch (err) {
      console.error(chalk.red(`Cannot backfill: ${scrubText(err instanceof Error ? err.message : String(err), 300)}`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else if (summary.dryRun) {
      console.log(
        `Would post ${summary.runs} run(s) with ${summary.planned.artifacts} artifact(s) and ${summary.planned.events} verdict event(s) ` +
          `(${summary.planned.verdicts} verdicts)${host === 'no-credential' ? ' — ids shown for a placeholder host; log in for the real ones' : ''}; ` +
          `${summary.skipped} file(s) skipped; ledgers ${summary.ledgersScanned}, bullets matched ${summary.bulletsMatched}, unmatched ${summary.bulletsUnmatched}.`
      );
      for (const f of summary.skippedFiles) console.log(chalk.dim(`  skipped ${text(f.file, 200)}: ${text(f.reason, 300)}`));
    } else {
      console.log(
        `Posted ${summary.runs} run(s): ${summary.created} new, ${summary.existing} already recorded; ` +
          `${summary.artifacts} artifact(s) uploaded for the new runs; verdict events ${summary.events.inserted} new, ${summary.events.duplicates} already recorded; ` +
          `${summary.skipped} file(s) skipped; ledgers ${summary.ledgersScanned}, bullets matched ${summary.bulletsMatched} (at build), unmatched ${summary.bulletsUnmatched}.`
      );
      for (const f of summary.skippedFiles) console.log(chalk.dim(`  skipped ${text(f.file, 200)}: ${text(f.reason, 300)}`));
      for (const f of summary.failed) console.log(chalk.red(`  failed ${text(f.file, 200)}: ${text(f.reason, 300)}`));
    }
    if (summary.failed.length > 0) process.exitCode = 1;
  });

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
  .option('--local', 'This machine’s store only; do not ask Harness for the org-wide window')
  .option('--json', 'Output JSON')
  .action(async (opts: { window: string; local?: boolean; json?: boolean }) => {
    const windowDays = Number(opts.window);
    if (!Number.isFinite(windowDays) || windowDays <= 0) {
      console.error(chalk.red('--window must be a positive number of days.'));
      process.exitCode = 1;
      return;
    }
    const stats = await loadModelStats({ windowDays });
    // The org-wide window (RCL-38): Harness's `model-stats` over every run the
    // organization recorded. Its weight wins for a model it has the outcome
    // floor for; this machine's store decides below that. The same window is
    // asked of both; the server answers up to 366 days.
    const server = opts.local
      ? ({ kind: 'none', reason: '--local' } as const)
      : !Number.isInteger(windowDays) || windowDays > 366
        ? ({ kind: 'none', reason: `the server window is whole days up to 366 (asked for ${windowDays})` } as const)
        : await fetchServerModelStats({ rclVersion: RCL_VERSION, windowDays });
    const merged = mergeWeights(stats, server.kind === 'ok' ? server.value : undefined);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            windowDays,
            dataDir: resolveDataDir(),
            models: stats,
            server: server.kind === 'ok' ? { host: server.host, ...server.value } : null,
            serverNote: server.kind === 'ok' ? null : server.reason,
            weights: merged.map(({ model, weight, source, serverOutcomes, localOutcomes }) => ({
              model,
              weight,
              source,
              ...(serverOutcomes !== undefined ? { serverOutcomes } : {}),
              ...(localOutcomes !== undefined ? { localOutcomes } : {}),
            })),
          },
          null,
          2
        )
      );
      return;
    }
    if (merged.length === 0) {
      console.log(
        `No model history in ${resolveDataDir()} yet` +
          (server.kind === 'ok' ? ` and none on ${server.host} for this window.` : ` (org-wide: ${server.reason}).`) +
          ' Converge runs record it automatically; seed from recovered artifacts with `rcl models seed --from <dir>`,' +
          ' or backfill the organization with `rcl telemetry backfill --from <dir> --repo <owner/repo>`.'
      );
      return;
    }
    console.log('\n' + chalk.bold(`Model history — trailing ${windowDays} days`) + '\n');
    console.log(
      chalk.dim(
        server.kind === 'ok'
          ? `Org-wide from ${server.host}: ${server.value.models.length} model(s), window ${server.value.window_days} days, computed ${server.value.computed_at}.`
          : `Org-wide window not used (${server.reason}); weights are this machine’s.`
      )
    );
    const pct = (v: number | null | undefined): string => (v === undefined || v === null ? '—' : `${(v * 100).toFixed(0)}%`);
    console.log(
      chalk.dim(
        'model'.padEnd(46) +
          'precision (n)'.padEnd(16) +
          'calls'.padEnd(8) +
          'dead'.padEnd(7) +
          'p50'.padEnd(8) +
          'weight'.padEnd(8) +
          'source'
      )
    );
    for (const row of merged) {
      // Every column of a row comes from one record: the server's when the
      // server weighs it, else this machine's, else the server's thin row.
      const fromServer = row.source === 'server' || (row.local === undefined && row.server !== undefined);
      const outcomes = fromServer ? (row.server?.outcomes ?? 0) : (row.local?.outcomes ?? 0);
      const precision = fromServer ? pct(row.server?.precision) : pct(row.local?.precision);
      const calls = fromServer ? (row.server?.calls ?? 0) : (row.local?.calls ?? 0);
      const dead = fromServer ? pct(row.server?.dead_rate) : pct(row.local?.deadRate);
      const p50 = fromServer ? (row.server?.p50_ms ?? null) : (row.local?.p50Ms ?? null);
      console.log(
        text(row.model, 46).padEnd(46) +
          `${outcomes > 0 ? precision : '—'} (${outcomes})`.padEnd(16) +
          String(calls).padEnd(8) +
          dead.padEnd(7) +
          (typeof p50 === 'number' ? `${(p50 / 1000).toFixed(0)}s` : '—').padEnd(8) +
          row.weight.toFixed(2).padEnd(8) +
          row.source
      );
    }
    console.log(
      chalk.dim(
        `\nWeights (0.5 + precision, clamped to [0.5, 1.5]; neutral 1 under ${MIN_OUTCOMES_FOR_WEIGHT} outcomes) ` +
          'scale each model’s consensus vote in reviews and gating. Source: server = the organization’s window on Harness, ' +
          'local = this machine’s store, neutral = neither holds enough.\n'
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
  /** Exact-head binding for patch files (IO-12475 section 8.1). */
  headSha?: string;
  baseSha?: string;
  /** Fail fast when the resolved head is not the one the caller expects. */
  expectHeadSha?: string;
  /** flag | repo_file | harness_issue:<ID> — recorded in the run header. */
  specSource?: string;
  /** Converge context, or the RCL_CONVERGE_* environment the skill exports. */
  convergeTarget?: string;
  forPr?: string;
  round?: string;
  attempt?: string;
  guardedConverge?: boolean;
  retainReviewers?: boolean;
  /** Retain guarded output creation semantics inside the post-claim execution. */
  exclusiveOutputs?: boolean;
  launchIntent?: GuardedLaunchOptions['intent'];
  retryReason?: string;
  maxAttempts?: string;
  maxRounds?: string;
  /** commander: `--no-telemetry` sets this false. */
  telemetry?: boolean;
  /** Exit 4 unless the evidence envelope was acknowledged. */
  evidenceRequired?: boolean;
  /** GitHub Actions gate workflow: exchange the job OIDC token for a run-bound credential (RCL-40). */
  attest?: boolean;
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
  /** Digest and provenance of the spec the spec-compliance role was given. */
  spec?: { source: SpecSource; sha256: string };
  /** Exact bytes from the single spec read, retained only in private checkpoints. */
  specBytes: string;
  /** Explicit --reviewer pairs: every seat is blocking, none is secondary. */
  explicit: boolean;
  /** The blocking council's own models — the roster's `blocking` lane. */
  coreModels: string[];
  converge?: ConvergeContext;
  /** When the command started; the run header records the full wall time. */
  startedAt: Date;
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
async function fetchHarnessKeys(spinner: Spinner, credential?: HarnessCredential): Promise<void> {
  const { note } = await applyHarnessModelKeys(credential ? { credential } : {});
  if (note) {
    spinner.info(note);
    spinner.start('Loading configuration...');
  }
}

async function prepareCouncil(
  spinner: Spinner,
  opts: CouncilCliOpts,
  fallbackRoles?: string[],
  attestation?: Attestation
): Promise<PreparedCouncil> {
  const startedAt = new Date();
  // Validate the converge context first: a bad --round must fail before any
  // model time is spent, not after the council has run.
  const converge = resolveConvergeContext(
    { convergeTarget: opts.convergeTarget, round: opts.round, attempt: opts.attempt },
    process.env
  );
  await fetchHarnessKeys(spinner, attestation?.credential);
  const config = await loadConfig(opts.config, undefined, { preserveDefaultRoster: opts.guardedConverge });

  if (opts.retainReviewers) {
    // Freeze effective values before either launch identity or input capture.
    config.thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
    config.output = { ...config.output, belowThresholdAppendix: config.output?.belowThresholdAppendix ?? true };
    if (resolveTelemetryLevel(config, { noTelemetry: opts.telemetry === false }, process.env) !== 'off') {
      throw new ReviewLaunchRefused('reviewer_evidence_backend_unsupported',
        'Reviewer retention requires a compatible evidence backend. This development operation currently supports --no-telemetry only; it cannot supply a server merge gate.');
    }
  }

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
  let spec: PreparedCouncil['spec'];
  const specPath = opts.spec ?? config.spec;
  // Validated before any file is read so a typo fails fast, spec or not.
  const specSource: SpecSource | undefined =
    opts.specSource !== undefined
      ? parseSpecSource(opts.specSource)
      : specPath
        ? opts.spec
          ? 'flag'
          : 'repo_file'
        : undefined;
  if (specPath) {
    try {
      specContent = await readFile(specPath, 'utf-8');
      spec = { source: specSource ?? 'flag', sha256: sha256Hex(specContent) };
    } catch {
      if (opts.guardedConverge) throw new ReviewLaunchRefused('unreadable_spec', `Could not read required spec: ${specPath}`);
      spinner.warn(`Could not read spec file: ${specPath}`);
    }
  }
  // Provenance was claimed explicitly: refuse to run with nothing to attach
  // it to, rather than dropping the claim from the header without a word.
  if (opts.specSource !== undefined && spec === undefined) {
    throw new Error(
      specPath
        ? `--spec-source was given but the spec file could not be read: ${specPath}`
        : '--spec-source was given without a spec; pass --spec <path> (or set spec in the config).'
    );
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
    deterministic: opts.guardedConverge,
  });
  if (opts.guardedConverge && explicitReviewers && built.length !== explicitReviewers.length) {
    throw new ReviewLaunchRefused('invalid_reviewers', 'Guarded review refuses unknown reviewer roles rather than removing them.');
  }

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
      : buildAssignments({ models: asyncModels, roles: generalRoles, roleMap, deterministic: opts.guardedConverge });

  const contextFiles = [...(opts.context ?? []), ...(config.context ?? [])];

  // Resolve gating now: a config error (e.g. an aggregator-routed verifier)
  // must fail before any model time is spent, and the verifier is chosen
  // under roster containment — never a provider outside the configured fleet.
  const gatingConfig = resolveGatingConfig(config.gating, [
    ...models,
    ...secondaryModels,
    ...(config.asyncModels ?? []),
  ]);

  return {
    config,
    roleMap,
    assignments,
    asyncAssignments,
    gatingConfig,
    contextFiles,
    ...(spec ? { spec } : {}),
    specBytes: specContent ?? '',
    explicit: explicitReviewers !== undefined,
    coreModels: models,
    ...(converge ? { converge } : {}),
    startedAt,
  };
}

async function runReview(target: string | undefined, opts: CouncilCliOpts & {
  staged?: boolean;
  workingTree?: boolean;
  focus?: string;
}): Promise<void> {
  const spinner = ora('Loading configuration...').start();

  try {
    if (opts.retainReviewers && !opts.guardedConverge) {
      throw new ReviewLaunchRefused('reviewer_retention_requires_guard', 'Retaining reviewer inputs requires --guarded-converge and its owned native claim.');
    }
    if (!opts.guardedConverge && (opts.launchIntent !== undefined || opts.retryReason !== undefined ||
      opts.maxAttempts !== undefined || opts.maxRounds !== undefined)) {
      throw new ReviewLaunchRefused('guard_required', 'Launch intent, retry reason and launch caps require --guarded-converge.');
    }
    if (opts.guardedConverge) {
      const converge = resolveConvergeContext(opts, process.env);
      if (!converge) throw new ReviewLaunchRefused('target_required', 'A guarded launch requires --converge-target.');
      if (converge.attempt !== undefined || opts.attest) {
        throw new ReviewLaunchRefused('incompatible_launch', 'Guarded review claims its own attempt; do not preclaim, pass --attempt, or combine it with --attest.');
      }
    }
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

    const gitMode = opts.staged ? 'staged' : opts.workingTree ? 'working-tree' : undefined;
    // Classify the positional target ONCE by shape: a GitHub PR reference is
    // a PR, anything else is a local patch file (whatever its extension or
    // path form). Both the flag gate below and the diff resolution use this
    // single decision, so they cannot diverge.
    const patchTarget = !gitMode && target !== undefined && !isGitHubTarget(target);

    // Validate the head-binding flags BEFORE any config, key, network, or
    // git work: a bad flag must fail before anything is spent or fetched.
    if ((opts.headSha !== undefined || opts.baseSha !== undefined) && !patchTarget) {
      throw new Error(
        `--head-sha and --base-sha apply to patch files only; ${
          gitMode ? `--${gitMode} resolves HEAD itself` : 'a PR target resolves its heads from GitHub'
        }.`
      );
    }
    if (opts.retainReviewers && (!patchTarget || !opts.headSha || !opts.baseSha ||
      !(opts.forPr ?? process.env['RCL_FOR_PR'])?.trim())) {
      throw new ReviewLaunchRefused('reviewer_retention_requires_binding',
        'Retaining reviewer inputs requires a patch file, --head-sha, --base-sha (effective merge base), and --for-pr.');
    }
    if (opts.headSha !== undefined) validateSha(opts.headSha, '--head-sha');
    if (opts.baseSha !== undefined) validateSha(opts.baseSha, '--base-sha');
    if (opts.expectHeadSha !== undefined) validateSha(opts.expectHeadSha, '--expect-head-sha');
    if (opts.evidenceRequired && patchTarget && opts.headSha === undefined) {
      throw new Error(
        '--evidence-required needs --head-sha for a patch file: evidence must bind to the commit it reviewed.'
      );
    }
    // --attest (RCL-40) runs before any key, config or reviewer work; an
    // attested review is recorded or it does not run, so evidence is required.
    let attestation: Attestation | undefined;
    if (opts.attest) {
      attestation = await attestBeforeReview(spinner, opts, target, gitMode);
      opts = { ...opts, evidenceRequired: true };
    }
    assertEvidenceCanBeRequired(opts);

    const prepared = await prepareCouncil(spinner, opts, undefined, attestation);
    const { config } = prepared;
    if (attestation) {
      // The loaded config is the authority; the pre-exchange check read the same file.
      const level = resolveTelemetryLevel(config, { noTelemetry: opts.telemetry === false }, process.env);
      if (level !== 'full') throw new Error(attestLevelMessage(level));
    }
    assertEvidenceCanBeRequired(opts, config);
    await assertEvidenceDeliverable(opts, config, attestation?.credential);

    spinner.text = `Resolving diff for: ${target ?? `--${gitMode}`}`;

    // Resolve diff. Git modes bracket the read with two HEAD resolutions: a
    // commit landing between them would bind the diff to a commit it was
    // not taken against, and --expect-head-sha would then vouch for it.
    let diff;
    let gitHeads: Awaited<ReturnType<typeof resolveGitHeads>> | undefined;
    if (gitMode) {
      gitHeads = await resolveGitHeads();
      diff = await loadGitDiff(gitMode);
      // Both ends of the binding must hold still: HEAD (what the diff is
      // relative to) and the merge-base (what the header records as base).
      // Index or worktree edits during the read are not guarded — the
      // diff_sha256 describes exactly the bytes that were read.
      const after = await resolveGitHeads();
      if (after.headSha !== gitHeads.headSha || after.baseSha !== gitHeads.baseSha) {
        throw new Error(
          `HEAD or its merge-base moved (${gitHeads.headSha ?? 'unknown'}/${gitHeads.baseSha ?? 'unknown'} → ${after.headSha ?? 'unknown'}/${after.baseSha ?? 'unknown'}) while the diff was being read — refusing to review; rerun once the tree is quiet.`
        );
      }
    } else if (patchTarget) {
      try {
        diff = await loadLocalDiff(target!);
      } catch (err) {
        // A mistyped PR reference lands here too; say what a target can be
        // instead of a bare ENOENT.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `No such patch file: ${target}. A review target is a local patch file, owner/repo#N, or a GitHub PR URL.`
          );
        }
        throw err;
      }
    } else {
      const prTarget = parseGitHubTarget(target!);
      diff = await fetchPRDiff(prTarget, config.githubToken);
    }

    // Resolve the head BEFORE the empty-diff exit so --expect-head-sha is
    // honored even when there is nothing to review: a moved target must
    // never read as a clean round.
    const runTarget = await resolveReviewTarget(
      diff,
      gitMode,
      {
        ...opts,
        convergeTarget: opts.convergeTarget ?? process.env['RCL_CONVERGE_TARGET'],
        // The flag is the user's word and is refused off a patch file; a value
        // left in the environment only ever attributes a patch file.
        ...(opts.forPr !== undefined
          ? { forPr: opts.forPr }
          : !diff.metadata && !gitMode && (process.env['RCL_FOR_PR'] ?? '').trim() !== ''
            ? { forPr: process.env['RCL_FOR_PR'] }
            : {}),
      },
      { gitHeads }
    );
    if (opts.expectHeadSha !== undefined) {
      assertExpectedHead(runTarget, opts.expectHeadSha);
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

    // PR and Git-mode labels identify the review target directly. Patch
    // paths identify the capture; executeCouncil scopes converging patches
    // by their native convergence target instead.
    const asyncTargetLabel = diff.metadata
      ? `${diff.metadata.owner}/${diff.metadata.repo}#${diff.metadata.number}`
      : (target ?? `git-${gitMode}-${await currentBranchLabel()}`);

    await executeCouncil(spinner, prepared, diff, opts, {
      command: 'review',
      target: runTarget,
      asyncTargetLabel,
      ...(attestation ? { attestation } : {}),
    });
  } catch (err) {
    spinner.fail(String(err));
    if (process.env['RCL_DEBUG']) {
      console.error(err);
    }
    process.exitCode = opts.guardedConverge && (err instanceof ConvergeAttemptBudgetExceededError || err instanceof ConvergeRoundCapError)
      ? 2 : opts.guardedConverge && (err instanceof ConvergeAttemptStateError || err instanceof ConvergeRunStateError) ? 3 : 1;
  }
}

/**
 * Shared back half of every council command: chunking, prompt building,
 * dispatch, consensus, and every output surface.
 */
async function prepareCouncilWork(
  spinner: Spinner,
  prepared: PreparedCouncil,
  diff: Diff,
  opts: CouncilCliOpts,
  focus?: PlanFocus
) {
  const { assignments, contextFiles } = prepared;
  const chunks = chunkDiff(diff.files);
  assertReviewWorkWithinLimit(chunks.length, assignments.length);
  spinner.text = `Building prompts (${chunks.length} chunk(s), ${assignments.length} reviewer(s))...`;
  const chunkAssignments = chunks.flatMap(chunk => assignments.map(assignment => ({ assignment, chunk })));
  const { docs: contextDocs, skipped } = await loadPromptContextDocs(contextFiles);
  if (opts.guardedConverge && skipped.length > 0) {
    throw new ReviewLaunchRefused('unreadable_context', `Required context could not be read: ${skipped.join(', ')}`);
  }
  for (const path of skipped) console.warn(`Context file not readable, not included in the review: ${path}`);
  const prompts = await Promise.all(chunkAssignments.map(({ assignment, chunk }) => buildPrompt(chunk, assignment.role, {
    contextDocs,
    plan: focus === undefined ? undefined : { focus },
  })));
  return { chunks, chunkAssignments, contextDocs, prompts };
}

interface RetainedCouncilContext {
  commonDir: string;
  ownership: NativeTargetOwnership;
  captured: CapturedPreparedCouncil;
  launch: OriginalLaunch;
  journal: CheckpointJournal;
  lateAudit: CheckpointLateAudit;
}

async function loadCouncilWeights(opts: CouncilCliOpts, attestation?: Attestation): Promise<Map<string, number> | undefined> {
  try {
    const level = resolveTelemetryLevel(await loadHarnessSettings(process.cwd(), opts.config), { noTelemetry: opts.telemetry === false }, process.env);
    const loaded = await loadMergedWeights({ rclVersion: RCL_VERSION, timeoutMs: 3_000,
      serverEnabled: level !== 'off', ...(attestation ? { credential: attestation.credential } : {}) });
    return loaded.size > 0 ? loaded : undefined;
  } catch (err) {
    console.warn(`Model weights unavailable (consensus unweighted): ${scrubText(err instanceof Error ? err.message : String(err), 300)}`);
    return undefined;
  }
}

async function executeCouncil(
  spinner: Spinner,
  prepared: PreparedCouncil,
  diff: Diff,
  opts: CouncilCliOpts,
  extra: {
    command: 'review' | 'review-plan';
    target: RunHeaderInput['target'];
    focus?: PlanFocus;
    asyncTargetLabel?: string;
    /** `--attest`: the run-bound credential and the run id it binds (RCL-40). */
    attestation?: Attestation;
  },
  preparedWork?: Awaited<ReturnType<typeof prepareCouncilWork>>,
  retained?: RetainedCouncilContext
): Promise<GuardedLaunchCompletion> {
  const { config, roleMap, assignments, asyncAssignments } = prepared;
  const planContext = extra.focus !== undefined ? { focus: extra.focus } : undefined;
  const work = preparedWork ?? await prepareCouncilWork(spinner, prepared, diff, opts, extra.focus);
  const { chunks, chunkAssignments, contextDocs, prompts } = work;
  if (opts.guardedConverge) {
    const roster = buildRoster({ assignments, asyncAssignments, coreModels: prepared.coreModels,
      explicit: prepared.explicit, gating: prepared.gatingConfig });
    const commonDir = await resolveGitCommonDir();
    const captured = opts.retainReviewers ? capturePreparedCouncil({
      target: prepared.converge!.target, headSha: extra.target.headSha!, mergeBaseSha: extra.target.baseSha!,
      diff, assignments, chunks, prompts, config, specBytes: prepared.specBytes, contextDocs,
      compatibility: { parser: { name: 'findings-json', version: 1 }, aggregation: AGGREGATION_ALGORITHM },
      aggregationInputs: captureAggregationInputs({ algorithm: AGGREGATION_ALGORITHM,
        diffSha256: diffDigest(diff.files), roleMap, thresholds: { ...DEFAULT_THRESHOLDS, ...config.thresholds },
        gating: prepared.gatingConfig, modelWeights: await loadCouncilWeights(opts),
        belowThresholdAppendix: config.output!.belowThresholdAppendix!,
      }),
    }) : undefined;
    let completion: GuardedLaunchCompletion | undefined;
    const claim = await guardReviewLaunch({
      gitCommonDir: commonDir,
      target: prepared.converge!.target,
      headSha: extra.target.headSha ?? '',
      inputSha256: captured
        ? retainedLaunchInputSha256(captured.captured.digest, { target: extra.target, roster, spec: prepared.spec })
        : sha256Hex(stableStringify({
          head: extra.target.headSha, kind: extra.target.kind, repo: extra.target.repo, pr: extra.target.prNumber,
          diff: diffDigest(diff.files), config: configDigest(config), roster, prompts,
          asyncRoles: asyncAssignments.map(assignment => assignment.role), spec: prepared.spec,
        })),
      round: prepared.converge!.round,
      intent: opts.launchIntent,
      retryReason: opts.retryReason,
      maxAttempts: opts.maxAttempts === undefined ? undefined : Number(opts.maxAttempts),
      maxRounds: opts.maxRounds === undefined ? undefined : Number(opts.maxRounds),
      validate: async () => {
        validateLaunchProviders(roster.map(entry => entry.provider));
        if (assignments.length < 2) {
          throw new ReviewLaunchRefused('insufficient_reviewers', 'Convergence needs at least two reviewer assignments for a conclusive round.');
        }
        await validateLaunchOutputs(opts);
        if (captured) {
          const plan = buildCouncilRunPlan({ totalCalls: chunkAssignments.length, reviewers: assignments.length,
            chunks: chunks.length, concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
            timeoutMs: config.timeout ?? DEFAULT_TIMEOUT_MS });
          const perCell = (config.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
          assertOriginalLaunchBudget(plan.timeoutBoundMs, chunkAssignments.length * perCell, perCell);
        }
      },
      onClaim: async claim => {
        if (opts.telemetry !== false) await reportConvergeEvents([buildEvent({
          kind: 'attempt_claimed', convergeTarget: claim.target, attempt: claim.attempt,
          payload: { attempt: claim.attempt, cap: claim.cap },
        })]);
        process.stderr.write(`Convergence attempt ${claim.attempt}/${claim.cap} claimed for ${claim.target}.\n`);
      },
      run: async (converge, ownership) => {
        let session: RetainedCouncilContext | undefined;
        if (captured) {
          const startedAtMs = Date.now();
          const plan = buildCouncilRunPlan({ totalCalls: chunkAssignments.length, reviewers: assignments.length,
            chunks: chunks.length, concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
            timeoutMs: config.timeout ?? DEFAULT_TIMEOUT_MS });
          const maxAttemptsPerCell = (config.maxRetries ?? DEFAULT_MAX_RETRIES) + 1;
          const launch = createOriginalLaunch({ runId: uuidv7(), target: converge.target,
            originalNativeClaim: { attempt: converge.attempt!, round: converge.round! },
            capturedInputsSha256: captured.captured.digest, planDigest: captured.plan.digest,
            startedAtMs, expiresAtMs: startedAtMs + plan.timeoutBoundMs,
            maxPhysicalCalls: chunkAssignments.length * maxAttemptsPerCell, maxAttemptsPerCell });
          const journal = await bindOriginalCouncil({ commonDir, ownership, captured: captured.captured, launch });
          const lateAudit = createCheckpointLateAudit({ commonDir, ownership, journal, onError: (error) => {
            process.stderr.write(`Late reviewer response could not be retained: ${scrubText(String(error), 300)}\n`);
          } });
          session = { commonDir, ownership, captured, launch, journal, lateAudit };
        }
        try {
          completion = await executeCouncil(spinner, { ...prepared, converge }, diff,
            { ...opts, guardedConverge: false, exclusiveOutputs: true }, extra, work, session);
          return completion;
        } finally {
          // Drain only responses already observed; never wait for a hanging provider.
          if (session && (await session.journal.read()).finalized) await session.lateAudit.drain();
        }
      },
    });
    if (claim.warning) process.stderr.write(`${claim.warning}\n`);
    return completion!;
  }

  // Async lane (RCL-25): fire the async reviewers with the round, never
  // await them; collect whatever arrived from earlier rounds after the
  // blocking council returns. Best-effort by design — a broken lane must
  // never fail or slow the blocking round.
  const asyncTargetLabel = extra.asyncTargetLabel;
  let asyncStoreDir: string | undefined;
  let asyncKey: string | undefined;
  let asyncLaunched = 0;
  if (
    asyncTargetLabel !== undefined &&
    (asyncAssignments.length > 0 || (config.asyncModels?.length ?? 0) > 0)
  ) {
    try {
      asyncStoreDir = await resolveAsyncStoreDir();
      asyncKey = asyncTargetKey(
        asyncTargetLabel,
        extra.target.kind === 'patch' ? prepared.converge?.target : undefined
      );
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
              contextDocs,
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
  const postReviewStage = (stage: string): void => {
    const line = `Post-review stage: ${stage}`;
    if (interactive && spinner.isSpinning) {
      spinner.text = line;
    } else {
      process.stderr.write(`${line}\n`);
    }
  };
  if (interactive) {
    spinner.text = planText;
    spinner.start();
  } else {
    spinner.stop();
    process.stderr.write(`${planText}\n`);
  }

  const progress = new CouncilProgressReporter({
    totalCalls: retained?.launch.maxPhysicalCalls ?? totalCalls,
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
    if (retained) {
      const executed = await executeCapturedOriginal({ commonDir: retained.commonDir, ownership: retained.ownership,
        journal: retained.journal, expectedPlan: retained.captured.plan, launch: retained.launch,
        onPhysicalReviewComplete: review => progress.complete(review),
        auditLateAttempt: retained.lateAudit.accept,
        onLateAuditError: error => process.stderr.write(`Late reviewer audit failed: ${scrubText(String(error), 300)}\n`),
      });
      chunkReviews = executed.reviews;
      await retained.journal.finalize(retained.ownership);
      await retained.lateAudit.flushAfterFinalization();
    } else chunkReviews = await runReviews(
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

  const projection: CheckpointReportProjection | undefined = retained ? projectCheckpointReport({ sources: [],
    successor: { runId: retained.launch.runId, proof: await retained.journal.exportProof() },
    policy: retained.captured.captured.policy,
  }) : undefined;
  if (projection) process.stderr.write(`Retained ${projection.allPhysicalAttempts.length} physical attempts; ` +
    `${projection.health.successfulSeats.length}/${projection.health.policy.seatCount} complete reviewers ` +
    `(${projection.health.policy.minimumSuccessful} required).\n`);

  postReviewStage('collecting and merging reviewer outputs');

  // Collect async results from earlier rounds of this target (marked async).
  // Report assembly collapses the completed calls to one (model, role) review.
  let arrivedAsync: ModelReview[] = [];
  if (asyncStoreDir && asyncKey) {
    try {
      arrivedAsync = await collectAsyncResults(asyncStoreDir, asyncKey);
    } catch (err) {
      console.warn(`Could not collect async reviewer results: ${String(err)}`);
    }
  }

  // RCL-27: every call feeds the cross-run model history (fail-soft — the
  // stats store must never break a review).
  try {
    const ts = new Date().toISOString();
    await appendCalls(
      [...(projection ? projection.newPhysicalAttempts.flatMap(attempt => attempt.review ? [attempt.review] : []) : chunkReviews), ...arrivedAsync].map((r) => ({
        ts,
        model: r.model,
        role: r.role,
        durationMs: r.durationMs,
        status: r.status,
        source: 'live' as const,
      }))
    );
  } catch (err) {
    // Stats are advisory; reviews must not fail over them — but a broken
    // store should not be invisible either.
    console.warn(`Model-stats store unavailable (call history not recorded): ${String(err)}`);
  }

  // Trailing-precision weights scale each model's consensus vote. An empty
  // history means no weighting (and no weight noise in the report).
  // Org-wide history from Harness outranks this machine's store for a model
  // the org has enough outcomes for (RCL-38); the server is asked with a
  // short bound and the local store stands in when it cannot answer.
  // Telemetry off means nothing leaves the machine for weights either. The
  // server side is bounded to three seconds; the settings file and the local
  // store are read as local files.
  // An attested review may outlast its credential: from here on — the
  // weights read, then delivery — the credential is renewed for the same run
  // id when little of it remains (RCL-40).
  let attestation = extra.attestation;
  if (attestation) {
    const renewal = await renewAttestation(attestation, { rclVersion: RCL_VERSION });
    attestation = renewal.attestation;
    if (renewal.renewed) {
      process.stderr.write(chalk.dim(`Attestation renewed for run ${attestation.runId} (expires ${attestation.expiresAt})`) + '\n');
    } else if (renewal.failure !== undefined) {
      process.stderr.write(chalk.dim(`Attestation not renewed (${renewal.failure}); continuing with the credential in hand`) + '\n');
    }
  }

  const modelWeights = retained ? undefined : await loadCouncilWeights(opts, attestation);

  const assemblyInput: CompletedReviewInput = {
    chunkReviews,
    arrivedAsync,
    asyncLaunched,
    startTime,
    roleMap,
    config,
    diff,
    gatingConfig: prepared.gatingConfig,
    modelWeights,
    run: {
      id: retained?.launch.runId ?? extra.attestation?.runId,
      rclVersion: RCL_VERSION,
      command: extra.command,
      target: extra.target,
      roster: buildRoster({
        assignments,
        asyncAssignments,
        coreModels: prepared.coreModels,
        explicit: prepared.explicit,
        gating: prepared.gatingConfig,
      }),
      ...(prepared.spec ? { spec: prepared.spec } : {}),
      contextFiles: contextDocs.map((d) => ({ path: d.label, sha256: d.sha256 })),
      // Record the effective focus that shaped the plan prompts.
      ...(extra.command === 'review-plan' ? { plan: { focus: extra.focus ?? 'comprehensive' } } : {}),
      runner: detectRunner(process.env, hostname()),
      startedAt: prepared.startedAt,
      ...(prepared.converge ? { converge: prepared.converge } : {}),
    },
  };
  const assemblyDependencies: AssemblyDependencies = {
    onStage: postReviewStage,
    onVerificationStart: () => { spinner.text = 'Verifying single-model findings...'; },
    onVerificationProgress: (event) => {
      const line =
        `Verification ${event.completedBatches}/${event.totalBatches} batches ` +
        `(${event.completedCandidates}/${event.totalCandidates} findings)`;
      if (interactive) {
        spinner.text = line;
      } else {
        const stride = Math.max(1, Math.ceil(event.totalBatches / 20));
        if (
          event.completedBatches === 0 ||
          event.completedBatches === event.totalBatches ||
          event.completedBatches % stride === 0
        ) {
          process.stderr.write(`${line}\n`);
        }
      }
    },
  };
  const checkpointAssembly: CheckpointAssemblyInput | undefined = projection ? {
    projection, supplementalAsync: captureSupplementalAsync(arrivedAsync.map(review => JSON.stringify(review)), asyncLaunched),
    diff, startTime, run: assemblyInput.run,
  } : undefined;
  const result = checkpointAssembly
    ? (await assembleCheckpointReview(checkpointAssembly, assemblyDependencies)).report
    : await assembleCompletedReview(assemblyInput, assemblyDependencies);
  if (checkpointAssembly) result.run.reviewer_evidence = describeReviewerEvidence(
    projection!.proofs.at(-1)!.proof, checkpointAssembly.supplementalAsync);
  const { run } = result;

  spinner.succeed('Review complete');
  process.stderr.write(
    chalk.dim(
      `Reviewed ${describeRunTarget(run.target)} · run ${run.id}` +
        (run.converge ? ` · converge ${run.converge.target} round ${run.converge.round ?? '?'}` : '')
    ) + '\n'
  );
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

  // Evidence delivery (IO-12475 section 8) is fail-soft: nothing in it may
  // turn a finished review into a failure unless --evidence-required asks.
  let runtime: TelemetryRuntime | undefined;
  let runtimeError: string | undefined;
  try {
    runtime = await createTelemetryRuntime({
      rclVersion: RCL_VERSION,
      config,
      noTelemetry: opts.telemetry === false,
      ...(attestation ? { credential: attestation.credential } : {}),
    });
  } catch (err) {
    // Kept for the --evidence-required verdict below, which names the cause.
    runtimeError = scrubText(String(err), 200);
    process.stderr.write(chalk.dim(`Evidence delivery unavailable: ${runtimeError}`) + '\n');
  }
  // The report as it may leave the machine — free text scrubbed, a parse
  // failure reduced to the parser message unless harness.parseFailures opts
  // in. --json-file and --markdown are written from the same view, so the
  // declared digests match the files and nothing raw travels. With
  // Legacy telemetry-off output stays raw; retained reviews always separate
  // sanitized ordinary output from the exact private reviewer artifact.
  const delivered =
    retained || (runtime && runtime.level !== 'off')
      ? sanitizeForDelivery(result, { parseFailures: runtime?.parseFailures ?? false }) : result;
  postReviewStage('rendering report artifacts');
  const artifacts = renderReportArtifacts(delivered);
  if (retained && checkpointAssembly) {
    const reviewerArtifact = serializeReviewerArtifact({ assembly: checkpointAssembly, reportBytes: artifacts.report_json,
      representation: { version: 1, parseFailures: runtime?.parseFailures ?? false } });
    await retained.journal.retainTerminalReport({ reportBytes: artifacts.report_json, reviewerArtifactBytes: reviewerArtifact.bytes }, retained.ownership);
  }

  // Output
  if (opts.json) {
    console.log(artifacts.report_json);
  } else {
    printReviewSummary(result);
  }

  const outputDiagnostics = await writeReportArtifacts(artifacts, { ...opts, exclusive: opts.guardedConverge || opts.exclusiveOutputs }, {
    onWritten: (label, path) => console.log(chalk.dim(`${label} written to: ${path}`)),
    onError: (message) => process.stderr.write(chalk.red(message) + '\n'),
  });

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

  // A failed requested output must not prevent delivery or immutable recovery
  // retention of the rendered originals. Try both files before any exit code.
  const evidenceRequired = opts.evidenceRequired === true;
  const delivery: DeliveryOutcome = runtime
    ? await deliverRun(runtime, { result: delivered, artifacts, evidenceRequired, outputDiagnostics }).catch((err: unknown) => ({
        status: 'error' as const,
        line: `Evidence delivery failed: ${scrubText(String(err), 300)}`,
        exitCode: evidenceRequired ? (4 as const) : (0 as const),
        spooled: false,
      }))
    : {
        status: 'off',
        line: evidenceRequired ? `Evidence not sent: telemetry could not be set up (${runtimeError ?? 'unknown cause'})` : '',
        exitCode: evidenceRequired ? 4 : 0,
        spooled: false,
      };
  if (delivery.line !== '') process.stderr.write(chalk.dim(delivery.line) + '\n');
  // The flush hint is honest only when something was spooled to flush.
  const evidenceFailure = [
    `Evidence was not recorded (--evidence-required): ${delivery.line || delivery.status}.`,
    delivery.spooled
      ? `Retry delivery with \`rcl telemetry flush --run ${delivery.runId}\` rather than re-running the review.`
      : undefined,
    delivery.retention?.status === 'complete'
      ? `Original reports are retained; inspect them with \`rcl telemetry rejected --run ${delivery.runId}\` before supported recovery.`
      : delivery.retention?.status === 'failed'
        ? `Original report retention failed: ${delivery.retention.error ?? 'unknown error'}.`
        : undefined,
  ].filter((part): part is string => part !== undefined).join(' ');
  if (opts.exclusiveOutputs && outputDiagnostics.some(diagnostic => diagnostic.path === 'output.report_json') &&
    !retained && !delivery.spooled && delivery.status !== 'recorded' && delivery.retention?.status !== 'complete') {
    throw new ReviewLaunchRefused('report_write_failed',
      'The JSON report could not be retained. This attempt remains spent; correct the output path before an explicit bounded retry.');
  }
  const completion: GuardedLaunchCompletion = {
    runId: run.id,
    reportJsonSha256: sha256Hex(artifacts.report_json),
    successfulReviews: projection?.health.successfulSeats.length ?? result.stats.successfulReviews,
    totalReviews: projection?.health.policy.seatCount ?? result.stats.totalReviews,
    ...(projection ? { reviewerHealth: { version: 1 as const, policy: projection.health.policy,
      successfulSeats: projection.health.successfulSeats.length } } : {}),
    deliveryPending: delivery.spooled || delivery.exitCode !== 0,
    hardFailure: chunkReviews.some(review => review.status === 'error' || review.status === 'parse_failed'),
  };

  // CI mode: fail on a fully-failed run or on blocking findings. The gate
  // verdict keeps its exit code — pipelines branch on it — and an evidence
  // failure is reported beside it.
  if (opts.ci) {
    const verdict = evaluateCiGate(result, projection?.health);
    if (verdict.exitCode !== 0) {
      console.error(chalk.red(`\n${verdict.message}`));
      if (delivery.exitCode !== 0) console.error(chalk.red(evidenceFailure));
      process.exitCode = verdict.exitCode;
      return completion;
    }
  }
  if (delivery.exitCode !== 0) {
    console.error(chalk.red(evidenceFailure));
    process.exitCode = delivery.exitCode;
    return completion;
  }
  if (outputDiagnostics.length > 0) process.exitCode = 1;
  return completion;
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
    // A plan is not a commit: the review-plan command declares none of the
    // head-binding flags, and this guard keeps any future path that shares
    // the option type from carrying one that would then be silently ignored.
    if (opts.headSha !== undefined || opts.baseSha !== undefined || opts.expectHeadSha !== undefined) {
      throw new Error(
        '--head-sha, --base-sha and --expect-head-sha do not apply to plan reviews; a plan is bound by its content digest.'
      );
    }
    assertEvidenceCanBeRequired(opts);

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
    assertEvidenceCanBeRequired(opts, prepared.config);
    await assertEvidenceDeliverable(opts, prepared.config);

    spinner.text = `Loading plan: ${file}`;
    const diff = await loadPlanAsDiff(file);

    // Plan reviews get an async lane too: re-reviewing the same plan file
    // collects what the previous run fired.
    await executeCouncil(spinner, prepared, diff, opts, {
      command: 'review-plan',
      target: { kind: 'plan' },
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
