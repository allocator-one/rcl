import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM build script, no type declarations
import { readSource, render, renderVendored, renderAll, SKILLS, TARGETS } from '../../scripts/build-skills.mjs';
// @ts-expect-error -- plain ESM script, no type declarations
import { readConsumers, renderVendoredFiles, ownedDirs } from '../../scripts/sync-skills.mjs';

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
      expect(content, path).not.toContain("review-council's own source");
      expect(content, path).not.toContain('npm run build && npm link');
      expect(content, path).not.toContain('`npm run lint` (type-check) and `npm test` (vitest suite)');
      if (path.includes('/rcl-converge/')) expect(content, path).toContain("run this repository's required quality gates");
    }
    // …while this repository's own copies keep it.
    const own = new Map((renderAll() as Array<{ path: string; content: string }>).map(({ path, content }) => [path.replaceAll('\\', '/'), content]));
    for (const [path, content] of own) {
      if (path.endsWith('/rcl/SKILL.md')) expect(content, path).toContain("review-council's own source");
      if (path.includes('/rcl-converge/')) expect(content, path).not.toContain("run this repository's required quality gates");
    }
  });

  it('keep the review safeguards in every copy', () => {
    const copies: Array<[string, string]> = [...vendored()];
    for (const skill of SKILLS as string[]) {
      for (const target of TARGETS as Target[]) copies.push([`${target.dir}/${skill} (own)`, render(readSource(skill), target, skill)]);
    }
    for (const [path, content] of copies) {
      expect(content, path).toContain('untrusted data');
      expect(content, path).toContain('--no-ext-diff --no-textconv');
      if (path.includes('rcl-converge')) {
        expect(content, path).toContain('rcl_run <TOKEN_ARG> "$RCL_BIN" review <target> --guarded-converge');
        expect(content, path).toContain('`<TOKEN_ARG>` is `GITHUB_TOKEN="$(gh auth token)"`');
        expect(content, path).toContain('step 2a disclosure check');
      } else {
        expect(content, path).toContain('### 2a. Check what leaves the machine');
        expect(content, path).toContain('never pin a version');
        expect(content, path).toContain('npm install -g --ignore-scripts "review-council@<RCL_LATEST>"');
        expect(content, path).toContain('dist.integrity --registry https://registry.npmjs.org --proxy=null --https-proxy=null --strict-ssl=true --ca=null --cafile=null)" = "<RCL_INTEGRITY>"');
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
  it('lists each consumer once, never rcl itself or allocator-one', () => {
    const repos = (readConsumers() as Array<{ repo: string }>).map(({ repo }) => repo);
    expect(new Set(repos).size).toBe(repos.length);
    expect(repos).not.toContain('allocator-one/rcl');
    expect(repos).not.toContain('allocator-one/allocator-one');
  });

  it('match the repositories the sync workflow token can reach', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/sync-skills.yml', import.meta.url)), 'utf8');
    const listed = workflow.match(/^\s+repositories: (.+)$/m)?.[1].split(',').map((name) => name.trim()) ?? [];
    const repos = (readConsumers() as Array<{ repo: string }>).map(({ repo }) => repo.split('/')[1]);
    expect(listed.sort()).toEqual(repos.sort());
  });

  it('own exactly the directories of the files they write', () => {
    const dirs = new Set([...vendored().keys()].map((path) => path.slice(0, path.lastIndexOf('/'))));
    expect([...dirs].sort()).toEqual([...(ownedDirs() as string[])].sort());
  });
});
