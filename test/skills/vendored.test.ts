import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM build script, no type declarations
import { readSource, render, renderVendored, renderAll, SKILLS, TARGETS } from '../../scripts/build-skills.mjs';
// @ts-expect-error -- plain ESM script, no type declarations
import { consumerRepositoryNames, readConsumers, renderVendoredFiles, ownedDirs } from '../../scripts/sync-skills.mjs';

type Target = { dir: string; flavor: string; prefix: string };
const REF = 'v9.9.9';
const vendored = (): Map<string, string> => renderVendoredFiles(REF);

describe('vendored skills', () => {
  it('name the upstream ref and carry no markers', () => {
    for (const [path, content] of vendored()) {
      expect(content, path).toMatch(/^---\n[\s\S]*?\n---\n\n<!-- VENDORED — do not edit here\. Upstream: allocator-one\/rcl v9\.9\.9, skills\/src\/rcl(-converge)?\.md\n/);
      expect(content, path).not.toMatch(/\{\{[#/]?(PREFIX|DIR|claude|codex|source|vendored)\}?\}/);
      expect(content, path).not.toContain('GENERATED FILE');
    }
  });

  it('drop text that only applies inside the rcl repository', () => {
    for (const [path, content] of vendored()) {
      expect(content, path).not.toContain("Review Council's own source");
      expect(content, path).not.toContain('npm run build && npm link');
      expect(content, path).not.toContain('`npm run lint` (type-check) and `npm test` (vitest suite)');
      if (path.includes('/rcl-converge/')) expect(content, path).toContain("run this repository's required quality gates");
    }
    // …while this repository's own copies keep it.
    const own = new Map((renderAll() as Array<{ path: string; content: string }>).map(({ path, content }) => [path.replaceAll('\\', '/'), content]));
    for (const [path, content] of own) {
      if (path.endsWith('/rcl/SKILL.md')) expect(content, path).toContain("Review Council's own source");
      if (path.includes('/rcl-converge/')) expect(content, path).not.toContain("run this repository's required quality gates");
    }
  });

  it('keep the review safeguards in every copy', () => {
    const copies: Array<[string, string]> = [...vendored()];
    for (const skill of SKILLS as string[]) {
      for (const target of TARGETS as Target[]) copies.push([`${target.dir}/${skill} (own)`, render(readSource(skill), target, skill)]);
    }
    for (const [path, content] of copies) {
      // A Bash(rcl_run ...:*) allowlist entry would auto-approve anything typed
      // after its fixed prefix, since rcl_run ends in `env -i "$@"` — the review
      // launch must always prompt, never be silently auto-approved.
      expect(content, path).not.toMatch(/Bash\(rcl_run/);
      // Same reasoning for the bare, unwrapped forms: a leftover
      // Bash(rcl review:*) or Bash(rcl --version) entry would auto-approve the
      // exact unverified launch step 3's checks exist to prevent, and
      // Bash(nohup:*) would let any command bypass a prompt merely by being
      // wrapped in nohup (the Claude Code launch convention).
      expect(content, path).not.toMatch(/Bash\(rcl review/);
      expect(content, path).not.toContain('Bash(rcl --version)');
      expect(content, path).not.toMatch(/Bash\(nohup/);
      expect(content, path).toContain('untrusted data');
      expect(content, path).toContain('--no-ext-diff --no-textconv');
      if (path.includes('rcl-converge')) {
        expect(content, path).toContain('rcl_run <TOKEN_ARG> "$RCL_BIN" review <target> --guarded-converge');
        expect(content, path).toContain('`<TOKEN_ARG>` is `GITHUB_TOKEN="$(gh auth token)"`');
        expect(content, path).toContain('step 2a disclosure check');
      } else {
        expect(content, path).toContain('### 2a. Check what leaves the machine');
        expect(content, path).toContain('never pin a version');
        expect(content, path).toContain('npm install -g --ignore-scripts "@allocator-one/rcl@<RCL_LATEST>"');
        // The legacy package owns the same `rcl` bin; it must be removed before the install, never installed.
        expect(content, path).toContain('(cd <RCL_TMP> && npm uninstall -g --ignore-scripts review-council &&\n  npm install -g --ignore-scripts "@allocator-one/rcl@<RCL_LATEST>"');
        expect(content.split('no PATH entry is left outside the repository under review').length - 1, path).toBe(2);
        expect(content, path).not.toMatch(/npm (install|view)[^\n]*review-council@/);
        expect(content, path).toContain('Bash(npm view @allocator-one/rcl:*)');
        expect(content, path).toContain('dist.integrity --prefix <RCL_TMP> --registry https://registry.npmjs.org --@allocator-one:registry=https://registry.npmjs.org --proxy=null --https-proxy=null --strict-ssl=true)" = "<RCL_INTEGRITY>"');
        // --ca=null/--cafile=null hang or fail on npm 11 (CLI-179); a project .npmrc is kept out by running from the private directory.
        for (const block of content.match(/```bash\n[\s\S]*?\n```/g) ?? []) {
          if (/\bnpm /.test(block)) expect(block, path).not.toMatch(/--ca=null|--cafile=null/);
          expect(block, path).not.toMatch(/printenv|\| tr /);
        }
        expect(content, path).toContain('--@allocator-one:registry=https://registry.npmjs.org');
        expect(content, path).toContain('/usr/bin/env -i "$@"');
        expect(content, path).toContain('--registry https://registry.npmjs.org');
        expect(content, path).toContain('--proxy=null');
        expect(content, path).not.toContain('NPM_TRUST_FLAGS');
        expect(content, path).toContain('inside the repository under review');
        expect(content, path).toContain('Never fall back to an older installed release');
        expect(content, path).not.toContain('npm install -g review-council@latest');
        expect(content, path).toContain('env -i "$@"');
        expect(content, path).toContain('rcl_run GITHUB_TOKEN="$(gh auth token)" "$RCL_BIN" review');
        expect(content, path).not.toContain('rcl_run rcl review');
        expect(content, path).not.toMatch(/^GITHUB_TOKEN=\$\(gh auth token\) rcl review/m);
        const helperStart = content.indexOf('rcl_run() {');
        const helperEnd = content.indexOf('env -i "$@"');
        expect(helperStart, `${path} has an rcl_run() { definition`).toBeGreaterThanOrEqual(0);
        expect(helperEnd, `${path} has an env -i "$@" body`).toBeGreaterThan(helperStart);
        const helper = content.slice(helperStart, helperEnd);
        expect(helper, `${path} helper slice contains the real body`).toContain('ANTHROPIC_API_KEY');
        for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'BASH_ENV', 'AWS_', 'GOOGLE_APPLICATION_CREDENTIALS']) {
          expect(helper, `${path} keeps ${name}`).not.toContain(name);
        }
      }
    }
  });

  it('refuse a ref that could break out of the banner', () => {
    const [target] = TARGETS as Target[];
    for (const ref of ['v1.0.0 -->', 'v1\nx', '$(id)', '']) {
      expect(() => renderVendored(readSource('rcl'), target, 'rcl', ref)).toThrow();
    }
  });
});

describe('sync consumers', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const workflow = () => readFileSync(join(root, '.github/workflows/sync-skills.yml'), 'utf8');

  it('lists each consumer once, never rcl itself or allocator-one', () => {
    const repos = (readConsumers() as Array<{ repo: string }>).map(({ repo }) => repo);
    expect(new Set(repos).size).toBe(repos.length);
    expect(repos).not.toContain('allocator-one/rcl');
    expect(repos).not.toContain('allocator-one/allocator-one');
  });

  it('has no Infra One repository that vendors from the infraone fork (RCL-257)', () => {
    const file = readFileSync(join(root, 'skills/consumers.json'), 'utf8');
    const repos = (readConsumers() as Array<{ repo: string }>).map(({ repo }) => repo);
    for (const name of ['harness-cli', 'infra-one-ios', 'browser-extension', 'infraone-signal-capture', 'docs-infra-one']) {
      expect(repos, name).not.toContain(`allocator-one/${name}`);
      expect(workflow(), name).not.toContain(name);
    }
    expect(repos).toEqual([]);
    // the file says why and where those repositories get their skills now
    expect(JSON.parse(file).comment).toMatch(/infraone fork/);
    expect(JSON.parse(file).comment).toMatch(/harness-cli/);
  });

  it('accept an empty list and still validate the entries', () => {
    const write = (value: unknown) => { const path = join(mkdtempSync(join(tmpdir(), 'rcl-consumers-')), 'consumers.json'); writeFileSync(path, JSON.stringify(value)); return path; };
    expect(readConsumers(write({ consumers: [] }))).toEqual([]);
    expect(() => readConsumers(write({ consumers: 'x' }))).toThrow(/consumers array/);
    expect(() => readConsumers(write({ consumers: [{ repo: 'allocator-one/rcl', base: 'main' }] }))).toThrow(/own skills/);
    expect(() => readConsumers(write({ consumers: [{ repo: 'bad repo', base: 'main' }] }))).toThrow(/invalid consumer/);
    // the app token is minted for allocator-one only: a consumer under another owner could never be written
    expect(() => readConsumers(write({ consumers: [{ repo: 'someone-else/app', base: 'main' }] }))).toThrow(/outside the allocator-one organization/);
    expect(readConsumers(write({ consumers: [{ repo: 'allocator-one/outside-app', base: 'main' }] }))).toHaveLength(1);
    // GitHub names are case-insensitive: the owner check, the self check and the duplicate check agree
    expect(readConsumers(write({ consumers: [{ repo: 'Allocator-One/Outside-App', base: 'main' }] }))).toHaveLength(1);
    expect(() => readConsumers(write({ consumers: [{ repo: 'Allocator-One/RCL', base: 'main' }] }))).toThrow(/own skills/);
    expect(() => readConsumers(write({ consumers: [{ repo: 'allocator-one/a', base: 'main' }, { repo: 'Allocator-One/A', base: 'main' }] }))).toThrow(/duplicate/);
    expect(consumerRepositoryNames([{ repo: 'a/one', base: 'main' }, { repo: 'a/two', base: 'main' }])).toBe('one,two');
    expect(consumerRepositoryNames([])).toBe('');
  });

  it('is a clean no-op with no consumers: it says so and exits 0 before touching git, GitHub or the network', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/sync-skills.mjs', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', GH_TOKEN: '' } });
    const noop = run('--ref', 'v9.9.9');
    expect(noop.status, noop.stderr).toBe(0);
    expect(noop.stdout).toMatch(/no consumers configured/);
    const names = run('--print-repositories');
    expect(names.status, names.stderr).toBe(0);
    expect(names.stdout).toBe('\n');
    // naming a consumer that is not configured is still an error, never a silent no-op
    const unconfigured = run('--ref', 'v9.9.9', '--only', 'allocator-one/harness-cli');
    expect(unconfigured.status).toBe(1);
    expect(unconfigured.stderr).toMatch(/allocator-one\/harness-cli is not a configured consumer/);
  });

  it('derive the workflow token and sync from the consumer list, and skip both when it is empty', () => {
    const text = workflow();
    expect(text).toContain('repositories: ${{ steps.consumers.outputs.repositories }}');
    expect(text).not.toMatch(/^\s+repositories: [a-z]/m);
    expect(text).toMatch(/- name: Read consumers\n\s+id: consumers\n\s+run: \|\n\s+repos=\$\(node scripts\/sync-skills\.mjs --print-repositories\)/);
    // Both steps that need the app credentials run only with consumers.
    for (const step of ['Generate token', 'Sync consumers']) {
      const block = text.slice(text.indexOf(`- name: ${step}`));
      expect(block.slice(0, block.indexOf('\n      - ', 5) === -1 ? undefined : block.indexOf('\n      - ', 5)), step).toContain("if: steps.consumers.outputs.count != '0'");
    }
    expect(text.indexOf('name: Read consumers')).toBeLessThan(text.indexOf('name: Generate token'));
  });

  it('own exactly the directories of the files they write', () => {
    const dirs = new Set([...vendored().keys()].map((path) => path.slice(0, path.lastIndexOf('/'))));
    expect([...dirs].sort()).toEqual([...(ownedDirs() as string[])].sort());
  });
});

