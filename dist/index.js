#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { loadConfig } from './config/loader.js';
import { parseGitHubTarget, fetchPRDiff } from './resolver/github.js';
import { loadLocalDiff } from './resolver/local.js';
import { chunkDiff } from './prepare/chunker.js';
import { buildPrompt } from './prepare/prompt-builder.js';
import { BUILTIN_ROLES, getRoleByName } from './roles/builtin.js';
import { resolveRoles, loadProjectRulesContent } from './roles/loader.js';
import { buildAssignments } from './roles/dispatcher.js';
import { runReviews } from './dispatch/runner.js';
import { deduplicateFindings } from './consensus/deduper.js';
import { computeConsensus } from './consensus/voter.js';
import { printReviewSummary } from './output/terminal.js';
import { postGitHubReview } from './output/github.js';
import { toJson, writeJsonOutput } from './output/json.js';
import { writeMarkdownOutput } from './output/markdown.js';
const program = new Command();
program
    .name('rcl')
    .description('Review Council — multi-model AI code review')
    .version('1.0.0');
// review command
program
    .command('review <target>')
    .description('Review a PR or local diff. Target: owner/repo#N, GitHub PR URL, or path to .patch file')
    .option('--role <name>', 'Use a single named role')
    .option('--roles <names>', 'Comma-separated list of roles')
    .option('--reviewer <pair>', 'Explicit model:role pair (repeatable)', (val, prev) => {
    prev.push(val);
    return prev;
}, [])
    .option('--context <path>', 'Context file or directory to include (repeatable)', (val, prev) => {
    prev.push(val);
    return prev;
}, [])
    .option('--spec <path>', 'Specification file for spec-compliance role')
    .option('--models <models>', 'Comma-separated list of models to use')
    .option('--focus <areas>', 'Comma-separated focus areas')
    .option('--post', 'Post review as GitHub PR comment')
    .option('--json', 'Output JSON to stdout')
    .option('--json-file <path>', 'Write JSON output to file')
    .option('--markdown <path>', 'Write Markdown report to file')
    .option('--ci', 'CI mode: exit non-zero if critical/important findings')
    .option('--config <path>', 'Path to config file')
    .action(async (target, opts) => {
    await runReview(target, opts);
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
        console.log(`  ${chalk.cyan(role.name.padEnd(22))} ${tag}  ${chalk.dim(role.description)}`);
    }
    console.log('');
});
rolesCmd
    .command('show <name>')
    .description('Show details for a specific role')
    .action((name) => {
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
async function runReview(target, opts) {
    const spinner = ora('Loading configuration...').start();
    try {
        // Load config
        const config = await loadConfig(opts.config);
        // Validate mutually exclusive role options
        const roleOptionCount = [opts.role, opts.roles, opts.reviewer?.length].filter(Boolean).length;
        if (roleOptionCount > 1) {
            spinner.fail('--role, --roles, and --reviewer are mutually exclusive');
            process.exit(1);
        }
        // Override models from CLI
        if (opts.models) {
            config.models = opts.models.split(',').map((s) => s.trim());
        }
        // Determine roles to use
        let requestedRoles;
        let explicitReviewers;
        if (opts.role) {
            requestedRoles = [opts.role];
        }
        else if (opts.roles) {
            requestedRoles = opts.roles.split(',').map((s) => s.trim());
        }
        else if (opts.reviewer && opts.reviewer.length > 0) {
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
        }
        // Load spec file
        let specContent;
        const specPath = opts.spec ?? config.spec;
        if (specPath) {
            try {
                specContent = await readFile(specPath, 'utf-8');
            }
            catch {
                spinner.warn(`Could not read spec file: ${specPath}`);
            }
        }
        // Load project rules
        const projectRulesContent = await loadProjectRulesContent();
        // Resolve roles
        const roles = await resolveRoles(config, requestedRoles, projectRulesContent ?? undefined, specContent);
        if (roles.length === 0) {
            spinner.fail('No roles resolved. Check your --role/--roles flags.');
            process.exit(1);
        }
        // Build role map for voter
        const roleMap = new Map();
        for (const role of roles) {
            roleMap.set(role.name, role);
        }
        // Build assignments
        const models = config.models ?? ['claude-opus-4-6'];
        const assignments = buildAssignments({
            models,
            roles,
            explicitReviewers,
            roleMap,
        });
        spinner.text = `Resolving diff for: ${target}`;
        // Resolve diff
        let diff;
        const isLocalFile = target.endsWith('.patch') ||
            target.endsWith('.diff') ||
            target.startsWith('./') ||
            target.startsWith('/');
        if (isLocalFile) {
            diff = await loadLocalDiff(target);
        }
        else {
            const prTarget = parseGitHubTarget(target);
            diff = await fetchPRDiff(prTarget, config.githubToken);
        }
        if (diff.files.length === 0) {
            spinner.warn('No files found in diff. Nothing to review.');
            process.exit(0);
        }
        // Chunk the diff
        const chunks = chunkDiff(diff.files);
        spinner.text = `Building prompts (${chunks.length} chunk(s), ${assignments.length} reviewer(s))...`;
        // Build context options
        const contextFiles = [
            ...(opts.context ?? []),
            ...(config.context ?? []),
        ];
        // Build prompts for each assignment × chunk (using first chunk for simplicity, multi-chunk support TBD)
        const primaryChunk = chunks[0];
        const prompts = await Promise.all(assignments.map((assignment) => buildPrompt(primaryChunk, assignment.role, {
            contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
            specFile: specPath,
        })));
        spinner.text = `Running ${assignments.length} reviews...`;
        spinner.start();
        const startTime = Date.now();
        const completedReviews = [];
        const reviews = await runReviews(assignments, prompts, {
            timeoutMs: config.timeout ?? 120_000,
            maxRetries: config.maxRetries ?? 3,
            concurrency: config.concurrency ?? 6,
            onReviewComplete: (review) => {
                completedReviews.push(review);
                const done = completedReviews.length;
                const total = assignments.length;
                const icon = review.status === 'success' ? '✓' : review.status === 'timeout' ? '⏱' : '✗';
                spinner.text = `Reviews: ${done}/${total} [${icon} ${review.model}/${review.role}]`;
            },
        });
        spinner.text = 'Computing consensus...';
        // Deduplicate and compute consensus
        const groups = deduplicateFindings(reviews, config.thresholds?.jaccardThreshold ?? 0.3, config.thresholds?.dedupeLineWindow ?? 5);
        const consensusFindings = computeConsensus(groups, reviews, roleMap);
        const totalRawFindings = reviews.reduce((sum, r) => sum + r.findings.length, 0);
        const result = {
            reviews,
            findings: consensusFindings,
            stats: {
                totalReviews: reviews.length,
                successfulReviews: reviews.filter((r) => r.status === 'success').length,
                totalRawFindings,
                totalDeduped: consensusFindings.length,
                durationMs: Date.now() - startTime,
            },
        };
        spinner.succeed('Review complete');
        // Output
        if (opts.json) {
            console.log(toJson(result));
        }
        else {
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
        if (opts.post && diff.metadata) {
            const postSpinner = ora('Posting review to GitHub...').start();
            try {
                await postGitHubReview(result, diff.metadata, config.githubToken);
                postSpinner.succeed('Review posted to GitHub');
            }
            catch (err) {
                postSpinner.fail(`Failed to post to GitHub: ${String(err)}`);
            }
        }
        // CI mode: exit non-zero if critical/important findings
        if (opts.ci) {
            const blocking = result.findings.filter((f) => f.severity === 'critical' || f.severity === 'important');
            if (blocking.length > 0) {
                console.error(chalk.red(`\nCI: ${blocking.length} blocking finding(s) found. Exiting with code 1.`));
                process.exit(1);
            }
        }
    }
    catch (err) {
        spinner.fail(String(err));
        if (process.env['RCL_DEBUG']) {
            console.error(err);
        }
        process.exit(1);
    }
}
program.parse();
//# sourceMappingURL=index.js.map