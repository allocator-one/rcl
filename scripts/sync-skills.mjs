#!/usr/bin/env node
/**
 * Sync the vendored rcl and rcl-converge skills into every consumer repository.
 *
 *   node scripts/sync-skills.mjs --ref v4.5.0 [--only owner/repo] [--dry-run]
 *
 * Renders the skills from this checkout (which must be at --ref) with
 * `renderVendored`, then for each repository in skills/consumers.json: clones its
 * base branch, replaces the contents of every rcl skill directory, and when that
 * changes anything, force-pushes the bot-owned `rcl-skill-sync` branch and opens
 * or updates one pull request. An up-to-date consumer is left alone. GitHub
 * access comes from GH_TOKEN (the sync workflow's app token); nothing is printed
 * from it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS, TARGETS, readSource, renderVendored } from './build-skills.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SYNC_BRANCH = 'rcl-skill-sync';
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function readConsumers(path = join(ROOT, 'skills', 'consumers.json')) {
  const { consumers } = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(consumers) || consumers.length === 0) throw new Error('no consumers configured');
  const seen = new Set();
  for (const { repo, base } of consumers) {
    if (!REPO_PATTERN.test(repo ?? '')) throw new Error(`invalid consumer repository: ${repo}`);
    if (!/^[A-Za-z0-9._/-]+$/.test(base ?? '')) throw new Error(`invalid base branch for ${repo}: ${base}`);
    if (repo === 'allocator-one/rcl') throw new Error('rcl cannot consume its own skills');
    if (seen.has(repo)) throw new Error(`duplicate consumer: ${repo}`);
    seen.add(repo);
  }
  return consumers;
}

/** Every vendored file, keyed by repository-relative path. */
export function renderVendoredFiles(ref) {
  const files = new Map();
  for (const skill of SKILLS) {
    const source = readSource(skill);
    for (const target of TARGETS) files.set(`${target.dir}/skills/${skill}/SKILL.md`, renderVendored(source, target, skill, ref));
  }
  return files;
}

/** The skill directories the sync owns outright: anything else inside them is removed. */
export function ownedDirs() {
  return SKILLS.flatMap((skill) => TARGETS.map((target) => `${target.dir}/skills/${skill}`));
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function syncOne({ repo, base }, ref, files, dryRun) {
  const work = mkdtempSync(join(tmpdir(), 'rcl-skill-sync-'));
  try {
    const dir = join(work, 'repo');
    run('gh', ['repo', 'clone', repo, dir, '--', '--depth', '1', '--branch', base, '--quiet']);
    const git = (...args) => run('git', ['-C', dir, ...args]);
    for (const owned of ownedDirs()) rmSync(join(dir, owned), { recursive: true, force: true });
    for (const [path, content] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git('add', '--all', '--', ...ownedDirs());
    if (git('status', '--porcelain', '--', ...ownedDirs()) === '') return `${repo}: up to date`;
    if (dryRun) return `${repo}: would sync\n${git('status', '--short', '--', ...ownedDirs())}`;

    git('-c', 'user.name=rcl skill sync', '-c', 'user.email=rcl-skill-sync@users.noreply.github.com',
      'commit', '--quiet', '-m', `Sync rcl skills from rcl ${ref}`, '-m',
      `Rendered from allocator-one/rcl ${ref} skills/src by scripts/sync-skills.mjs. Do not edit these files here; edit the upstream source.`);
    git('checkout', '--quiet', '-B', SYNC_BRANCH);
    run('git', ['-C', dir, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      'push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${SYNC_BRANCH}`]);

    const title = `Sync rcl skills from rcl ${ref}`;
    const body = [
      `Replaces the vendored \`rcl\` and \`rcl-converge\` skills with the versions rendered from [allocator-one/rcl ${ref}](https://github.com/allocator-one/rcl/tree/${ref}/skills/src).`,
      '',
      'Opened by rcl\'s **Sync skills** workflow after a release. The skill directories are owned by that sync: edit `skills/src` in allocator-one/rcl instead of these files. Repository-specific review rules belong in this repository\'s `AGENTS.md` or `CLAUDE.md`.',
    ].join('\n');
    const open = run('gh', ['pr', 'list', '-R', repo, '--head', SYNC_BRANCH, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty']);
    if (open) {
      run('gh', ['pr', 'edit', open, '-R', repo, '--title', title, '--body', body]);
      return `${repo}: updated #${open}`;
    }
    return `${repo}: opened ${run('gh', ['pr', 'create', '-R', repo, '--base', base, '--head', SYNC_BRANCH, '--title', title, '--body', body])}`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = { ref: null, only: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ref') args.ref = argv[++i];
    else if (arg === '--only') args.only = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.ref) throw new Error('--ref <tag or commit> is required');
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { ref, only, dryRun } = parseArgs(process.argv.slice(2));
  const files = renderVendoredFiles(ref);
  const consumers = readConsumers().filter((consumer) => !only || consumer.repo === only);
  if (only && consumers.length === 0) throw new Error(`${only} is not a configured consumer`);
  let failed = 0;
  for (const consumer of consumers) {
    try {
      console.log(syncOne(consumer, ref, files, dryRun));
    } catch (error) {
      failed++;
      console.error(`${consumer.repo}: sync failed: ${error.stderr?.trim() || error.message}`);
    }
  }
  if (failed) process.exit(1);
}