describe('the skill text is npm rcl\'s own (CLI-179 port)', () => {
  const rcl = () => readSource('rcl') as string;
  const converge = () => readSource('rcl-converge') as string;

  it('names no fork-only marker, command or feature', () => {
    for (const text of [rcl(), converge()]) {
      expect(text).not.toMatch(/infraone[- ]rcl/);
      expect(text).not.toMatch(/--code-view|code index|harness code|view_changed|@allocator-one\/infraone/i);
    }
    expect(converge()).toContain('<!-- rcl-converge-final:<TARGET>:<HEAD_SHA> -->');
  });

  it('keeps distinct names apart: a replaced or cut component, and the checkout path, are hashed (12 hex)', () => {
    for (const text of [rcl(), converge()]) {
      expect(text).toContain('first 12 hex characters of the SHA-256 of the absolute path of');
      expect(text).toMatch(/replaced or cut also ends in `-` and the first 12 hex characters of the SHA-256 of its original text/);
      expect(text).not.toContain('first 8 hex characters');
    }
  });

  it('never reclaims a stale lock itself, and says why', () => {
    const text = converge();
    expect(text).toContain('Never remove it yourself');
    expect(text).not.toContain('<lock>.reclaim');
    expect(text).toContain('the user removes it');
  });

  it('forwards only exported variables through the launch helper', () => {
    const text = rcl();
    expect(text).toContain('rcl_exported=$(export -p)');
    expect(text).toContain('only a variable that is exported, not a shell variable that merely has the name, is forwarded');
  });
});
