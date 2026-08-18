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

  return { config, roleMap, assignments, asyncAssignments, contextFiles };
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

  spinner.text = 'Computing consensus...';

  // Deduplicate and compute consensus
  const groups = deduplicateFindings(
    reviews,
    config.thresholds?.jaccardThreshold ?? DEFAULT_THRESHOLDS.jaccardThreshold,
    config.thresholds?.dedupeLineWindow ?? DEFAULT_THRESHOLDS.dedupeLineWindow,
    config.thresholds?.minConsensusScore ?? DEFAULT_THRESHOLDS.minConsensusScore
  );

  const consensusFindings = computeConsensus(groups, reviews, roleMap, {
    lineWindow: config.thresholds?.dedupeLineWindow,
    jaccardThreshold: config.thresholds?.jaccardThreshold,
  });

  const { kept: reportFindings, dropped: droppedFindings } = applyReportThresholds(
    consensusFindings,
    {
      minConfidence: config.thresholds?.minConfidence,
      minConsensusScore: config.thresholds?.minConsensusScore,
    }
  );

  const keepAppendix = config.output?.belowThresholdAppendix ?? true;
  const totalRawFindings = reviews.reduce((sum, r) => sum + r.findings.length, 0);
  const result: ReviewResult = {
    reviews,
    findings: reportFindings,
    ...(keepAppendix && droppedFindings.length > 0
      ? { belowThresholdFindings: droppedFindings }
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
