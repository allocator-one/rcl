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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
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

/**
 * Reject a symlink anywhere along `root/relPath`'s path components. The clone
 * is fresh, but its committed tree is the consumer repository's own content;
 * a symlink at, say, `.claude` would make the writes/removals below follow it
 * outside the temporary clone. A component that does not exist yet is fine —
 * `mkdirSync`/`writeFileSync` will create it.
 */
function assertNoUnsafeSymlink(root, relPath) {
  let cur = root;
  for (const part of relPath.split(/[/\\]/)) {
    cur = join(cur, part);
    let stat;
    try {
      stat = lstatSync(cur);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to sync through symlink: ${cur}`);
  }
}

function syncOne({ repo, base }, ref, files, dryRun) {
  const work = mkdtempSync(join(tmpdir(), 'rcl-skill-sync-'));
  try {
    const dir = join(work, 'repo');
    run('gh', ['repo', 'clone', repo, dir, '--', '--depth', '1', '--branch', base, '--quiet']);
    const git = (...args) => run('git', ['-C', dir, ...args]);
    for (const owned of ownedDirs()) {
      assertNoUnsafeSymlink(dir, owned);
      rmSync(join(dir, owned), { recursive: true, force: true });
    }
    for (const [path, content] of files) {
      assertNoUnsafeSymlink(dir, dirname(path));
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git('add', '--all', '--force', '--', ...ownedDirs());
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
    // `--head <branch>` alone can match a same-named branch on a fork (a PR opened by an
    // outside contributor from their own fork's `rcl-skill-sync` branch). Restrict to
    // same-repository PRs so the sync never adopts and rebrands an attacker's PR as its own.
    const open = run('gh', ['pr', 'list', '-R', repo, '--head', SYNC_BRANCH, '--state', 'open',
      '--json', 'number,isCrossRepository', '--jq', '[.[] | select(.isCrossRepository | not)][0].number // empty']);
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
  const nextValue = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ref') args.ref = nextValue(arg, i++);
    else if (arg === '--only') args.only = nextValue(arg, i++);
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.ref) throw new Error('--ref <tag or commit> is required');
  return args;
}

/** The checkout must actually be at `ref`, or the rendered files, the commit
 * message and the PR body would all misattribute content to a release they
 * were never built from. Checking HEAD alone isn't enough: `renderVendoredFiles`
 * reads skill sources from the working tree, not from git objects, so an
 * uncommitted or untracked edit at the right HEAD would still be rendered and
 * attributed to `ref`. Require a clean tree (tracked and untracked) too. */
function assertCheckoutMatchesRef(ref) {
  const resolved = run('git', ['-C', ROOT, 'rev-parse', '--verify', `${ref}^{commit}`]);
  const head = run('git', ['-C', ROOT, 'rev-parse', 'HEAD']);
  if (resolved !== head) {
    throw new Error(`checkout HEAD (${head}) does not match --ref ${ref} (${resolved}); run from a checkout of that tag`);
  }
  const dirty = run('git', ['-C', ROOT, 'status', '--porcelain']);
  if (dirty !== '') {
    throw new Error(`checkout has uncommitted or untracked changes; refusing to attribute them to ${ref}:\n${dirty}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { ref, only, dryRun } = parseArgs(process.argv.slice(2));
  assertCheckoutMatchesRef(ref);
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
